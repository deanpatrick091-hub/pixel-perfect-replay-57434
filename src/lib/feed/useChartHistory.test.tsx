import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChartHistory, POLL_IDLE_MS, type HistoryFetcher } from "./useChartHistory";
import type { ChartHistory } from "./types";

const snap = (market: string, tf: string, swaps: number, state: ChartHistory["state"] = "ok"): ChartHistory => ({
  market, tf, source: "solana-rpc:pump-trade-event", state, candles: [], swaps, lastSuccessAt: 1, completedAt: 1, error: null,
});
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

afterEach(() => vi.useRealTimers());

describe("useChartHistory polling", () => {
  it("polls once at a time and stops after unmount", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<HistoryFetcher>(async (m, tf) => snap(m, tf, 3));
    const { result, unmount } = renderHook(() => useChartHistory("A", "1m", fetcher, true));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data?.swaps).toBe(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_IDLE_MS); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_IDLE_MS * 4); });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not poll while inactive (hidden chart)", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<HistoryFetcher>(async (m, tf) => snap(m, tf, 1));
    renderHook(() => useChartHistory("A", "1m", fetcher, false));
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_IDLE_MS * 3); });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("drops a late response from the previous market and aborts it", async () => {
    vi.useFakeTimers();
    let resolveA: (v: ChartHistory) => void = () => {};
    let abortedA = false;
    const fetcher = vi.fn<HistoryFetcher>((m, tf, signal) => {
      if (m === "A") { signal.addEventListener("abort", () => { abortedA = true; }); return new Promise((r) => { resolveA = r; }); }
      return Promise.resolve(snap(m, tf, 7));
    });
    const { result, rerender } = renderHook(({ id }) => useChartHistory(id, "1m", fetcher, true), { initialProps: { id: "A" } });
    await flush();
    rerender({ id: "B" });
    await flush();
    expect(abortedA).toBe(true);
    await act(async () => { resolveA(snap("A", "1m", 99)); await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.data?.market).toBe("B");
    expect(result.current.data?.swaps).toBe(7);
  });

  it("keeps the whole previous snapshot when a poll fails", async () => {
    vi.useFakeTimers();
    let fail = false;
    const fetcher = vi.fn<HistoryFetcher>(async (m, tf) => (fail ? null : snap(m, tf, 5)));
    const { result } = renderHook(() => useChartHistory("A", "1m", fetcher, true));
    await flush();
    fail = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_IDLE_MS); });
    expect(result.current.netErr).toBe(true);
    expect(result.current.data?.swaps).toBe(5);
  });

  it("a candle-less failure/empty after a worker restart keeps the whole previous snapshot", async () => {
    vi.useFakeTimers();
    let restarted = false;
    const withCandles = { ...snap("A", "1m", 4), candles: [{ t: 60, o: 1, h: 2, l: 1, c: 2, v: 1, buys: 4, sells: 0 } as any] };
    const fetcher = vi.fn<HistoryFetcher>(async (m, tf) => (restarted ? { ...snap(m, tf, 0, "unknown_market") } : withCandles));
    const { result } = renderHook(() => useChartHistory("A", "1m", fetcher, true));
    await flush();
    restarted = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_IDLE_MS); });
    expect(result.current.data?.swaps).toBe(4);
    expect(result.current.data?.candles.length).toBe(1);
    expect(result.current.data?.state).toBe("ok");
    expect(result.current.latest?.state).toBe("unknown_market");
    expect(result.current.latest?.swaps).toBe(0);
  });

  it("timeframe change resets to that timeframe's own snapshot", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<HistoryFetcher>(async (m, tf) => snap(m, tf, tf === "5m" ? 2 : 9));
    const { result, rerender } = renderHook(({ tf }) => useChartHistory("A", tf, fetcher, true), { initialProps: { tf: "1m" } });
    await flush();
    expect(result.current.data?.tf).toBe("1m");
    rerender({ tf: "5m" });
    expect(result.current.data).toBeNull();
    await flush();
    expect(result.current.data?.tf).toBe("5m");
    expect(fetcher).toHaveBeenLastCalledWith("A", "5m", expect.anything());
  });
});
