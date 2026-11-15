import { describe, expect, it } from "vitest";
import { INTERVALS } from "@/lib/market/candles";
import { chartRows, isCandle, MAX_GAP_SLOTS, rowTailFrom } from "./series";
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