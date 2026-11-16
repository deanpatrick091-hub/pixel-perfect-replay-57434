import type { Candle } from "@/lib/feed/types";

// Real bars are never dropped; only the newest bounded missing-interval slots are expanded.
export const MAX_GAP_SLOTS = 6_000;
export type ChartRow = Candle | { t: number };
export const isCandle = (row: ChartRow): row is Candle => "o" in row;

export type GapMode = "compact" | "time";

/**
 * Default "compact" view: only real traded intervals, side by side, each keeping its real timestamp.
 * `gaps` counts intervals with no loaded swaps compressed out (quiet only when coverage is complete) (disclosed in the UI); nothing is joined or invented.
 */
export function compactRows(candles: Candle[], intervalSec: number) {
  let gaps = 0;
  for (let i = 1; i < candles.length; i++) gaps += Math.max(0, Math.ceil((candles[i]!.t - candles[i - 1]!.t) / intervalSec) - 1);
  return { rows: candles.slice() as ChartRow[], omitted: 0, gaps };
}

export function seriesRows(candles: Candle[], intervalSec: number, mode: GapMode) {
  return mode === "compact" ? compactRows(candles, intervalSec) : { ...chartRows(candles, intervalSec), gaps: 0 };
}

/** Significant digits for price labels so adjacent axis ticks across the visible candles stay distinguishable. */
export function priceDigits(candles: Candle[]) {
  let hi = 0, lo = Infinity;
  for (const c of candles) { if (c.h > hi) hi = c.h; if (c.l > 0 && c.l < lo) lo = c.l; }
  if (!(hi > 0) || !Number.isFinite(lo)) return { sig: 4, minMove: 1e-12 };
  const span = hi - lo || hi * 1e-3;
  const step = span / 10; // ~10 axis ticks
  const sig = Math.min(9, Math.max(4, Math.ceil(Math.log10(hi / step)) + 1));
  const minMove = 10 ** (Math.floor(Math.log10(hi)) - sig + 1);
  return { sig, minMove };
}

/**
 * Bullish/bearish tone for a real candle. Close vs open decides whenever they differ. A one-price candle
 * (typically a single swap) has no body, so "close >= open" would paint every sparse sell green: instead use
 * the move from the previous real candle's close (lower = red, higher = green), even if the trade side disagrees
 * because history is incomplete; only with no previous close or an equal price does an all-sell bucket fall back to red. Colour only; no price is changed or invented.
 */
export function candleTone(c: Candle, prev: Candle | null): "up" | "down" {
  if (c.c !== c.o) return c.c > c.o ? "up" : "down";
  if (prev && c.c !== prev.c) return c.c > prev.c ? "up" : "down";
  if (c.sells > 0 && c.buys === 0) return "down";
  return "up";
}

export function chartRows(candles: Candle[], intervalSec: number) {
  const rows: ChartRow[] = [];
  let remaining = MAX_GAP_SLOTS, omitted = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    if (!c) continue;
    rows.push(c);
    const prev = candles[i - 1];
    if (!prev) continue;
    const missing = Math.max(0, Math.ceil((c.t - prev.t) / intervalSec) - 1);
    const take = Math.min(missing, remaining);
    for (let j = 1; j <= take; j++) rows.push({ t: c.t - j * intervalSec });
    remaining -= take;
    omitted += missing - take;
  }
  return { rows: rows.reverse(), omitted };
}

const equal = (a: ChartRow, b: ChartRow) => a.t === b.t && (isCandle(a) && isCandle(b)
  ? a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.v === b.v && a.buyVolume === b.buyVolume && a.sellVolume === b.sellVolume
  : !isCandle(a) && !isCandle(b));

export function rowTailFrom(prev: ChartRow[], next: ChartRow[]) {
  if (!prev.length || next.length < prev.length) return -1;
  for (let i = 0; i < prev.length - 1; i++) {
    const a = prev[i], b = next[i];
    if (!a || !b || !equal(a, b)) return -1;
  }
  const last = prev[prev.length - 1], replacement = next[prev.length - 1];
  return last && replacement && last.t === replacement.t ? prev.length - 1 : -1;
}