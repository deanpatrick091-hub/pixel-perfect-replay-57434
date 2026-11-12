import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChartHistory, POLL_IDLE_MS, POLL_BUSY_MS, MIN_GAP_MS, STUCK_MS, type HistoryFetcher, type NudgeSubscribe } from "./useChartHistory";
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

  it("a new-swap nudge refetches right away, coalescing bursts", async () => {
    vi.useFakeTimers();
    let fire = () => {};
    const sub: NudgeSubscribe = (_id, f) => { fire = f; return () => { fire = () => {}; }; };
    let calls = 0;
    const fetcher = vi.fn<HistoryFetcher>(async (m, tf) => snap(m, tf, ++calls));
    renderHook(() => useChartHistory("A", "1m", fetcher, true, sub));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    act(() => { fire(); fire(); fire(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(MIN_GAP_MS); });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("hidden while a request is in flight, then visible: polling resumes (iOS)", async () => {
    vi.useFakeTimers();
    let release: (v: ChartHistory) => void = () => {};
    let calls = 0;
    const fetcher = vi.fn<HistoryFetcher>((m, tf) => (++calls === 1 ? new Promise<ChartHistory>((r) => { release = r; }) : Promise.resolve(snap(m, tf, 2))));
    const vis = vi.spyOn(document, "visibilityState", "get");
    vis.mockReturnValue("visible");
    const { result } = renderHook(() => useChartHistory("A", "1m", fetcher, true));
    await flush();
    vis.mockReturnValue("hidden");
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => { release(snap("A", "1m", 1)); await vi.advanceTimersByTimeAsync(POLL_IDLE_MS * 3); });
    expect(fetcher).toHaveBeenCalledTimes(1); // no polling while hidden
    vis.mockReturnValue("visible");
    await act(async () => { window.dispatchEvent(new Event("pageshow")); await vi.advanceTimersByTimeAsync(0); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.data?.swaps).toBe(2);
    vis.mockRestore();
  });

  it("a stuck request is aborted and retried; network failures retry automatically", async () => {
    vi.useFakeTimers();
    let aborted = false;
    let mode: "hang" | "fail" | "ok" = "hang";
    const fetcher = vi.fn<HistoryFetcher>((m, tf, signal) => {
      if (mode === "hang") { signal.addEventListener("abort", () => { aborted = true; }); return new Promise(() => {}); }
      return Promise.resolve(mode === "fail" ? null : snap(m, tf, 3));
    });
    const { result } = renderHook(() => useChartHistory("A", "1m", fetcher, true));
    await flush();
    mode = "fail";
    await act(async () => { await vi.advanceTimersByTimeAsync(STUCK_MS + 5_000); });
    expect(aborted).toBe(true);
    expect(result.current.netErr).toBe(true);
    const n = fetcher.mock.calls.length;
    mode = "ok";
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(fetcher.mock.calls.length).toBeGreaterThan(n);
    expect(result.current.netErr).toBe(false);
    expect(result.current.data?.swaps).toBe(3);
  });

  it("retry() asks the worker to retry now", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<HistoryFetcher>(async (m, tf) => snap(m, tf, 0, "unavailable"));
    const { result } = renderHook(() => useChartHistory("A", "1m", fetcher, true));
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(MIN_GAP_MS); result.current.retry(); await vi.advanceTimersByTimeAsync(0); });
    expect(fetcher).toHaveBeenLastCalledWith("A", "1m", expect.anything(), { retry: true });
    // unavailable polls at the busy interval, not idle
    const n = fetcher.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_BUSY_MS); });
    expect(fetcher.mock.calls.length).toBe(n + 1);
  });
});
