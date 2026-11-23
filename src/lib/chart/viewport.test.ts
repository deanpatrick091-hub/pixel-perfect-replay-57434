import { describe, expect, it } from "vitest";
import { BAR_SPACING, MAX_SPARSE_SPACING, MIN_BARS, RIGHT_OFFSET, fitRange, initialRange, preservedRange, tailUpdateFrom } from "./viewport";

const c = (t: number, close = 1, v = 1) => ({ t, o: 1, h: Math.max(1, close), l: Math.min(1, close), c: close, v, buys: 1, sells: 0 });

describe("chart viewport", () => {
  it("two sparse candles stay right-aligned and never stretch across desktop or mobile", () => {
    for (const width of [1100, 320, 280]) {
      const r = initialRange(2, width);
      const slots = r.to - r.from;
      expect(slots).toBeGreaterThanOrEqual(MIN_BARS);
      expect(width / slots).toBeLessThanOrEqual(MAX_SPARSE_SPACING + 0.5); // never a giant bar
      expect(r.to).toBe(1 + RIGHT_OFFSET);
    }
  });
  it("Fit shows all candles when there are many, but never stretches sparse data", () => {
    expect(fitRange(500, 1000)).toEqual({ from: -1, to: 499 + RIGHT_OFFSET });
    expect(fitRange(3, 1000)).toEqual(initialRange(3, 1000));
  });
  it("a trade in the latest interval updates only the tail; a new interval appends", () => {
    const prev = [c(60), c(120, 2)];
    expect(tailUpdateFrom(prev, [c(60), c(120, 3, 2)])).toBe(1);
    expect(tailUpdateFrom(prev, [c(60), c(120, 2), c(300, 1.5)])).toBe(1);
  });
  it("older backfilled candles or changed history replace the series", () => {
    const prev = [c(120), c(180)];
    expect(tailUpdateFrom(prev, [c(60), c(120), c(180)])).toBe(-1);
    expect(tailUpdateFrom(prev, [c(120, 5), c(180)])).toBe(-1);
    expect(tailUpdateFrom([], [c(60)])).toBe(-1);
  });
  it("a ~320px phone plot gets 6–8px bars, not the old 3.5px", () => {
    const r = initialRange(400, 320);
    const px = 320 / (r.to - r.from);
    expect(px).toBeGreaterThanOrEqual(6);
    expect(px).toBeLessThanOrEqual(8);
  });
  it("a few real candles on a wide plot open readable (wider than dense spacing) instead of a sliver at the right edge", () => {
    const r = initialRange(6, 904);
    const px = 904 / (r.to - r.from);
    expect(px).toBeGreaterThan(BAR_SPACING + 5);
    expect(px).toBeLessThanOrEqual(MAX_SPARSE_SPACING + 0.5);
    expect(r.to).toBe(5 + RIGHT_OFFSET);
  });
  it("a dense series on a wide plot keeps ~BAR_SPACING px bars", () => {
    const r = initialRange(500, 904);
    expect(904 / (r.to - r.from)).toBeCloseTo(BAR_SPACING, 0);
  });
  it("backfill prepending older rows keeps the same candles in view at the same spacing", () => {
    const prev = [{ t: 300 }, { t: 360 }, { t: 420 }];
    const next = [{ t: 60 }, { t: 120 }, { t: 300 }, { t: 360 }, { t: 420 }];
    expect(preservedRange(prev, next, { from: 0.5, to: 2.5 })).toEqual({ from: 2.5, to: 4.5 });
    expect(preservedRange(prev, [{ t: 360 }, { t: 420 }], { from: 0, to: 2 })).toBeNull();
  });
});
