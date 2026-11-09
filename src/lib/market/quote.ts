// Shared constant-product quote model (pump.fun bonding curve uses the same x*y=k form on virtual reserves).
// Used for UI previews and by the worker. Authoritative execution runs in the database (place_market_order).

export interface CpmmState {
  reserveQuote: number; // quote units (e.g. SOL); virtual reserves for curves
  reserveBase: number; // token units (decimals applied)
  quoteUsd: number; // USD per quote unit
  feeBps: number;
}

export interface BuyQuote {
  qty: number;
  feeUsd: number;
  execPriceUsd: number;
  spotPriceUsd: number;
  impactBps: number;
}

export interface SellQuote {
  grossUsd: number;
  netUsd: number;
  feeUsd: number;
  execPriceUsd: number;
  spotPriceUsd: number;
  impactBps: number;
}

export function spotPriceUsd(s: CpmmState): number {
  return (s.reserveQuote / s.reserveBase) * s.quoteUsd;
}

export function quoteBuy(s: CpmmState, usd: number): BuyQuote | null {
  if (!(usd > 0) || !(s.reserveQuote > 0) || !(s.reserveBase > 0) || !(s.quoteUsd > 0)) return null;
  const feeUsd = (usd * s.feeBps) / 10_000;
  const quoteIn = (usd - feeUsd) / s.quoteUsd;
  const k = s.reserveQuote * s.reserveBase;
  const qty = s.reserveBase - k / (s.reserveQuote + quoteIn);
  if (!(qty > 0)) return null;
  const execPriceUsd = (usd - feeUsd) / qty;
  const spot = spotPriceUsd(s);
  return { qty, feeUsd, execPriceUsd, spotPriceUsd: spot, impactBps: (execPriceUsd / spot - 1) * 10_000 };
}

export function quoteSell(s: CpmmState, qty: number): SellQuote | null {
  if (!(qty > 0) || !(s.reserveQuote > 0) || !(s.reserveBase > 0) || !(s.quoteUsd > 0)) return null;
  const k = s.reserveQuote * s.reserveBase;
  const quoteOut = s.reserveQuote - k / (s.reserveBase + qty);
  const grossUsd = quoteOut * s.quoteUsd;
  const feeUsd = (grossUsd * s.feeBps) / 10_000;
  const execPriceUsd = grossUsd / qty;
  const spot = spotPriceUsd(s);
  return {
    grossUsd,
    netUsd: grossUsd - feeUsd,
    feeUsd,
    execPriceUsd,
    spotPriceUsd: spot,
    impactBps: (execPriceUsd / spot - 1) * 10_000,
  };
}

// pump.fun bonding curve constants (6-decimal tokens, 1B total supply).
export const PUMP_CURVE = {
  TOTAL_SUPPLY: 1_000_000_000,
  INITIAL_VIRTUAL_TOKENS: 1_073_000_000,
  REAL_TOKENS_FOR_SALE: 793_100_000,
} as const;

/** Fraction of the curve sold (0..1), derived from virtual token reserves. */
export function pumpCurveProgress(virtualTokens: number): number {
  const sold = PUMP_CURVE.INITIAL_VIRTUAL_TOKENS - virtualTokens;
  return Math.min(1, Math.max(0, sold / PUMP_CURVE.REAL_TOKENS_FOR_SALE));
}

/** Paper position P&L helpers. Average entry excludes fees; fees tracked separately. */
export function unrealizedPnl(qty: number, costBasisUsd: number, markUsd: number): number {
  return qty * markUsd - costBasisUsd;
}
