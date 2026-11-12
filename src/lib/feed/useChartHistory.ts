import { useCallback, useEffect, useRef, useState } from "react";
import type { ChartHistory } from "./types";

export type HistoryFetcher = (marketId: string, tf: string, signal: AbortSignal, opts?: { retry?: boolean }) => Promise<ChartHistory | null>;
export type NudgeSubscribe = (marketId: string, onNudge: () => void) => () => void;
export const POLL_IDLE_MS = 15_000;
export const POLL_BUSY_MS = 4_000;
export const MIN_GAP_MS = 700;          // nudges are coalesced to at most one fetch per this interval
export const STUCK_MS = 20_000;         // an in-flight request older than this is aborted and retried
export const WATCHDOG_MS = 5_000;
const ERR_BACKOFF = [3_000, 6_000, 12_000, 30_000];

/**
 * `data` is always one whole snapshot. `latest` is the most recent response when it was a transient
 * failure/empty without candles and we kept the previous candle snapshot instead (never mixed).
 */
interface Snap { key: string; data: ChartHistory | null; netErr: boolean; latest: ChartHistory | null; fetchedAt: number | null }
const TRANSIENT: ChartHistory["state"][] = ["loading", "rate_limited", "unavailable", "empty", "unknown_market"];
export function mergeSnapshot(prev: ChartHistory | null, next: ChartHistory): { data: ChartHistory; latest: ChartHistory | null } {
  if (prev && prev.candles.length && !next.candles.length && TRANSIENT.includes(next.state)) return { data: prev, latest: next };
  return { data: next, latest: null };
}

export function pollDelay(valid: ChartHistory | null, errStreak: number) {
  if (!valid) return ERR_BACKOFF[Math.max(0, Math.min(errStreak - 1, ERR_BACKOFF.length - 1))] ?? 3_000;
  if (valid.state === "unsupported" || valid.state === "unknown_market") return POLL_IDLE_MS * 2;
  const busy = valid.state === "loading" || valid.state === "rate_limited" || valid.state === "unavailable" || valid.refreshing ||
    (valid.state === "partial" && (valid.pendingTransactions ?? 0) > 0);
  return busy ? POLL_BUSY_MS : POLL_IDLE_MS;
}

const empty = (key: string): Snap => ({ key, data: null, netErr: false, latest: null, fetchedAt: null });

/**
 * Polls read-only history for the selected market/timeframe while `active` and the page is visible, and refetches
 * immediately (coalesced) when the worker nudges that new verified swaps arrived.
 * One request at a time; a stuck request is aborted; responses for another market/timeframe or after unmount are dropped.
 * Resumes on visibilitychange/pageshow/focus/online and via a watchdog (iOS can drop timers and events in background).
 */
export function useChartHistory(marketId: string, tf: string, fetcher: HistoryFetcher, active: boolean, subscribe?: NudgeSubscribe) {
  const key = `${marketId}|${tf}`;
  const [snap, setSnap] = useState<Snap>(() => empty(key));
  const retryRef = useRef<() => void>(() => {});

  useEffect(() => {
    setSnap((p) => (p.key === key ? p : empty(key)));
    if (!active) return;
    let stopped = false, inflightAt = 0, again = false, retryNext = false, lastStart = -Infinity, errStreak = 0;
    let timer: ReturnType<typeof setTimeout> | undefined, timerAt = 0;
    let ctrl: AbortController | null = null;
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    const schedule = (ms: number) => { clearTimeout(timer); timerAt = Date.now() + ms; timer = setTimeout(() => { timer = undefined; void tick(); }, ms); };
    const tick = async () => {
      if (stopped || hidden()) return; // a wake event resumes
      if (inflightAt) {
        if (Date.now() - inflightAt < STUCK_MS) { again = true; return; }
        ctrl?.abort(); // stuck (e.g. iOS suspended the request): abandon it and start over
      }
      const since = Date.now() - lastStart;
      if (since < MIN_GAP_MS) { schedule(MIN_GAP_MS - since); return; }
      const mine = new AbortController();
      ctrl = mine; inflightAt = lastStart = Date.now(); again = false;
      const retry = retryNext; retryNext = false;
      const res = await (retry ? fetcher(marketId, tf, mine.signal, { retry: true }) : fetcher(marketId, tf, mine.signal)).catch(() => null);
      if (stopped || ctrl !== mine) return; // superseded or unmounted
      inflightAt = 0; ctrl = null;
      const valid = res && res.market === marketId && res.tf === tf ? res : null;
      errStreak = valid ? 0 : errStreak + 1;
      setSnap((p) => (p.key !== key ? p : valid ? { key, ...mergeSnapshot(p.data, valid), netErr: false, fetchedAt: Date.now() } : { ...p, netErr: true }));
      schedule(again ? 0 : pollDelay(valid, errStreak));
    };
    const wake = () => { if (!hidden()) schedule(0); else clearTimeout(timer); };
    const nudge = () => { if (!timer || timerAt - Date.now() > MIN_GAP_MS) schedule(0); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("pageshow", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    const unsub = subscribe?.(marketId, nudge);
    const dog = setInterval(() => {
      if (stopped || hidden()) return;
      if (inflightAt && Date.now() - inflightAt >= STUCK_MS) schedule(0);
      else if (!inflightAt && (!timer || Date.now() - timerAt > WATCHDOG_MS)) schedule(0);
    }, WATCHDOG_MS);
    retryRef.current = () => { retryNext = true; errStreak = 0; schedule(0); };
    schedule(0);
    return () => {
      stopped = true; clearTimeout(timer); clearInterval(dog); ctrl?.abort(); unsub?.();
      retryRef.current = () => {};
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("pageshow", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [key, marketId, tf, fetcher, active, subscribe]);

  const retry = useCallback(() => retryRef.current(), []);
  return { ...(snap.key === key ? snap : empty(key)), retry };
}
