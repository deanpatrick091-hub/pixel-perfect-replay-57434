import type { Candle } from "@/lib/feed/types";

// Real bars are never dropped; only the newest bounded missing-interval slots are expanded.
export const MAX_GAP_SLOTS = 6_000;
export type ChartRow = Candle | { t: number };
export const isCandle = (row: ChartRow): row is Candle => "o" in row;

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