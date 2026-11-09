import { config } from "./config.ts";
import { log } from "./log.ts";
import { solUsd } from "./solusd.ts";
import type { Market, Store } from "./store.ts";

// Pushes executable state to the website's ingest endpoint (which writes the paper-trading DB).
export const ingestStats = { pushes: 0, failures: 0, lastOkAt: 0 as number, lastError: null as string | null };

const toRow = (m: Market) => ({
  id: m.id, chain: m.chain, kind: m.kind, address: m.address, mint: m.mint, venue: m.venue, quote_ccy: m.quoteCcy,
  name: m.name?.slice(0, 120) ?? null, symbol: m.symbol?.slice(0, 40) ?? null, image_uri: m.imageUri?.slice(0, 500) ?? null,
  launched_at: new Date(m.launchedAt).toISOString(), status: m.status, stage: m.stage, curve_progress: m.curveProgress,
  reserve_quote: m.reserveQuote, reserve_base: m.reserveBase, price_quote: m.priceQuote, total_supply: m.totalSupply,
  circulating_supply: m.circulatingSupply, liquidity_usd: m.liquidityUsd, trade_feed: m.tradeFeed, quote_model: m.quoteModel,
  state_source: m.stateSource, state_updated_at: m.stateUpdatedAt ? new Date(m.stateUpdatedAt).toISOString() : null,
  migrated_to: m.migratedTo, migrated_from: m.migratedFrom,
});

export async function push(store: Store, heartbeat?: Record<string, unknown>) {
  if (!config.ingestUrl || !config.ingestSecret) return;
  const ids = [...store.dirty].slice(0, 500);
  ids.forEach((i) => store.dirty.delete(i));
  const markets = ids.map((i) => store.markets.get(i)).filter((m): m is Market => !!m).map(toRow);
  const reference_prices = solUsd.price ? [{ pair: "SOL/USD", price: solUsd.price, source: solUsd.source, updated_at: new Date(solUsd.updatedAt).toISOString() }] : [];
  if (!markets.length && !heartbeat) return;
  try {
    const r = await fetch(config.ingestUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.ingestSecret}` },
      body: JSON.stringify({ markets, reference_prices, heartbeat }),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
    ingestStats.pushes++;
    ingestStats.lastOkAt = Date.now();
    ingestStats.lastError = null;
  } catch (e) {
    ingestStats.failures++;
    ingestStats.lastError = String(e);
    ids.forEach((i) => store.dirty.add(i)); // retry next tick
    log("error", "ingest push failed", { error: String(e) });
  }
}
