import { describe, expect, it } from "vitest";
import { BAR_SPACING, MIN_BARS, RIGHT_OFFSET, fitRange, initialRange, tailUpdateFrom } from "./viewport";

const c = (t: number, close = 1, v = 1) => ({ t, o: 1, h: Math.max(1, close), l: Math.min(1, close), c: close, v, buys: 1, sells: 0 });

describe("chart viewport", () => {
  it("two sparse candles stay narrow and right-aligned on desktop and mobile", () => {
    for (const width of [1100, 360]) {
      const r = initialRange(2, width);
      const slots = r.to - r.from;
      expect(slots).toBeGreaterThanOrEqual(MIN_BARS);
      expect(width / slots).toBeLessThanOrEqual(BAR_SPACING + 0.5); // never a giant bar
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
});
