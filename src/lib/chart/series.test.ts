import { describe, expect, it } from "vitest";
import { INTERVALS } from "@/lib/market/candles";
import { candleTone, chartRows, compactRows, isCandle, MAX_GAP_SLOTS, priceDigits, rowTailFrom } from "./series";
import { fmtPriceSig } from "@/lib/format";
import { initialRange } from "./viewport";

const bar = (t: number, c = 2, buyVolume = 3, sellVolume = 1) => ({ t, o: 1, h: Math.max(1, c), l: Math.min(1, c), c, v: buyVolume + sellVolume, buys: 1, sells: 1, buyVolume, sellVolume });

describe("chronological chart slots", () => {
  it("a quiet minute is whitespace only, with no invented price or volume", () => {
    const { rows, omitted } = chartRows([bar(60), bar(240)], 60);
    expect(rows.map((r) => r.t)).toEqual([60, 120, 180, 240]);
    expect(rows[1]).toEqual({ t: 120 });
    expect(rows[2]).toEqual({ t: 180 });
    expect(rows.filter(isCandle)).toHaveLength(2);
    expect(omitted).toBe(0);
    expect(initialRange(rows.length, 1000).to).toBe(8);
  });
  it("caps gap expansion for every timeframe without dropping any real candle", () => {
    for (const sec of Object.values(INTERVALS)) {
      const candles = [bar(sec), bar(sec * 100_000), bar(sec * 200_000)];
      const { rows, omitted } = chartRows(candles, sec);
      expect(rows).toHaveLength(MAX_GAP_SLOTS + 3);
      expect(omitted).toBe(199_997 - MAX_GAP_SLOTS);
      expect(rows.filter(isCandle)).toEqual(candles);
      expect(rows.every((r, i) => !i || r.t > (rows[i - 1]?.t ?? Infinity))).toBe(true);
    }
  });
  it("updates the active minute and appends next traded minute with intervening blanks", () => {
    const first = chartRows([bar(60), bar(120)], 60).rows;
    const changed = chartRows([bar(60), bar(120, 3)], 60).rows;
    expect(rowTailFrom(first, changed)).toBe(1);
    const next = chartRows([bar(60), bar(120, 3), bar(300)], 60).rows;
    expect(rowTailFrom(changed, next)).toBe(1);
    expect(next.slice(2)).toEqual([{ t: 180 }, { t: 240 }, bar(300)]);
    expect(rowTailFrom(next, chartRows([bar(60), bar(180), bar(300)], 60).rows)).toBe(-1);
  });
  it("a volume-pressure correction before the tail requires full replacement", () => {
    const first = [bar(60), bar(120)];
    expect(rowTailFrom(first, [bar(60, 2, 1, 3), bar(120)])).toBe(-1);
  });
});
describe("compact traded-interval view (default)", () => {
  it("shows only real candles side by side with their real timestamps and counts compressed gaps", () => {
    const candles = [bar(60), bar(240), bar(3600)];
    const { rows, gaps } = compactRows(candles, 60);
    expect(rows).toEqual(candles);
    expect(gaps).toBe(2 + 55);
  });
  it("1s with 39 sparse swaps shows all 39 bars in the default view, not 90 blank seconds", () => {
    const candles = Array.from({ length: 39 }, (_, i) => bar(1_000 + i * 180));
    const { rows } = compactRows(candles, 1);
    const r = initialRange(rows.length, 390);
    expect(rows.every(isCandle)).toBe(true);
    expect(r.from).toBeLessThanOrEqual(0);
    expect(r.to).toBe(38 + 5);
  });
  it("never joins opens to previous closes", () => {
    const a = { ...bar(60, 2), o: 1.5 }, b = { ...bar(120, 3), o: 1 };
    expect(compactRows([a, b], 60).rows[1]).toEqual(b);
  });
});

describe("adaptive price precision", () => {
  it("tightly ranged sub-cent prices get enough digits for distinct axis labels", () => {
    const p = (c: number) => ({ ...bar(60, c), o: c, h: c, l: c });
    const { sig, minMove } = priceDigits([p(0.0000535561), p(0.0000535999)]);
    const labels = Array.from({ length: 10 }, (_, i) => fmtPriceSig(0.0000535561 + i * 0.0000000044, sig));
    expect(new Set(labels).size).toBe(10);
    expect(minMove).toBeLessThan(0.0000000044);
  });
  it("formats subscript notation with the requested significant digits", () => {
    expect(fmtPriceSig(0.0000535561, 6)).toBe("0.0\u2084535561");
    expect(fmtPriceSig(0.012345, 4)).toBe("0.01235");
  });
});

describe("candle direction (real Moonvale single-swap minutes, 16 Nov 17:28–17:43 UTC)", () => {
  const one = (t: number, p: number, side: "buy" | "sell") => ({ t, o: p, h: p, l: p, c: p, v: 0.01, buys: side === "buy" ? 1 : 0, sells: side === "sell" ? 1 : 0 });
  it("a single verified sell that lowered the price is bearish, not green", () => {
    const buy = one(1_700_000_000, 3.590936743e-6, "buy"), sell = one(1_700_000_180, 3.556225092e-6, "sell");
    expect(candleTone(buy, null)).toBe("up");
    expect(candleTone(sell, buy)).toBe("down");
  });
  it("close vs open decides when they differ, regardless of trade counts", () => {
    expect(candleTone({ ...bar(60, 0.5), buys: 5, sells: 0 }, null)).toBe("down");
    expect(candleTone(bar(60, 2), null)).toBe("up");
  });
  it("mixed one-price bucket falls back to the move from the previous real close", () => {
    const prev = one(0, 2, "buy"), mixed = { ...one(60, 1.5, "buy"), sells: 1 };
    expect(candleTone(mixed, prev)).toBe("down");
  });
});
