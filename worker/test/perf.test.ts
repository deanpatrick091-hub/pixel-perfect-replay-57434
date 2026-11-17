import { test } from "node:test";
import assert from "node:assert/strict";
import { createRpc } from "../src/history/rpc.ts";
import { BACKFILL_TX_PER_REFRESH } from "../src/history/service.ts";
import { eventData, harness, sig, tx } from "./helpers.ts";

const body = (result: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers });

test("rpc: provider says getTransaction allowance is 0 -> only that method is held, no 429, others proceed", async () => {
  const sent: string[] = [];
  const c = createRpc({ url: "x", maxRps: 1000, fetch: (async (_u: string, i: any) => {
    const m = JSON.parse(i.body).method; sent.push(m);
    return body(1, m === "getTransaction" ? { "x-ratelimit-method-limit": "10", "x-ratelimit-method-remaining": "0" } : {});
  }) as any });
  await c.rpc("getTransaction", ["a"]);
  const held = c.rpc("getTransaction", ["b"], 0);
  let heldDone = false; held.then(() => { heldDone = true; });
  await c.rpc("getSignaturesForAddress", ["pool"]);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(sent, ["getTransaction", "getSignaturesForAddress"], "scan was not blocked behind the held method");
  assert.equal(heldDone, false, "second getTransaction waits for the provider window");
  assert.equal(c.stats.limited, 0); assert.equal(c.coolingDown(), false);
  assert.equal(c.stats.methodLimits.getTransaction, 10);
  assert.equal(c.stats.methodHolds, 1);
});

test("rpc: 429 cooldown is never shorter than the provider's Retry-After", async () => {
  const c = createRpc({ url: "x", maxRps: 1000, fetch: (async () => new Response("", { status: 429, headers: { "retry-after": "10" } })) as any });
  await assert.rejects(c.rpc("getTransaction", ["a"]));
  assert.ok(c.cooldownUntil() - Date.now() >= 9_900, "waits the full 10s instead of the 5s default");
});

test("rpc: identical concurrent calls share one HTTP request", async () => {
  let n = 0;
  const c = createRpc({ url: "x", maxRps: 1000, fetch: (async () => { n++; await new Promise((r) => setTimeout(r, 5)); return body("tx"); }) as any });
  const [a, b] = await Promise.all([c.rpc("getTransaction", ["S"], 0), c.rpc("getTransaction", ["S"], 2)]);
  assert.equal(a, "tx"); assert.equal(b, "tx"); assert.equal(n, 1); assert.equal(c.stats.deduped, 1);
  await c.rpc("getTransaction", ["S"]);
  assert.equal(n, 2, "only in-flight calls are shared, never cached results");
});

test("service: one round decodes the newest window first and only a bounded slice of older backfill", async () => {
  const txs: Record<string, any> = {};
  let k = 0;
  const page = () => Array.from({ length: 100 }, () => { const i = k++; const id = `P${i}`; txs[id] = tx(900_000 - i, 1_700_000_000 - i, [eventData({ sol: 1_000_000n, tok: 1_000_000n, buy: true })]); return { ...sig(id, 900_000 - i), blockTime: 1_700_000_000 - i }; });
  const h = harness({ sigs: [page()], older: [page(), page()], txs });
  // Drain the newest window, then measure a single round once backfill rows are listed.
  for (let i = 0; i < 6 && h.snap().swaps < 100; i++) { await h.run(); h.advance(2_000); }
  assert.equal(h.snap().swaps, 100);
  await h.run(); h.advance(2_000);
  h.prios.length = 0;
  await h.run();
  const older = h.prios.filter(([m, p]) => m.startsWith("P") && p === 2).length;
  assert.ok(older > 0 && older <= BACKFILL_TX_PER_REFRESH * 4, `backfill per kick bounded (got ${older})`); // MAX_AGAIN rounds at most
});
