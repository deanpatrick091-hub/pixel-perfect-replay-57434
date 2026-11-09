import { describe, expect, it } from "vitest";
import { quoteBuy, quoteSell, pumpCurveProgress, PUMP_CURVE } from "./quote";
import { CandleBuilder } from "./candles";

const state = { reserveQuote: 30, reserveBase: 1_073_000_000, quoteUsd: 150, feeBps: 100 };

describe("quote model", () => {
  it("buy deducts a 1% simulated fee and returns tokens below spot", () => {
    const q = quoteBuy(state, 100)!;
    expect(q.feeUsd).toBeCloseTo(1, 10);
    expect(q.execPriceUsd).toBeGreaterThan(q.spotPriceUsd);
    // Constant product: (30 + 0.66) * (1.073e9 - qty) = 30 * 1.073e9
    expect((30 + 99 / 150) * (1_073_000_000 - q.qty)).toBeCloseTo(30 * 1_073_000_000, 0);
  });

  it("selling what you just bought returns less than you paid (fees + impact)", () => {
    const b = quoteBuy(state, 1000)!;
    const after = { ...state, reserveQuote: state.reserveQuote + 990 / 150, reserveBase: state.reserveBase - b.qty };
    const s = quoteSell(after, b.qty)!;
    expect(s.netUsd).toBeLessThan(1000);
    expect(s.netUsd).toBeCloseTo(990 * 0.99, 4);
  });

  it("rejects non-positive sizes", () => {
    expect(quoteBuy(state, 0)).toBeNull();
    expect(quoteSell(state, -1)).toBeNull();
  });

  it("curve progress is 0 at launch and 1 when all sale tokens are sold", () => {
    expect(pumpCurveProgress(PUMP_CURVE.INITIAL_VIRTUAL_TOKENS)).toBe(0);
    expect(pumpCurveProgress(PUMP_CURVE.INITIAL_VIRTUAL_TOKENS - PUMP_CURVE.REAL_TOKENS_FOR_SALE)).toBe(1);
  });
});

describe("candles", () => {
  const ev = (id: string, ts: number, price: number, side: "buy" | "sell" = "buy") => ({
    id, ts, price, baseQty: 1, quoteQty: price, side,
  });

  it("deduplicates by event id", () => {
    const c = new CandleBuilder();
    expect(c.add(ev("a", 1000, 1))).toBe(true);
    expect(c.add(ev("a", 1000, 1))).toBe(false);
    expect(c.candles(1)[0].v).toBe(1);
  });

  it("keeps correct open/close when events arrive out of order", () => {
    const c = new CandleBuilder();
    c.add(ev("c", 1900, 3));
    c.add(ev("a", 1100, 1));
    c.add(ev("b", 1500, 5));
    const [k] = c.candles(1);
    expect(k).toMatchObject({ o: 1, c: 3, h: 5, l: 1, buys: 3 });
  });

  it("aggregates 1s buckets into larger intervals", () => {
    const c = new CandleBuilder();
    c.add(ev("a", 60_000, 1));
    c.add(ev("b", 90_000, 2, "sell"));
    c.add(ev("d", 125_000, 4));
    const m = c.candles(60);
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ t: 60, o: 1, c: 2, buys: 1, sells: 1 });
    expect(m[1]).toMatchObject({ t: 120, o: 4 });
  });
});
