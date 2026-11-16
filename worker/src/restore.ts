import { marketId, type Market, type Store } from "./store.ts";

type Row = Record<string, unknown>;
const address = (v: unknown): v is string => typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null;
const text = (v: unknown) => typeof v === "string" ? v : null;
const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;

/** Restore identity/metadata only. A DB snapshot is never evidence of a currently live executable feed. */
export function restoredMarket(value: unknown): Market | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Row;
  if (r.chain !== "solana" || (r.kind !== "curve" && r.kind !== "amm") || !address(r.address) || !address(r.mint)) return null;
  if (r.id !== marketId(r.chain, r.kind, r.address) || typeof r.venue !== "string" || typeof r.quote_ccy !== "string") return null;
  if (r.status !== "active" && r.status !== "migrated" && r.status !== "retired") return null;
  if (r.stage !== "new" && r.stage !== "final_stretch" && r.stage !== "migrated") return null;
  return {
    id: r.id as string, chain: r.chain, kind: r.kind, address: r.address, mint: r.mint, venue: r.venue, quoteCcy: r.quote_ccy,
    name: text(r.name), symbol: text(r.symbol), imageUri: text(r.image_uri), launchedAt: date(r.launched_at) ?? date(r.updated_at) ?? 0,
    status: r.status, stage: r.stage, curveProgress: number(r.curve_progress), reserveQuote: number(r.reserve_quote), reserveBase: number(r.reserve_base), priceQuote: number(r.price_quote),
    totalSupply: number(r.total_supply), circulatingSupply: number(r.circulating_supply), liquidityUsd: number(r.liquidity_usd), liquidityAt: null,
    tradeFeed: "unavailable", quoteModel: text(r.quote_model), stateSource: text(r.state_source), stateUpdatedAt: date(r.state_updated_at),
    migratedTo: text(r.migrated_to), migratedFrom: text(r.migrated_from), lastTradeAt: null, launchSignature: null,
  };
}

/** Best-effort boot snapshot, using the same authenticated endpoint/secret as normal ingest. */
export async function restoreMarkets(store: Store, o: { url: string | null; secret: string | null; fetch?: typeof fetch; timeoutMs?: number }) {
  if (!o.url || !o.secret) return { restored: 0, skipped: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 5_000);
  try {
    const response = await (o.fetch ?? fetch)(o.url, { method: "GET", headers: { authorization: `Bearer ${o.secret}` }, signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`market restore HTTP ${response.status}`);
    const body = await response.json() as { markets?: unknown };
    if (!Array.isArray(body?.markets)) throw new Error("market restore returned an invalid snapshot");
    let restored = 0, skipped = 0;
    for (const row of body.markets.slice(0, 3_000)) {
      const m = restoredMarket(row);
      if (m && store.restoreMarket(m)) restored++; else skipped++;
    }
    return { restored, skipped };
  } finally { clearTimeout(timer); }
}
