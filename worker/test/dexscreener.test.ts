import { test } from "node:test";
import assert from "node:assert/strict";
import { createDexClient } from "../src/dexscreener.ts";

const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  ({ status, ok: status < 400, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, json: async () => body }) as unknown as Response;

test("a 429 starts one global cooldown honouring Retry-After: no request storm across pools", async () => {
  let t = 0, calls = 0;
  const c = createDexClient({ now: () => t, burst: 20, fetch: (async () => { calls++; return res(429, {}, { "retry-after": "40" }); }) as any });
  const pools = Array.from({ length: 8 }, (_, i) => `P${i}`);
  for (const p of pools) await c.getAt(`u/${p}`);
  assert.equal(calls, 1, "only the first request is sent; the rest wait out the cooldown");
  assert.equal(c.stats.skippedCooldown, 7); assert.equal(c.stats.lastRetryAfterSec, 40);
  t = 39_999; await c.getAt("u/x"); assert.equal(calls, 1);
  t = 40_000; await c.getAt("u/x"); assert.equal(calls, 2);
});

test("without Retry-After the cooldown backs off exponentially and resets after success", async () => {
  let t = 0, status = 429, calls = 0;
  const c = createDexClient({ now: () => t, burst: 50, ratePerMin: 6000, fetch: (async () => { calls++; return res(status, { ok: 1 }); }) as any });
  await c.getAt("a"); assert.equal(c.stats.cooldownUntil, 30_000);
  t = 30_000; await c.getAt("b"); assert.equal(c.stats.cooldownUntil, 90_000);
  t = 90_000; status = 200; await c.getAt("c"); t = 90_001; status = 429; await c.getAt("d");
  assert.equal(c.stats.cooldownUntil, 120_001);
});

test("continuous token bucket: burst then steady rate, never a fixed-window burst", async () => {
  let t = 0, calls = 0;
  const c = createDexClient({ now: () => t, burst: 3, ratePerMin: 60, fetch: (async () => { calls++; return res(200, {}); }) as any });
  for (let i = 0; i < 10; i++) await c.getAt(`k${i}`);
  assert.equal(calls, 3); assert.equal(c.stats.skippedBudget, 7);
  t = 1_000; await c.getAt("n1"); await c.getAt("n2"); assert.equal(calls, 4);
});

test("concurrent identical requests share one fetch; concurrency is bounded; stale cache keeps its real age", async () => {
  let t = 0, calls = 0; const wait: Array<() => void> = [];
  const c = createDexClient({ now: () => t, burst: 10, maxConcurrent: 2, fetch: (async () => { calls++; await new Promise<void>((r) => wait.push(r)); return res(200, { v: calls }); }) as any });
  const same = [c.getAt("x"), c.getAt("x"), c.getAt("x")];
  const other = [c.getAt("y"), c.getAt("z")];
  assert.equal(calls, 2); assert.equal(c.stats.deduped, 2); assert.equal(c.stats.skippedBusy, 1);
  wait.forEach((r) => r()); const [a, b] = await Promise.all(same); await Promise.all(other);
  assert.equal(a, b); assert.equal(a!.at, 0);
  // after TTL a failing refresh returns the old body with its original fetch time, never re-stamped as fresh
  let fail = false;
  const c2 = createDexClient({ now: () => t, burst: 10, fetch: (async () => (fail ? res(500) : res(200, { v: 1 }))) as any });
  await c2.getAt("x"); t = 60_000; fail = true;
  const stale = await c2.getAt("x"); assert.deepEqual(stale, { at: 0, data: { v: 1 } });
});

test("batched pool lookup: one request for up to 30 pools, each keeps the batch fetch time", async () => {
  let t = 5, calls = 0;
  const pools = Array.from({ length: 31 }, (_, i) => `Pool${i}`);
  const c = createDexClient({ now: () => t, burst: 10, fetch: (async (url: string) => { calls++; const ids = url.split("/").pop()!.split(","); return res(200, { pairs: ids.map((pairAddress) => ({ pairAddress })) }); }) as any });
  const got = await c.pairsAt(pools);
  assert.equal(calls, 2); assert.equal(got.size, 31); assert.equal(got.get("Pool0")!.at, 5);
  t = 6; await c.pairsAt(pools); assert.equal(calls, 2, "fresh per-pool cache, no refetch");
});

test("Retry-After: seconds and HTTP-date parsed; a long server value is never shortened", async () => {
  const { parseRetryAfter } = await import("../src/dexscreener.ts");
  const base = Date.parse("2026-11-16T20:00:00Z");
  assert.equal(parseRetryAfter("600", base), 600_000);
  assert.equal(parseRetryAfter("Mon, 16 Nov 2026 20:10:00 GMT", base), 600_000);
  assert.equal(parseRetryAfter("Mon, 16 Nov 2026 19:00:00 GMT", base), null);
  assert.equal(parseRetryAfter("soon", base), null); assert.equal(parseRetryAfter("-5", base), null); assert.equal(parseRetryAfter(null, base), null);
  for (const header of ["600", new Date(600_000).toUTCString()]) {
    let t = 0, calls = 0;
    const c = createDexClient({ now: () => t, fetch: (async () => { calls++; return res(429, {}, { "retry-after": header }); }) as any });
    await c.getAt("u/a");
    t = 300_001; await c.getAt("u/b"); assert.equal(calls, 1, `${header}: not retried at the 300s local cap`);
    t = 599_999; await c.getAt("u/b"); assert.equal(calls, 1);
    t = 600_000; await c.getAt("u/b"); assert.equal(calls, 2);
  }
});

const hang = (signal?: AbortSignal) => new Promise<never>((_, rej) => signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
test("a hung request or hung body read times out and releases its concurrency slot", async () => {
  let n = 0;
  const c = createDexClient({ timeoutMs: 20, maxConcurrent: 1, burst: 10, fetch: (async (_u: string, init: RequestInit) => {
    n++;
    if (n === 1) return hang(init.signal!);
    if (n === 2) return { ...res(200), json: () => hang(init.signal!) } as unknown as Response;
    return res(200, { ok: 1 });
  }) as any });
  assert.equal(await c.getAt("u/1"), null);
  assert.equal(await c.getAt("u/2"), null);
  const ok = await c.getAt("u/3");
  assert.deepEqual(ok?.data, { ok: 1 }, "slot was released after both timeouts");
  assert.equal(c.stats.timeouts, 2);
});
