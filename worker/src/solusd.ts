import { log } from "./log.ts";
import { tokenPairs, type DexPair } from "./dexscreener.ts";

// SOL/USD reference. Primary: CoinGecko simple price. Fallback: median of the deepest DEX Screener SOL/USDC|USDT pairs,
// accepted only when those pairs agree with each other and with a recent primary value. A single odd fallback value
// (observed live: 52.63 vs CoinGecko 71.19) must never alternate with the primary and swing every USD figure.
const WSOL = "So11111111111111111111111111111111111111112";
const STABLES = new Set(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]); // USDC, USDT
export const MIN_LIQ_USD = 1_000_000;
export const MAX_SPREAD = 0.02;       // fallback pairs must agree within 2%
export const MAX_JUMP = 0.05;         // and within 5% of the last primary value...
export const PRIMARY_MEMORY_MS = 15 * 60_000; // ...when one was seen this recently
export const KEEP_PRIMARY_MS = 120_000;       // a primary value this fresh is kept rather than replaced by the fallback
export const solUsd = { price: null as number | null, updatedAt: 0, source: "" };
let lastPrimary: { price: number; at: number } | null = null;
export const solUsdStats = { fallbackRejected: 0, lastRejected: null as string | null };

/** Median SOL/USD from the deepest stable-quoted SOL pairs, or null when they don't agree. */
export function consensusSolUsd(pairs: DexPair[]): number | null {
  const prices = pairs
    .filter((p) => p.baseToken?.address === WSOL && STABLES.has(p.quoteToken?.address) && (p.liquidity?.usd ?? 0) >= MIN_LIQ_USD)
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)).slice(0, 5)
    .map((p) => Number(p.priceUsd)).filter((v) => v > 0).sort((a, b) => a - b);
  if (prices.length < 2) return null;
  if (prices[prices.length - 1] / prices[0] - 1 > MAX_SPREAD) return null;
  const mid = prices.length >> 1;
  return prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
}

/** Decide whether a fallback value may replace the current reference. */
export function acceptFallback(value: number | null, primary: { price: number; at: number } | null, current: typeof solUsd, now: number): { ok: boolean; reason?: string } {
  if (value == null) return { ok: false, reason: "fallback pairs missing or disagree" };
  if (current.source === "coingecko" && now - current.updatedAt < KEEP_PRIMARY_MS) return { ok: false, reason: "primary still fresh" };
  if (primary && now - primary.at < PRIMARY_MEMORY_MS && Math.abs(value / primary.price - 1) > MAX_JUMP)
    return { ok: false, reason: `fallback ${value} deviates >${MAX_JUMP * 100}% from recent primary ${primary.price}` };
  return { ok: true };
}

async function refresh() {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    if (r.ok) {
      const j: any = await r.json();
      const p = Number(j?.solana?.usd);
      if (p > 0) { const at = Date.now(); lastPrimary = { price: p, at }; Object.assign(solUsd, { price: p, updatedAt: at, source: "coingecko" }); return; }
    }
  } catch {}
  const v = consensusSolUsd(await tokenPairs(WSOL));
  const d = acceptFallback(v, lastPrimary, solUsd, Date.now());
  if (d.ok) Object.assign(solUsd, { price: v, updatedAt: Date.now(), source: "dexscreener:median-sol-stable" });
  else if (d.reason !== "primary still fresh") { solUsdStats.fallbackRejected++; solUsdStats.lastRejected = d.reason ?? null; log("warn", "SOL/USD fallback rejected", { reason: d.reason }); }
}

export function startSolUsd() {
  refresh();
  setInterval(refresh, 30_000).unref();
}
export const solUsdFresh = () => solUsd.price != null && Date.now() - solUsd.updatedAt < 120_000;
