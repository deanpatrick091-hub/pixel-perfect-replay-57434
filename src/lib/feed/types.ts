export interface WindowStats { volumeQuote: number; buys: number; sells: number; changePct: number | null }

export interface MarketSummary {
  id: string; chain: string; kind: "curve" | "amm"; address: string; mint: string; venue: string; quoteCcy: string;
  name: string | null; symbol: string | null; imageUri: string | null; launchedAt: number;
  status: "active" | "migrated" | "retired"; stage: "new" | "final_stretch" | "migrated";
  curveProgress: number | null; priceQuote: number | null; reserveQuote: number | null; reserveBase: number | null;
  totalSupply: number | null; circulatingSupply: number | null; liquidityQuote: number | null;
  liquidityUsd: number | null; liquidityAt: number | null; tradeFeed: "live" | "unavailable" | "unverified";
  quoteModel: string | null; stateUpdatedAt: number | null; migratedTo: string | null; migratedFrom: string | null;
  lastTradeAt: number | null; stats: Record<"5m" | "1h" | "6h" | "24h", WindowStats> | null;
}

export interface Trade {
  id: string; marketId: string; signature: string; side: "buy" | "sell"; baseQty: number; quoteQty: number;
  quoteCcy: string; priceQuote: number; sourceTs: number | null; receivedAt: number; trader: string | null;
}

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number; buys: number; sells: number }

export interface Reference { "SOL/USD": { price: number | null; updatedAt: number | null; source: string; fresh: boolean } }

export type FeedStatus = "checking" | "setup" | "connecting" | "connected" | "reconnecting" | "stale";

/** USD per quote unit; null when stale/unavailable. */
export function quoteUsd(ref: Reference | null, ccy: string): number | null {
  if (ccy !== "SOL" || !ref) return null;
  const r = ref["SOL/USD"];
  return r?.fresh && r.price ? r.price : null;
}

export function marketUsd(m: MarketSummary, ref: Reference | null) {
  const q = quoteUsd(ref, m.quoteCcy);
  const price = m.priceQuote != null && q ? m.priceQuote * q : null;
  return {
    priceUsd: price,
    mcapUsd: price != null && m.circulatingSupply ? price * m.circulatingSupply : null,
    fdvUsd: price != null && m.totalSupply ? price * m.totalSupply : null,
    liquidityUsd: m.liquidityUsd ?? (m.liquidityQuote != null && q ? m.liquidityQuote * q : null),
    volUsd: (w: keyof NonNullable<MarketSummary["stats"]>) => (m.stats && q ? m.stats[w].volumeQuote * q : null),
  };
}
