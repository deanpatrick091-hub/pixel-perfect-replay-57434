import { test } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { PUMP_PROGRAM, EVENT_AUTHORITY, bondingCurvePda, extractSwaps } from "../src/history/pumpEvents.ts";
import { createHistoryService, checkSupport } from "../src/history/service.ts";
import { RpcLimited } from "../src/history/rpc.ts";
import { marketId, type Market } from "../src/store.ts";

const mint = Keypair.generate().publicKey.toBase58();
const curve = bondingCurvePda(mint);
const user = Keypair.generate().publicKey.toBase58();

function eventData(opts: { mint?: string; sol: bigint; tok: bigint; buy: boolean }) {
  const b = Buffer.alloc(16 + 32 + 8 + 8 + 1 + 32 + 8 + 32);
  Buffer.from("e445a52e51cb9a1d", "hex").copy(b, 0);
  Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]).copy(b, 8);
  let o = 16;
  Buffer.from(bs58.decode(opts.mint ?? mint)).copy(b, o); o += 32;
  b.writeBigUInt64LE(opts.sol, o); o += 8; b.writeBigUInt64LE(opts.tok, o); o += 8;
  b[o] = opts.buy ? 1 : 0; o += 1;
  Buffer.from(bs58.decode(user)).copy(b, o); o += 32;
  b.writeBigInt64LE(0n, o); // rest (virtual/real reserves) zero
  return bs58.encode(b);
}

/** Pump buy/sell instruction (top level) emitting its TradeEvent via self-CPI at stack height 2. */
function tx(slot: number, blockTime: number, events: string[], o: { err?: unknown; decimals?: number; authority?: string; parentCurve?: boolean; stack?: number } = {}) {
  const keys = [user, PUMP_PROGRAM, curve, o.authority ?? EVENT_AUTHORITY, mint];
  return {
    slot, blockTime,
    transaction: { message: { accountKeys: keys, instructions: [{ programIdIndex: 1, accounts: o.parentCurve === false ? [0, 4] : [0, 2, 4], data: "" }] } },
    meta: { err: o.err ?? null, postTokenBalances: [{ mint, uiTokenAmount: { decimals: o.decimals ?? 6 } }], preTokenBalances: [],
      innerInstructions: [{ index: 0, instructions: events.map((d) => ({ programIdIndex: 1, accounts: [3], data: d, stackHeight: o.stack ?? 2 })) }] },
  };
}

const market = (over: Partial<Market> = {}): Market => ({
  id: marketId("solana", "curve", curve), chain: "solana", kind: "curve", address: curve, mint, venue: "pumpfun", quoteCcy: "SOL",
  name: null, symbol: null, imageUri: null, launchedAt: 0, status: "active", stage: "new", curveProgress: null, reserveQuote: null, reserveBase: null,
  priceQuote: null, totalSupply: null, circulatingSupply: null, liquidityUsd: null, liquidityAt: null, tradeFeed: "unavailable", quoteModel: null,
  stateSource: null, stateUpdatedAt: null, migratedTo: null, migratedFrom: null, lastTradeAt: null, launchSignature: null, ...over,
});

type Script = { sigs: any[][]; txs: Record<string, any>; fail?: (method: string, params: unknown[]) => Error | null };
function harness(script: Script) {
  let t = 1_000_000;
  const calls: string[] = [];
  const svc = createHistoryService({
    now: () => t, coolingDown: () => false,
    rpc: async <T,>(method: string, params: unknown[]): Promise<T> => {
      calls.push(method);
      const f = script.fail?.(method, params); if (f) throw f;
      if (method === "getSignaturesForAddress") return (script.sigs.shift() ?? []) as T;
      return (script.txs[params[0] as string] ?? null) as T;
    },
  });
  const m = market();
  const run = async (sec = 60) => { const s = svc.history(m, m.id, sec); await svc._inflight(m.id); return s; };
  const snap = (sec = 60) => svc.history(m, m.id, sec);
  return { svc, m, calls, run, snap, advance: (ms: number) => { t += ms; } };
}
const sig = (s: string, slot: number) => ({ signature: s, slot, err: null, blockTime: 1_700_000_000 });

test("same-slot transactions keep every swap, deduplicate, and order by RPC rank", async () => {
  // RPC returns newest first: B (newer) then A, both in slot 100 and the same second.
  const A = tx(100, 1_700_000_000, [eventData({ sol: 1_000_000_000n, tok: 1_000_000n, buy: true })]); // price 1 SOL per token
  const B = tx(100, 1_700_000_000, [eventData({ sol: 2_000_000_000n, tok: 1_000_000n, buy: true }), eventData({ sol: 500_000_000n, tok: 1_000_000n, buy: false })]);
  const h = harness({ sigs: [[sig("B", 100), sig("A", 100), sig("A", 100)]], txs: { A, B } });
  await h.run();
  const s = h.snap();
  assert.equal(s.swaps, 3);
  assert.equal(s.candles.length, 1);
  const c = s.candles[0];
  assert.equal(c.o, 1);   // A is older -> open
  assert.equal(c.c, 0.5);    // B's second event is last -> close
  assert.equal(c.h, 2);
  assert.equal(c.buys, 2); assert.equal(c.sells, 1);
  assert.equal(s.state, "ok");
});

test("partial progress then 429 keeps a coherent count and success time", async () => {
  const txs: Record<string, any> = {};
  const rows = Array.from({ length: 40 }, (_, i) => { const id = `S${i}`; txs[id] = tx(200 + i, 1_700_000_000 + i * 30, [eventData({ sol: 1_000_000n * BigInt(i + 1), tok: 1_000_000n, buy: true })]); return sig(id, 200 + i); }).reverse();
  let txCalls = 0;
  const h = harness({ sigs: [rows], txs, fail: (m) => (m === "getTransaction" && ++txCalls > 10 ? new RpcLimited(429) : null) });
  await h.run();
  const s = h.snap();
  assert.equal(s.state, "rate_limited");
  assert.equal(s.swaps, 10);
  assert.equal(s.candles.reduce((n, c) => n + c.buys + c.sells, 0), 10);
  assert.ok(s.lastSuccessAt, "successful timestamp kept");
  assert.equal(s.completedAt, null, "scan not complete");
  assert.equal(s.pendingTransactions, 30);
});

test("empty complete scan is reported as empty, not loading/unavailable", async () => {
  const h = harness({ sigs: [[]], txs: {} });
  await h.run();
  const s = h.snap();
  assert.equal(s.state, "empty");
  assert.equal(s.swaps, 0);
  assert.ok(s.completedAt);
});

test("null getTransaction is retried, not marked processed", async () => {
  const txs: Record<string, any> = {};
  const h = harness({ sigs: [[sig("X", 5)]], txs });
  await h.run();
  assert.equal(h.snap().state, "partial");
  txs.X = tx(5, 1_700_000_000, [eventData({ sol: 1_000_000n, tok: 1_000_000n, buy: false })]);
  h.advance(3_000);
  await h.run();
  const s = h.snap();
  assert.equal(s.swaps, 1);
  assert.equal(s.state, "ok");
});

test("busy curve: incremental scan paginates instead of skipping past a gap", async () => {
  const txs: Record<string, any> = {};
  const mk = (from: number, n: number) => Array.from({ length: n }, (_, i) => { const id = `T${from + i}`; txs[id] = tx(1000 + from + i, 1_700_000_000 + from + i, [eventData({ sol: 1_000_000n, tok: 1_000_000n, buy: true })]); return sig(id, 1000 + from + i); }).reverse();
  const first = mk(0, 100);
  const newer = mk(100, 250); // 250 new signatures arrive: 3 pages of 100/100/50
  const h = harness({ sigs: [first, newer.slice(0, 100), newer.slice(100, 200), newer.slice(200)], txs });
  for (let i = 0; i < 4; i++) { await h.run(); h.advance(3_000); }
  h.advance(25_000);
  for (let i = 0; i < 20; i++) { await h.run(); h.advance(3_000); }
  const s = h.snap(1);
  assert.equal(s.swaps, 350);
  assert.equal(s.state, "ok");
});

test("unsupported: migrated AMM pool, wrong PDA, unknown market", () => {
  const pool = market({ kind: "amm", venue: "pumpswap", id: marketId("solana", "amm", "Pool111"), address: "Pool111" });
  const r1 = checkSupport(pool, pool.id);
  assert.equal(r1.ok, false); assert.match((r1 as any).reason, /AMM pools isn't implemented/);
  const wrong = Keypair.generate().publicKey.toBase58();
  const bad = market({ address: wrong, id: marketId("solana", "curve", wrong) });
  const r2 = checkSupport(bad, bad.id);
  assert.equal(r2.ok, false); assert.match((r2 as any).reason, /derived address/);
  const r3 = checkSupport(undefined, "solana:curve:nope");
  assert.equal(r3.ok, false); assert.equal((r3 as any).state, "unknown_market");
  const old = market({ status: "migrated" });
  assert.deepEqual(checkSupport(old, old.id), { ok: true, curveStatus: "migrated" });
});

test("decoder rejects failed, unrelated and malformed events", () => {
  const good = eventData({ sol: 1_000_000n, tok: 1_000_000n, buy: true });
  assert.equal(extractSwaps(tx(1, 1, [good]), "s", curve, mint).swaps.length, 1);
  assert.equal(extractSwaps(tx(1, 1, [good], { err: { InstructionError: [0, "x"] } }), "s", curve, mint).swaps.length, 0);
  assert.equal(extractSwaps(tx(1, 1, [good], { decimals: 9 }), "s", curve, mint).swaps.length, 0);
  assert.equal(extractSwaps(tx(1, 1, [good], { authority: user }), "s", curve, mint).rejectedEvents, 1);
  assert.equal(extractSwaps(tx(1, 1, [good], { parentCurve: false }), "s", curve, mint).rejectedEvents, 1);
  assert.equal(extractSwaps(tx(1, 1, [good], { stack: 1 }), "s", curve, mint).rejectedEvents, 1);
  const other = Keypair.generate().publicKey.toBase58();
  assert.equal(extractSwaps(tx(1, 1, [eventData({ mint: other, sol: 1n, tok: 1n, buy: true })]), "s", curve, mint).rejectedEvents, 1);
  assert.equal(extractSwaps(tx(1, 1, [eventData({ sol: 0n, tok: 1_000_000n, buy: true })]), "s", curve, mint).rejectedEvents, 1);
  const truncated = bs58.encode(Buffer.from(bs58.decode(good)).subarray(0, 40));
  assert.equal(extractSwaps(tx(1, 1, [truncated]), "s", curve, mint).rejectedEvents, 1);
  assert.equal(extractSwaps(tx(1, 1, [good, good]), "s", curve, mint).swaps.length, 1, "byte-identical duplicate dropped");
  assert.equal(extractSwaps(tx(1, 1, [bs58.encode(Buffer.from("plain transfer"))]), "s", curve, mint).swaps.length, 0);
});

test("timeframes aggregate the same verified swaps", async () => {
  const txs: Record<string, any> = {};
  const rows = [0, 30, 70, 130, 400].map((dt, i) => { const id = `F${i}`; txs[id] = tx(10 + i, 1_700_000_100 + dt, [eventData({ sol: BigInt(1_000_000 * (5 - i)), tok: 1_000_000n, buy: false })]); return sig(id, 10 + i); }).reverse();
  const h = harness({ sigs: [rows], txs });
  await h.run();
  for (const [sec, n] of [[1, 5], [60, 4], [300, 2], [3600, 1]] as const) {
    const s = h.snap(sec);
    assert.equal(s.candles.length, n, `tf ${sec}`);
    assert.equal(s.swaps, 5);
  }
  // Genuine all-down sequence: every 1m candle is bearish or flat, none fabricated green.
  assert.ok(h.snap(60).candles.every((c) => c.c <= c.o));
});

test("a transaction-level RPC error is retried and does not block other swaps", async () => {
  const txs: Record<string, any> = { OK: tx(7, 1_700_000_000, [eventData({ sol: 1_000_000n, tok: 1_000_000n, buy: true })]) };
  const h = harness({ sigs: [[sig("BAD", 8), sig("OK", 7)]], txs, fail: (m, p) => (m === "getTransaction" && p[0] === "BAD" ? new Error("rpc error -32015") : null) });
  for (let i = 0; i < 6; i++) { await h.run(); h.advance(3_000); }
  const s = h.snap();
  assert.equal(s.swaps, 1);
  assert.equal(s.missingTransactions, 1);
  assert.equal(s.state, "ok");
});
