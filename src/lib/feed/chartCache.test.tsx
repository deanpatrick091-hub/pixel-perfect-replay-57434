import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { cachedSnapshot, clearHistoryCache, rebucket, useChartHistory, type HistoryFetcher } from "./useChartHistory";
import { CandleBuilder } from "../market/candles";
import type { ChartHistory } from "./types";

afterEach(() => { vi.useRealTimers(); clearHistoryCache(); });
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

function swaps() {
  const b = new CandleBuilder();
  const base = 1_700_000_000; // multiple of 60? use aligned start below
  const t0 = Math.floor(base / 60) * 60;
  [[0, 1, "buy"], [5, 1.2, "sell"], [59, 0.9, "buy"], [61, 1.5, "buy"], [130, 1.1, "sell"], [131, 1.3, "buy"]].forEach(([dt, p, side], i) =>
    b.add({ id: String(i).padStart(4, "0"), ts: (t0 + (dt as number)) * 1000, price: p as number, baseQty: 1, quoteQty: p as number, side: side as "buy" | "sell" }));
  return b;
}
const hist = (market: string, tf: string, candles: ChartHistory["candles"], version = 1): ChartHistory => ({
  market, tf, source: "solana-rpc:pumpswap-buy-sell-event", state: "partial", candles, swaps: candles.reduce((n, c) => n + c.buys + c.sells, 0),
  lastSuccessAt: 1, completedAt: null, error: null, instance: "w1", version,
});

describe("chart snapshot cache", () => {
  it("re-bucketing 1s candles into 1m equals building 1m from the same swaps", () => {
    const b = swaps();
    expect(rebucket(b.candles(1), 1, 60)).toEqual(b.candles(60));
    expect(rebucket(b.candles(1), 1, 300)).toEqual(b.candles(300));
    expect(rebucket(b.candles(60), 60, 90)).toBeNull(); // not divisible: refuse
  });

  it("switching 1s -> 1m paints real candles instantly (no blank Loading), flagged cached until fresh data", async () => {
    vi.useFakeTimers();
    const b = swaps();
    let release: (v: ChartHistory) => void = () => {};
    const fetcher = vi.fn<HistoryFetcher>((m, tf) => tf === "1s" ? Promise.resolve(hist(m, tf, b.candles(1))) : new Promise((r) => { release = r; }));
    const { result, rerender } = renderHook(({ tf }) => useChartHistory("solana:pool:G", tf, fetcher, true), { initialProps: { tf: "1s" } });
    await flush();
    expect(result.current.data?.candles.length).toBe(b.candles(1).length);
    rerender({ tf: "1m" });
    expect(result.current.data?.tf).toBe("1m");
    expect(result.current.data?.candles).toEqual(b.candles(60));
    expect(result.current.cached).toBe(true);
    await flush(); // the 1m request starts
    expect(result.current.cached).toBe(true);
    await act(async () => { release(hist("solana:pool:G", "1m", b.candles(60), 2)); await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.cached).toBe(false);
    expect(result.current.data?.version).toBe(2);
  });

  it("revisiting a market shows its exact cached snapshot immediately; other markets never borrow it", async () => {
    vi.useFakeTimers();
    const b = swaps();
    const fetcher = vi.fn<HistoryFetcher>(async (m, tf) => hist(m, tf, b.candles(60)));
    const first = renderHook(() => useChartHistory("solana:pool:A", "1m", fetcher, true));
    await flush();
    first.unmount();
    const again = renderHook(() => useChartHistory("solana:pool:A", "1m", vi.fn<HistoryFetcher>(() => new Promise(() => {})), true));
    expect(again.result.current.data?.candles).toEqual(b.candles(60));
    expect(again.result.current.cached).toBe(true);
    expect(cachedSnapshot("solana:pool:B", "1m")).toBeNull();
    expect(cachedSnapshot("solana:pool:A", "1s")).toBeNull(); // coarser never becomes finer
  });
});

describe("cache freshness on retained snapshots", () => {
  it("a transient empty reply keeps the original age, records latest in the cache, and stays labelled cached", async () => {
    vi.useFakeTimers();
    const b = swaps();
    const good = vi.fn<HistoryFetcher>(async (m, tf) => hist(m, tf, b.candles(60), 3));
    const first = renderHook(() => useChartHistory("solana:pool:R", "1m", good, true));
    await flush();
    const at = first.result.current.fetchedAt;
    first.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    const limited: ChartHistory = { ...hist("solana:pool:R", "1m", [], 3), state: "rate_limited", error: "429", instance: "w2" };
    const again = renderHook(() => useChartHistory("solana:pool:R", "1m", vi.fn<HistoryFetcher>(async () => limited), true));
    await flush();
    expect(again.result.current.data?.version).toBe(3);
    expect(again.result.current.fetchedAt).toBe(at);
    expect(again.result.current.cached).toBe(true);
    expect(again.result.current.latest?.state).toBe("rate_limited");
    expect(cachedSnapshot("solana:pool:R", "1m")?.fetchedAt).toBe(at);
    expect(cachedSnapshot("solana:pool:R", "1m")?.latest?.state).toBe("rate_limited");
  });

  it("an older same-instance revision keeps the original age; a newer accepted one refreshes it", async () => {
    vi.useFakeTimers();
    const b = swaps();
    let v = 5;
    const f = vi.fn<HistoryFetcher>(async (m, tf) => hist(m, tf, b.candles(60), v));
    const r = renderHook(() => useChartHistory("solana:pool:V", "1m", f, true));
    await flush();
    const at = r.result.current.fetchedAt!;
    v = 4;
    await act(async () => { r.result.current.retry(); await vi.advanceTimersByTimeAsync(1_000); });
    expect(r.result.current.data?.version).toBe(5);
    expect(r.result.current.fetchedAt).toBe(at);
    v = 6;
    await act(async () => { r.result.current.retry(); await vi.advanceTimersByTimeAsync(1_000); });
    expect(r.result.current.data?.version).toBe(6);
    expect(r.result.current.fetchedAt!).toBeGreaterThan(at);
  });
});
