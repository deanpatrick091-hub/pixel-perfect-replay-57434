import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, marketId } from "../src/store.ts";
import { restoredMarket, restoreMarkets } from "../src/restore.ts";

const addr = "11111111111111111111111111111111";
const mint = "22222222222222222222222222222222";
const stamp = "2026-11-01T00:00:00.000Z";
const row = (overrides: Record<string, unknown> = {}) => ({
  id: marketId("solana", "curve", addr), chain: "solana", kind: "curve", address: addr, mint,
  venue: "pumpfun", quote_ccy: "SOL", status: "active", stage: "new", name: "Restored token", symbol: "RST",
  launched_at: stamp, updated_at: stamp, state_updated_at: stamp, trade_feed: "live", price_quote: "0.000001",
  reserve_quote: 30, reserve_base: 30_000_000, ...overrides,
});

test("restart recovery: no configured ingest endpoint means no network request", async () => {
  let calls = 0;
  const result = await restoreMarkets(new Store(), { url: null, secret: null, fetch: async () => { calls++; throw new Error("unexpected"); } });
  assert.deepEqual(result, { restored: 0, skipped: 0 }); assert.equal(calls, 0);
});

test("restart recovery: authenticated metadata restores existing chart identities without freshening quotes", async () => {
  const store = new Store(); const requests: Request[] = [];
  const result = await restoreMarkets(store, { url: "https://website.test/api/public/worker-ingest", secret: "test-secret", fetch: async (url, init) => {
    requests.push(new Request(url, init));
    return Response.json({ markets: [row()] });
  } });
  assert.deepEqual(result, { restored: 1, skipped: 0 });
  assert.equal(requests[0]!.method, "GET"); assert.equal(requests[0]!.headers.get("authorization"), "Bearer test-secret");
  const restored = store.markets.get(row().id)!;
  assert.equal(restored.stateUpdatedAt, Date.parse(stamp)); assert.equal(restored.tradeFeed, "unavailable");
  assert.equal(restored.priceQuote, 0.000001); assert.deepEqual(store.byMint.get(mint), [restored.id]);
  assert.equal(store.candles.size, 0, "no invented historical candles");
});

test("restart recovery: malformed identities and unsupported chains are rejected", () => {
  assert.equal(restoredMarket(row({ id: "wrong-market-id" })), null);
  assert.equal(restoredMarket(row({ chain: "ethereum" })), null);
  assert.equal(restoredMarket(row({ mint: "not-an-address" })), null);
  assert.equal(restoredMarket(row({ status: "unknown" })), null);
});

test("restart recovery: snapshots cannot overwrite a market already refreshed in memory", async () => {
  const store = new Store(); const fresh = restoredMarket(row())!;
  fresh.priceQuote = 7; fresh.stateUpdatedAt = 123456789; fresh.tradeFeed = "live";
  store.restoreMarket(fresh);
  const result = await restoreMarkets(store, { url: "https://website.test/ingest", secret: "test", fetch: async () => Response.json({ markets: [row(), row({ id: "invalid" })] }) });
  assert.deepEqual(result, { restored: 0, skipped: 2 }); assert.equal(store.markets.get(fresh.id)!.priceQuote, 7);
  assert.equal(store.markets.get(fresh.id)!.tradeFeed, "live");
});

test("restart recovery: non-OK and malformed snapshots fail explicitly", async () => {
  await assert.rejects(restoreMarkets(new Store(), { url: "https://website.test/ingest", secret: "test", fetch: async () => new Response("offline", { status: 503 }) }), /HTTP 503/);
  await assert.rejects(restoreMarkets(new Store(), { url: "https://website.test/ingest", secret: "test", fetch: async () => Response.json({}) }), /invalid snapshot/);
});

test("restart recovery: an unresponsive boot endpoint is bounded by a timeout", async () => {
  await assert.rejects(restoreMarkets(new Store(), { url: "https://website.test/ingest", secret: "test", timeoutMs: 5,
    fetch: async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))) }), /aborted/);
});

test("restart recovery: only a newly observed upstream swap restores a live feed", () => {
  const store = new Store(); const restored = restoredMarket(row())!; store.restoreMarket(restored);
  store.addSwap({ chain: "solana", venue: "pumpfun", mint, marketAddress: addr, signature: "new-real-source-event", eventIndex: 0, side: "buy",
    baseQty: 100, quoteQty: 0.001, baseDecimals: 6, quoteCcy: "SOL", sourceTs: null, receivedAt: Date.parse(stamp) + 1_000,
    trader: null, reserveQuoteAfter: 31, reserveBaseAfter: 29_000_000 });
  assert.equal(restored.tradeFeed, "live"); assert.equal(restored.stateUpdatedAt, Date.parse(stamp) + 1_000);
  assert.equal(store.tapes.get(restored.id)?.length, 1);
});
