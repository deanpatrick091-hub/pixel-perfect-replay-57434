import { test } from "node:test";
import assert from "node:assert/strict";
import { createRpc, RpcBusy, RpcForbidden, RpcLimited, RpcTransport } from "../src/history/rpc.ts";
import { createLiveLogs } from "../src/history/liveLogs.ts";
import { BACKFILL_MAX_SIGS } from "../src/history/service.ts";
import { eventData, harness, sig, tx } from "./helpers.ts";

const okBody = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });

test("rpc: priority queue serves live before backfill and leaves no waiters behind", async () => {
  const order: string[] = [];
  const c = createRpc({ url: "x", maxRps: 1000, maxConcurrent: 1, fetch: (async (_u: string, i: any) => { order.push(JSON.parse(i.body).method); return okBody(1); }) as any });
  const all = [c.rpc("backfill", [], 2), c.rpc("recent", [], 1), c.rpc("live", [], 0)];
  await Promise.all(all);
  assert.deepEqual(order, ["backfill", "live", "recent"], "first request starts immediately; then highest priority");
  for (let i = 0; i < 50; i++) await c.rpc("m", []);
  assert.equal(c.queueLength(), 0);
  assert.equal(c.stats.queued, 0);
});

test("rpc: bounded queue rejects instead of growing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const c = createRpc({ url: "x", maxRps: 1000, maxConcurrent: 1, maxQueue: 3, fetch: (async () => { await gate; return okBody(1); }) as any });
  const held = [c.rpc("a", []), c.rpc("b", []), c.rpc("c", []), c.rpc("d", [])];
  await assert.rejects(c.rpc("e", []), RpcBusy);
  assert.equal(c.stats.rejectedBusy, 1);
  release();
  await Promise.all(held);
});

test("rpc: a timeout is retried once, then reported as transport (not rate limit)", async () => {
  let n = 0;
  const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const c = createRpc({ url: "x", maxRps: 1000, retryDelayMs: 1, fetch: (async () => { n++; if (n === 1) throw timeout(); return okBody("fine"); }) as any });
  assert.equal(await c.rpc("getTransaction", []), "fine");
  assert.equal(c.stats.retried, 1);
  const d = createRpc({ url: "x", maxRps: 1000, retryDelayMs: 1, fetch: (async () => { throw timeout(); }) as any });
  await assert.rejects(d.rpc("getTransaction", []), (e: unknown) => e instanceof RpcTransport && e.kind === "timeout");
  assert.equal(d.stats.timeouts, 2);
  assert.equal(d.coolingDown(), false, "timeouts never trigger the rate-limit cooldown");
});

test("rpc: 429 and 403 back off globally with distinct errors and are not retried", async () => {
  let n = 0;
  const lim = createRpc({ url: "x", maxRps: 1000, fetch: (async () => { n++; return new Response("", { status: 429 }); }) as any });
  await assert.rejects(lim.rpc("m", []), RpcLimited);
  assert.equal(n, 1);
  assert.ok(lim.coolingDown());
  await assert.rejects(lim.rpc("m", []), RpcLimited);
  assert.equal(n, 1, "no request sent during cooldown");
  const fb = createRpc({ url: "x", maxRps: 1000, fetch: (async () => new Response("", { status: 403 })) as any });
  await assert.rejects(fb.rpc("m", []), RpcForbidden);
  assert.equal(fb.stats.cooldownReason, "forbidden");
  assert.ok(fb.cooldownUntil() - Date.now() >= 59_000, "403 backs off for at least a minute");
});

test("backfill: seeds newest window, then pages older history within the signature limit", async () => {
  const txs: Record<string, any> = {};
  let n = 0;
  const page = (k: number) => Array.from({ length: k }, () => { const i = n++; const id = `B${i}`; txs[id] = tx(1_000_000 - i, 1_700_000_000 - i, [eventData({ sol: 1_000_000n, tok: 1_000_000n, buy: i % 2 === 0 })]); return { ...sig(id, 1_000_000 - i), blockTime: 1_700_000_000 - i }; });
  const first = page(100);
  const older = Array.from({ length: 12 }, () => page(100));
  const h = harness({ sigs: [first], older, txs });
  await h.run();
  const s1 = h.snap();
  assert.equal(s1.backfill!.state, "in_progress");
  assert.ok(s1.swaps > 0, "chart seeded from the newest swaps first");
  assert.ok(h.prios.filter(([m]) => m.startsWith("B")).slice(0, 5).every(([m]) => Number(m.slice(1)) < 100), "newest decoded first");
  for (let i = 0; i < 120; i++) { await h.run(); h.advance(2_000); }
  const s = h.snap(1);
  assert.equal(s.backfill!.state, "done_limit");
  assert.equal(s.backfill!.listedSignatures, BACKFILL_MAX_SIGS);
  assert.equal(s.swaps, BACKFILL_MAX_SIGS, "exactly the listed window, nothing past the limit");
  assert.equal(s.state, "ok");
  assert.equal(s.oldestTs, 1_700_000_000 - (BACKFILL_MAX_SIGS - 1));
});

test("backfill: stops at the age floor and at curve creation", async () => {
  const txs: Record<string, any> = {};
  const mk = (from: number, k: number, dt: number) => Array.from({ length: k }, (_, j) => { const i = from + j; const id = `A${i}`; txs[id] = tx(9_000_000 - i, 1_700_000_000 - i * dt, [eventData({ sol: 1_000_000n, tok: 1_000_000n, buy: true })]); return { ...sig(id, 9_000_000 - i), blockTime: 1_700_000_000 - i * dt }; });
  const h = harness({ sigs: [mk(0, 100, 30)], older: [mk(100, 100, 30)], txs }); // 30s apart: floor (3600s) reached at i=120
  for (let i = 0; i < 40; i++) { await h.run(); h.advance(2_000); }
  const s = h.snap();
  assert.equal(s.backfill!.state, "done_age");
  assert.ok(s.oldestTs! >= 1_700_000_000 - 3_600);
  const h2 = harness({ sigs: [mk(500, 100, 1)], older: [mk(600, 20, 1)], txs });
  for (let i = 0; i < 40; i++) { await h2.run(); h2.advance(2_000); }
  assert.equal(h2.snap().backfill!.state, "done_start");
  assert.equal(h2.snap().swaps, 120);
});

test("live hint is decoded before backfill and deduplicated against the later signature listing", async () => {
  const txs: Record<string, any> = {};
  const rows = Array.from({ length: 100 }, (_, i) => { const id = `H${i}`; txs[id] = tx(500 - i, 1_700_000_000 - i, [eventData({ sol: 1_000_000n, tok: 1_000_000n, buy: true })]); return sig(id, 500 - i); });
  const older = [Array.from({ length: 100 }, (_, i) => { const id = `O${i}`; txs[id] = tx(300 - i, 1_699_999_000 - i, [eventData({ sol: 1_000_000n, tok: 1_000_000n, buy: false })]); return sig(id, 300 - i); })];
  const h = harness({ sigs: [rows], older, txs });
  await h.run();
  txs.LIVE = tx(600, 1_700_000_100, [eventData({ sol: 5_000_000n, tok: 1_000_000n, buy: true })]);
  h.prios.length = 0;
  h.svc.hint({ curve: h.m.address, signature: "LIVE", slot: 600, receivedAt: h.now() });
  await h.svc._inflight(h.m.id);
  assert.deepEqual(h.prios[0], ["LIVE", 0], "live hint fetched first at live priority");
  const before = h.snap().swaps;
  const s0 = h.snap();
  assert.equal(s0.live!.swaps, 1);
  assert.ok(s0.live!.hintToChartMs != null);
  // The next signature listing returns the same signature (with its transactionIndex): no duplicate swap, no refetch.
  h.sigs.push([{ ...sig("LIVE", 600), transactionIndex: 3 }]);
  h.advance(20_000);
  const fetchedBefore = h.prios.filter(([m]) => m === "LIVE").length;
  await h.run();
  const after = h.snap();
  assert.ok(after.swaps >= before);
  assert.equal(after.swaps, after.scannedTransactions, "one swap per decoded transaction: the live swap was not duplicated");
  assert.equal(h.prios.filter(([m]) => m === "LIVE").length, fetchedBefore, "listed live signature not fetched again");
});

test("live hint whose transaction isn't available yet is retried, not dropped", async () => {
  const txs: Record<string, any> = {};
  const h = harness({ sigs: [[]], txs });
  await h.run();
  h.svc.hint({ curve: h.m.address, signature: "SOON", slot: 7, receivedAt: h.now() });
  await h.svc._inflight(h.m.id);
  assert.equal(h.snap().swaps, 0);
  assert.equal(h.snap().state, "partial");
  txs.SOON = { ...tx(7, 1_700_000_000, [eventData({ sol: 1_000_000n, tok: 1_000_000n, buy: true })]) };
  h.advance(1_500);
  await h.run();
  assert.equal(h.snap().swaps, 1);
});

test("transaction with no block time yet is retried, not counted as failed", async () => {
  const txs: Record<string, any> = { N: { ...tx(3, 0, [eventData({ sol: 1n, tok: 1n, buy: true })]), blockTime: null } };
  const h = harness({ sigs: [[sig("N", 3)]], txs });
  await h.run();
  assert.equal(h.snap().failedTransactions, 0);
  txs.N = tx(3, 1_700_000_000, [eventData({ sol: 1_000_000n, tok: 1_000_000n, buy: true })]);
  h.advance(1_500);
  await h.run();
  assert.equal(h.snap().swaps, 1);
});

test("per-trade OHLCV: a trade in the same interval updates that candle; a new candle only on the next traded interval", async () => {
  const txs: Record<string, any> = {};
  const h = harness({ sigs: [[]], txs });
  await h.run();
  const add = async (id: string, slot: number, ts: number, solLamports: bigint) => {
    txs[id] = tx(slot, ts, [eventData({ sol: solLamports, tok: 1_000_000n, buy: true })]);
    h.svc.hint({ curve: h.m.address, signature: id, slot, receivedAt: h.now() });
    await h.svc._inflight(h.m.id);
    h.advance(100);
  };
  const t0 = 1_700_000_040; // 40s into a minute
  await add("P1", 1, t0, 1_000_000n);
  assert.equal(h.snap(60).candles.length, 1);
  await add("P2", 2, t0 + 10, 3_000_000n);
  await add("P3", 3, t0 + 15, 2_000_000n);
  let c = h.snap(60).candles;
  assert.equal(c.length, 1, "same minute: no new candle");
  assert.deepEqual([c[0].o, c[0].h, c[0].l, c[0].c], [0.001, 0.003, 0.001, 0.002]);
  assert.ok(Math.abs(c[0].v - 0.006) < 1e-12);
  await add("P4", 4, t0 + 200, 1_500_000n); // 3 minutes later
  c = h.snap(60).candles;
  assert.equal(c.length, 2, "quiet minutes are not filled with fake candles");
  assert.equal(c[1].o, 0.0015);
  assert.equal(h.snap(3600).candles.length, 1);
  assert.equal(h.snap(1).candles.length, 4);
});

// ---- logsSubscribe manager ----
function fakeSocket() {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const sent: any[] = [];
  const s = { readyState: 1, sent, send: (d: string) => sent.push(JSON.parse(d)), close: () => emit("close"), on: (ev: string, fn: any) => { (handlers[ev] ??= []).push(fn); } };
  const emit = (ev: string, ...a: any[]) => (handlers[ev] ?? []).forEach((f) => f(...a));
  return { s, emit };
}

test("logsSubscribe: failed transactions are excluded, reconnect resubscribes and triggers catch-up", async () => {
  const socks: ReturnType<typeof fakeSocket>[] = [];
  const hints: string[] = []; const caught: string[][] = [];
  const live = createLiveLogs({ url: "wss://x", maxSubs: 2, pingMs: 1_000_000, onHint: (h) => hints.push(h.signature), onReconnect: (c) => caught.push(c), connect: () => { const f = fakeSocket(); socks.push(f); return f.s; } });
  live.setWanted(["CurveA", "CurveB", "CurveC"]);
  const a = socks[0];
  a.emit("open");
  assert.equal(a.s.sent.length, 2, "capped at maxSubs");
  assert.deepEqual(a.s.sent[0].params[0], { mentions: ["CurveA"] });
  a.emit("message", JSON.stringify({ id: a.s.sent[0].id, result: 11 }));
  assert.equal(live.state("CurveA"), "streaming");
  assert.equal(live.state("CurveB"), "subscribing");
  const note = (sub: number, signature: string, err: unknown) => JSON.stringify({ method: "logsNotification", params: { subscription: sub, result: { context: { slot: 5 }, value: { signature, err, logs: [] } } } });
  a.emit("message", note(11, "good", null));
  a.emit("message", note(11, "bad", { InstructionError: [0, "x"] }));
  assert.deepEqual(hints, ["good"]);
  assert.equal(live.stats.failedExcluded, 1);
  a.emit("close");
  assert.equal(live.state("CurveA"), "reconnecting");
  await new Promise((r) => setTimeout(r, 1_100));
  const b = socks[1];
  assert.ok(b, "reconnected after backoff");
  b.emit("open");
  assert.equal(b.s.sent.length, 2, "resubscribed");
  assert.deepEqual(caught, [["CurveA", "CurveB"]]);
  live.setWanted([]);
  live.stop();
});
