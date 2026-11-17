import { useCallback, useEffect, useRef, useState } from "react";
import type { ChartHistory } from "./types";
import { INTERVALS } from "../market/candles";
import type { Candle } from "./types";

/**
 * Last whole snapshot per market|timeframe for this page session, so revisits and timeframe switches paint
 * real cached candles instantly (flagged `cached` until a fresh response for that key arrives).
 */
const CACHE_MAX = 60;
const cache = new Map<string, { data: ChartHistory; fetchedAt: number }>();
const TF_SEC = INTERVALS;
export function clearHistoryCache() { cache.clear(); }
function remember(key: string, data: ChartHistory, fetchedAt: number) {
  cache.delete(key); cache.set(key, { data, fetchedAt });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}
/** Exact re-bucketing of finer epoch-aligned candles into a coarser interval that it divides (same swap set). */
export function rebucket(candles: Candle[], fromSec: number, toSec: number): Candle[] | null {
  if (!(fromSec > 0) || toSec % fromSec !== 0 || toSec < fromSec) return null;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of [...candles].sort((a, b) => a.t - b.t)) {
    if (c.t % fromSec !== 0) return null; // not aligned: refuse rather than guess
    const t = Math.floor(c.t / toSec) * toSec;
    if (!cur || cur.t !== t) { cur = { ...c, t }; out.push(cur); continue; }
    cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c; cur.v += c.v;
    cur.buyVolume = cur.buyVolume != null && c.buyVolume != null ? cur.buyVolume + c.buyVolume : undefined;
    cur.sellVolume = cur.sellVolume != null && c.sellVolume != null ? cur.sellVolume + c.sellVolume : undefined; cur.buys += c.buys; cur.sells += c.sells;
  }
  return out;
}
/** Cached snapshot for this key, else one derived exactly from a cached finer timeframe of the same market. */
export function cachedSnapshot(marketId: string, tf: string): { data: ChartHistory; fetchedAt: number } | null {
  const hit = cache.get(`${marketId}|${tf}`);
  if (hit) return hit;
  const to = TF_SEC[tf];
  if (!to) return null;
  let best: { data: ChartHistory; fetchedAt: number; from: number } | null = null;
  for (const [k, v] of cache) {
    const [m, f] = [k.slice(0, k.lastIndexOf("|")), k.slice(k.lastIndexOf("|") + 1)];
    const from = TF_SEC[f];
    if (m !== marketId || !from || from >= to || to % from !== 0 || v.data.market !== marketId) continue;
    if (!best || v.fetchedAt > best.fetchedAt) best = { ...v, from };
  }
  if (!best) return null;
  const candles = rebucket(best.data.candles, best.from, to);
  return candles ? { data: { ...best.data, tf, candles }, fetchedAt: best.fetchedAt } : null;
}

export type HistoryFetcher = (marketId: string, tf: string, signal: AbortSignal, opts?: { retry?: boolean }) => Promise<ChartHistory | null>;
export type NudgeSubscribe = (marketId: string, onNudge: () => void) => () => void;
export const POLL_IDLE_MS = 15_000;
export const POLL_BUSY_MS = 4_000;
export const MIN_GAP_MS = 300;          // nudges are coalesced to at most one fetch per this interval (polling stays 4s/15s)
export const STUCK_MS = 20_000;         // an in-flight request older than this is aborted and retried
export const WATCHDOG_MS = 5_000;
const ERR_BACKOFF = [3_000, 6_000, 12_000, 30_000];

/**
 * `data` is always one whole snapshot. `latest` is the most recent response when it was a transient
 * failure/empty without candles and we kept the previous candle snapshot instead (never mixed).
 */
interface Snap { key: string; data: ChartHistory | null; netErr: boolean; latest: ChartHistory | null; fetchedAt: number | null; cached: boolean }
const TRANSIENT: ChartHistory["state"][] = ["loading", "rate_limited", "unavailable", "empty", "unknown_market"];
/** The worker restarted and is rebuilding from its newest window: fewer swaps, later start, nothing newer than we hold. */
export function isRegressedReload(prev: ChartHistory, next: ChartHistory) {
  // Same worker process, same-or-newer revision: an authoritative correction (e.g. a rejected provisional swap), never a reset.
  if (prev.instance && prev.instance === next.instance && (next.version ?? 0) >= (prev.version ?? 0)) return false;
  return next.coverage !== "complete" && next.swaps < prev.swaps && prev.oldestTs != null && next.oldestTs != null &&
    next.oldestTs > prev.oldestTs && (next.newestTs ?? 0) <= (prev.newestTs ?? 0);
}
export function mergeSnapshot(prev: ChartHistory | null, next: ChartHistory): { data: ChartHistory; latest: ChartHistory | null } {
  // Revisions are comparable only within a known worker instance. Order them before
  // candle retention: reconciliation may authoritatively remove the final swap.
  if (prev?.instance && prev.instance === next.instance && prev.version != null && next.version != null) {
    if (next.version < prev.version) return { data: prev, latest: null };
    if (next.version > prev.version) return { data: next, latest: null };
  }
  if (prev && prev.candles.length && !next.candles.length && TRANSIENT.includes(next.state)) return { data: prev, latest: next };
  // Keep the whole earlier snapshot (never mixed) until the reload catches up or brings a newer swap.
  if (prev && prev.candles.length && next.candles.length && isRegressedReload(prev, next)) return { data: prev, latest: next };
  return { data: next, latest: null };
}

export function pollDelay(valid: ChartHistory | null, errStreak: number) {
  if (!valid) return ERR_BACKOFF[Math.max(0, Math.min(errStreak - 1, ERR_BACKOFF.length - 1))] ?? 3_000;
  if (valid.state === "unsupported" || valid.state === "unknown_market") return POLL_IDLE_MS * 2;
  const busy = valid.state === "loading" || valid.state === "rate_limited" || valid.state === "unavailable" || valid.refreshing ||
    (valid.state === "partial" && (valid.pendingTransactions ?? 0) > 0);
  return busy ? POLL_BUSY_MS : POLL_IDLE_MS;
}

const empty = (key: string): Snap => ({ key, data: null, netErr: false, latest: null, fetchedAt: null, cached: false });
const initial = (key: string, marketId: string, tf: string): Snap => {
  const c = cachedSnapshot(marketId, tf);
  return c ? { ...empty(key), data: c.data, fetchedAt: c.fetchedAt, cached: true } : empty(key);
};

/**
 * Polls read-only history for the selected market/timeframe while `active` and the page is visible, and refetches
 * immediately (coalesced) when the worker nudges that new verified swaps arrived.
 * One request at a time; a stuck request is aborted; responses for another market/timeframe or after unmount are dropped.
 * Resumes on visibilitychange/pageshow/focus/online and via a watchdog (iOS can drop timers and events in background).
 */
export function useChartHistory(marketId: string, tf: string, fetcher: HistoryFetcher, active: boolean, subscribe?: NudgeSubscribe) {
  const key = `${marketId}|${tf}`;
  const [snap, setSnap] = useState<Snap>(() => initial(key, marketId, tf));
  const retryRef = useRef<() => void>(() => {});

  useEffect(() => {
    setSnap((p) => (p.key === key ? p : initial(key, marketId, tf)));
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
      setSnap((p) => {
        if (p.key !== key) return p;
        if (!valid) return { ...p, netErr: true };
        const merged = mergeSnapshot(p.data, valid), at = Date.now();
        remember(key, merged.data, at);
        return { key, ...merged, netErr: false, fetchedAt: at, cached: false };
      });
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
  return { ...(snap.key === key ? snap : initial(key, marketId, tf)), retry };
}
