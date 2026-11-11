import { useEffect, useState } from "react";
import type { ChartHistory } from "./types";

export type HistoryFetcher = (marketId: string, tf: string, signal: AbortSignal) => Promise<ChartHistory | null>;
export const POLL_IDLE_MS = 15_000;
export const POLL_BUSY_MS = 4_000;

interface Snap { key: string; data: ChartHistory | null; netErr: boolean }

/**
 * Polls read-only history for the selected market/timeframe while `active` and the tab is visible.
 * One request at a time; responses for another market/timeframe or after unmount are dropped.
 * A failed poll keeps the whole previous snapshot (never mixes old candles with new metadata).
 */
export function useChartHistory(marketId: string, tf: string, fetcher: HistoryFetcher, active: boolean) {
  const key = `${marketId}|${tf}`;
  const [snap, setSnap] = useState<Snap>({ key, data: null, netErr: false });

  useEffect(() => {
    setSnap((p) => (p.key === key ? p : { key, data: null, netErr: false }));
    if (!active) return;
    let stopped = false, inflight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctrl: AbortController | null = null;
    const schedule = (ms: number) => { clearTimeout(timer); timer = setTimeout(tick, ms); };
    const tick = async () => {
      if (stopped || inflight || document.visibilityState === "hidden") return;
      inflight = true;
      ctrl = new AbortController();
      const res = await fetcher(marketId, tf, ctrl.signal).catch(() => null);
      inflight = false;
      if (stopped) return;
      const valid = res && res.market === marketId && res.tf === tf ? res : null;
      setSnap((p) => (p.key !== key ? p : valid ? { key, data: valid, netErr: false } : { ...p, netErr: true }));
      const busy = !valid || valid.state === "loading" || valid.state === "partial" || valid.refreshing;
      if (valid && (valid.state === "unsupported" || valid.state === "unknown_market")) schedule(POLL_IDLE_MS * 2);
      else schedule(busy ? POLL_BUSY_MS : POLL_IDLE_MS);
    };
    const onVis = () => { if (document.visibilityState === "visible") schedule(0); else clearTimeout(timer); };
    document.addEventListener("visibilitychange", onVis);
    schedule(0);
    return () => { stopped = true; clearTimeout(timer); ctrl?.abort(); document.removeEventListener("visibilitychange", onVis); };
  }, [key, marketId, tf, fetcher, active]);

  return snap.key === key ? snap : { key, data: null, netErr: false };
}
