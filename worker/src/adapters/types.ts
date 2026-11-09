// Adapter contract for launchpads / DEX feeds. Each protocol keeps its own decoding,
// curve-progress, migration and quote logic; the store only sees normalised events.

export interface NormalisedLaunch {
  chain: string;
  venue: string;
  marketKind: "curve" | "amm";
  marketAddress: string; // bonding curve or pool address
  mint: string;
  name: string | null;
  symbol: string | null;
  imageUri: string | null;
  quoteCcy: string;
  reserveQuote: number | null;
  reserveBase: number | null;
  totalSupply: number | null;
  circulatingSupply: number | null;
  curveProgress: number | null;
  receivedAt: number;
  signature: string | null;
}

export interface NormalisedSwap {
  chain: string;
  venue: string;
  marketAddress: string | null; // null when the event does not name the market (resolved by mint)
  mint: string;
  signature: string;
  eventIndex: number | null; // instruction/event index when the source exposes it
  side: "buy" | "sell";
  baseQty: number;
  quoteQty: number;
  baseDecimals: number;
  quoteCcy: string;
  reserveQuoteAfter: number | null;
  reserveBaseAfter: number | null;
  sourceTs: number | null; // ms; null when the feed does not provide block time
  receivedAt: number;
  trader: string | null;
}

export interface NormalisedMigration {
  chain: string;
  fromVenue: string;
  mint: string;
  signature: string | null;
  destinationHint: string | null; // e.g. "pump-amm"
  receivedAt: number;
}

export interface AdapterHandlers {
  onLaunch(l: NormalisedLaunch): void;
  onSwap(s: NormalisedSwap): void;
  onMigration(m: NormalisedMigration): void;
  onStatus(s: { connected: boolean; reason?: string }): void;
}

export interface MarketAdapter {
  id: string;
  start(h: AdapterHandlers): void;
  subscribeTrades(mints: string[]): void;
  unsubscribeTrades(mints: string[]): void;
  stats(): Record<string, unknown>;
}
