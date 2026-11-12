import type { Candle } from "@/lib/feed/types";

// Chart viewport rules (pure, tested). Sparse data must never stretch 1–2 candles across the screen.
export const BAR_SPACING = 7;   // px per bar at the default zoom
export const MIN_BARS = 90;     // the initial / "Fit" view always spans at least this many bar slots
export const RIGHT_OFFSET = 5;  // empty bar slots kept right of the latest candle

/** Logical range showing the newest candles right-aligned at ~BAR_SPACING px, never fewer than MIN_BARS slots. */
export function initialRange(n: number, widthPx: number) {
  const slots = Math.max(MIN_BARS, Math.floor(Math.max(0, widthPx) / BAR_SPACING));
  const to = n - 1 + RIGHT_OFFSET;
  return { from: to - slots, to };
}

/** "Fit": show everything, but sparse series keep the narrow right-aligned layout. */
export function fitRange(n: number, widthPx: number) {
  const r = initialRange(n, widthPx);
  return n + RIGHT_OFFSET > r.to - r.from ? { from: -1, to: n - 1 + RIGHT_OFFSET } : r;
}

const same = (a: Candle, b: Candle) => a.t === b.t && a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.v === b.v;

/**
 * Index from which `next` can be applied with per-bar updates (live trade changed the last candle or added newer ones),
 * or -1 when the series must be replaced (backfill added older candles, or anything before the tail changed).
 */
export function tailUpdateFrom(prev: Candle[], next: Candle[]): number {
  if (!prev.length || next.length < prev.length) return -1;
  for (let i = 0; i < prev.length - 1; i++) if (!same(prev[i]!, next[i]!)) return -1;
  if (next[prev.length - 1]!.t !== prev[prev.length - 1]!.t) return -1;
  return prev.length - 1;
}
