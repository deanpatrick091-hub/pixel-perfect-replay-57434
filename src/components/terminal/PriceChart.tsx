import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { feed } from "@/lib/feed/client";
import type { Candle, ChartHistory } from "@/lib/feed/types";
import { useChartHistory } from "@/lib/feed/useChartHistory";
import { BAR_SPACING, RIGHT_OFFSET, fitRange, initialRange, tailUpdateFrom } from "@/lib/chart/viewport";
import { fmtPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

export const TIMEFRAMES = ["1s", "5s", "15s", "1m", "5m", "15m", "1h", "4h", "1D"] as const;

// The chart library only understands rgb/hex, so resolve theme tokens (oklch) through a canvas.
function cssVar(name: string) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx) return "#888888";
  ctx.fillStyle = raw;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  const hex = (n: number | undefined) => (n ?? 0).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

const fetchHistory = (id: string, tf: string, signal: AbortSignal, opts?: { retry?: boolean }) => feed.history(id, tf, signal, opts);
const clock = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleTimeString() : "never");
const ago = (ms: number | null | undefined, now: number) => {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};
type Tone = "live" | "ok" | "warn" | "bad";

export function PriceChart({ marketId, quoteCcy, tick, liveTrades }: { marketId: string; quoteCcy: string; tick: number; liveTrades: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<{ chart: any; candles: any; volume: any; up: string; down: string } | null>(null);
  const [tf, setTf] = useState<(typeof TIMEFRAMES)[number]>("1m");
  const [ready, setReady] = useState(false);
  const [chartError, setChartError] = useState(false);
  const [visible, setVisible] = useState(false);
  const [details, setDetails] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [live, setLive] = useState<{ candles: Candle[]; note: string } | null>(null);
  const shown = useRef<{ key: string; list: Candle[] } | null>(null);

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  // Only poll while the chart is actually on screen (mobile tabs hide it with CSS).
  useEffect(() => {
    if (!wrap.current || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const io = new IntersectionObserver(([e]) => setVisible(e?.isIntersecting ?? false));
    io.observe(wrap.current);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    void import("lightweight-charts").then((lc) => {
      if (disposed || !el.current) return;
      const fg = cssVar("--muted-foreground");
      const border = cssVar("--border");
      const chart = lc.createChart(el.current, {
        autoSize: true,
        layout: { background: { color: "transparent" }, textColor: fg, fontFamily: "JetBrains Mono, monospace", fontSize: 11 },
        grid: { vertLines: { color: border + "66" }, horzLines: { color: border + "66" } },
        rightPriceScale: { borderColor: border },
        // Fixed narrow bars, latest candle right-aligned; sparse data never stretches across the screen.
        timeScale: { borderColor: border, timeVisible: true, secondsVisible: true, barSpacing: BAR_SPACING, minBarSpacing: 0.5, rightOffset: RIGHT_OFFSET, shiftVisibleRangeOnNewBar: true },
        crosshair: { mode: lc.CrosshairMode.Normal },
        localization: { priceFormatter: (p: number) => fmtPrice(p, "") },
      });
      const up = cssVar("--up"), down = cssVar("--down");
      // Close >= open is bullish (green), close < open bearish (red); body, border and wick all follow.
      const candles = chart.addSeries(lc.CandlestickSeries, {
        upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
        priceFormat: { type: "custom", formatter: (p: number) => fmtPrice(p, ""), minMove: 1e-12 },
      });
      const volume = chart.addSeries(lc.HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      api.current = { chart, candles, volume, up, down };
      setReady(true);
    }).catch(() => { if (!disposed) setChartError(true); });
    return () => { disposed = true; api.current?.chart.remove(); api.current = null; };
  }, []);

  const hist = useChartHistory(marketId, tf, fetchHistory, ready && visible, feed.onChart);
  const h: ChartHistory | null = hist.data;
  const historyOff = h?.state === "unsupported" || h?.state === "unknown_market";
  const useLive = historyOff && liveTrades;

  // Live worker-observed candles: only when history doesn't apply and real trades are actually streaming.
  useEffect(() => {
    if (!useLive || !ready) { setLive(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const res = await feed.candles(marketId, tf);
      if (!cancelled && res) setLive({ candles: res.candles, note: res.note });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [useLive, ready, marketId, tf, tick]);

  const list: Candle[] = useMemo(() => (useLive ? live?.candles ?? [] : h?.candles ?? []), [useLive, live, h]);
  const viewKey = `${marketId}|${tf}|${useLive ? "live" : "hist"}`;

  const resetView = useCallback((n: number, fit = false) => {
    const a = api.current;
    if (!a || !el.current || !n) return;
    a.chart.timeScale().setVisibleLogicalRange((fit ? fitRange : initialRange)(n, el.current.clientWidth));
  }, []);

  useEffect(() => {
    const a = api.current;
    if (!a) return;
    const bar = (c: Candle) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c });
    const vol = (c: Candle) => ({ time: c.t, value: c.v, color: (c.c >= c.o ? a.up : a.down) + "88" });
    const prev = shown.current?.key === viewKey ? shown.current.list : null;
    const from = prev ? tailUpdateFrom(prev, list) : -1;
    if (from >= 0) {
      // A new real swap: update the latest candle's close/high/low/volume, or append the next traded interval.
      for (const c of list.slice(from)) { a.candles.update(bar(c)); a.volume.update(vol(c)); }
    } else {
      const ts = a.chart.timeScale();
      const range = prev ? ts.getVisibleRange() : null;
      const tracking = prev ? ts.scrollPosition() >= RIGHT_OFFSET - 1 : true;
      a.candles.setData(list.map(bar));
      a.volume.setData(list.map(vol));
      // First data for this market/timeframe: narrow right-aligned view. Later replacements keep the user's pan/zoom.
      if (!prev || !prev.length) resetView(list.length);
      else if (tracking) ts.scrollToRealTime();
      else if (range) ts.setVisibleRange(range);
    }
    shown.current = { key: viewKey, list };
  }, [list, viewKey, ready, resetView]);

  const fit = useCallback(() => resetView(shown.current?.list.length ?? 0, true), [resetView]);
  const latest = useCallback(() => api.current?.chart.timeScale().scrollToRealTime(), []);

  // ---- status (outside the canvas) ----
  const streaming = h?.live?.state === "streaming";
  const status = ((): { tone: Tone; text: string; retry?: boolean } => {
    if (useLive) return { tone: "live", text: `Swaps streamed by PumpPortal · ${list.reduce((n, c) => n + c.buys + c.sells, 0)} swaps` };
    if (!h) return hist.netErr ? { tone: "bad", text: "Market service unreachable · retrying", retry: true } : { tone: "ok", text: "Loading on-chain history…" };
    if (historyOff) return { tone: "ok", text: "On-chain chart history isn't available for this market" };
    const lastSwap = h.newestTs ? `last swap ${ago(h.newestTs * 1000, now)}` : "no swaps yet";
    const head = `${h.swaps} swaps · ${lastSwap}`;
    if (hist.netErr) return { tone: "bad", text: `Market service unreachable · showing snapshot from ${ago(hist.fetchedAt, now)}`, retry: true };
    if (h.state === "rate_limited") {
      const wait = h.retryAt ? Math.max(0, Math.ceil((h.retryAt - now) / 1000)) : null;
      return { tone: "warn", text: `Free Solana RPC is rate limiting · retrying${wait ? ` in ${wait}s` : ""} · ${head}` };
    }
    if (h.state === "unavailable") return { tone: "bad", text: `On-chain history request failed · retrying · ${head}`, retry: true };
    if (h.state === "loading") return { tone: "ok", text: "Loading recent swaps from Solana…" };
    const mode = streaming ? "Live" : h.live?.state === "reconnecting" || h.live?.state === "subscribing" ? "Connecting live · polling" : "Polling";
    const scanning = h.state === "partial" && (h.pendingTransactions ?? 0) > 0
      ? ` · loading ${h.backfill?.state === "in_progress" ? "older history" : "swaps"} (${h.pendingTransactions} left)` : h.state === "partial" ? " · incomplete coverage" : "";
    return { tone: streaming ? "live" : h.state === "partial" && !(h.pendingTransactions ?? 0) ? "warn" : "ok", text: `${mode} · ${head}${scanning}` };
  })();

  const diag = ((): string[] => {
    if (!h || historyOff) return h?.error ? [h.error] : [];
    const out: string[] = [];
    out.push("Source: Pump.fun TradeEvents decoded from confirmed transactions via free public Solana RPC (read-only; never used for prices or paper orders).");
    out.push(streaming
      ? `Delivery: live hints from Solana logsSubscribe for this curve, each swap fetched and validated before charting, plus polled catch-up.${h.live?.hintToChartMs != null ? ` Last live swap charted ${(h.live.hintToChartMs / 1000).toFixed(1)}s after its notification (${((h.live.chainToChartMs ?? 0) / 1000).toFixed(1)}s after block time).` : ""}`
      : `Delivery: polled history (not tick streaming)${h.live?.state && h.live.state !== "off" ? ` — live stream ${h.live.state}${h.live.error ? ` (${h.live.error})` : ""}` : ""}. New swaps can take several seconds to appear.`);
    if (h.oldestTs && h.newestTs) out.push(`Range: swaps from ${new Date(h.oldestTs * 1000).toLocaleTimeString()} to ${new Date(h.newestTs * 1000).toLocaleTimeString()}.`);
    const b = h.backfill;
    if (b) out.push(b.state === "in_progress" ? `Older history: loading (${b.listedSignatures} of max ${b.maxSignatures} transactions listed).`
      : b.state === "done_start" ? "Older history: complete back to the curve's first transaction."
      : b.state === "done_limit" ? `Older history: stopped at the ${b.maxSignatures}-transaction limit${b.oldestListedTs ? ` (${new Date(b.oldestListedTs * 1000).toLocaleTimeString()})` : ""}; earlier swaps are not fetched.`
      : b.state === "done_age" ? `Older history: limited to ${Math.round(b.maxAgeSec / 60)} minutes before first view; earlier swaps are not fetched.` : "Older history: waiting for the first page.");
    const gaps = [
      h.transportFailedTransactions ? `${h.transportFailedTransactions} transactions failed to load` : "",
      h.missingTransactions ? `${h.missingTransactions} not returned by RPC` : "",
      h.droppedTransactions ? `${h.droppedTransactions} skipped (backlog limit)` : "",
      h.scanGaps ? `${h.scanGaps} activity gap${h.scanGaps > 1 ? "s" : ""} (too busy to scan fully)` : "",
      h.trimmedSwaps ? `${h.trimmedSwaps} oldest swaps trimmed from memory` : "",
      h.rejectedEvents ? `${h.rejectedEvents} events rejected by validation` : "",
    ].filter(Boolean);
    if (gaps.length) out.push(`Coverage gaps: ${gaps.join(" · ")}.`);
    if (h.curveStatus && h.curveStatus !== "active") out.push("Curve completed — these are its pre-migration swaps; the destination pool isn't charted.");
    if (h.error) out.push(`Last error: ${h.error}`);
    if (h.lastRateLimitAt) out.push(`Last rate limit: ${clock(h.lastRateLimitAt)}.`);
    out.push(`Last RPC contact ${clock(h.lastSuccessAt)}${h.completedAt ? ` · coverage complete ${clock(h.completedAt)}` : ""}.`);
    out.push("Each candle aggregates every swap in its interval: its close, high, low and volume move with each new swap, and a new candle starts only when a swap lands in a new interval. Intervals without swaps show no candle.");
    return out;
  })();

  const emptyMsg = (() => {
    if (chartError || list.length) return null;
    if (useLive) return live ? <>No swaps observed for this market yet.<br />{live.note}</> : null;
    if (!h) return null;
    if (historyOff) return <>{h.error}</>;
    if (h.state === "empty") return <>No successful swaps found in this curve's recent transactions.</>;
    if (h.state === "rate_limited") return <>Waiting for the free Solana RPC to allow more requests…</>;
    if (h.state === "unavailable") return <>On-chain history couldn't be loaded yet. Retrying automatically.</>;
    if (h.state === "partial" && !(h.pendingTransactions ?? 0)) return <>No verified swaps decoded yet — some transactions couldn't be loaded or verified, so this isn't proof the curve had none.</>;
    return <>Loading recent swaps…</>;
  })();

  const dot = { live: "bg-up", ok: "bg-muted-foreground", warn: "bg-warn", bad: "bg-down" }[status.tone];

  return (
    <div ref={wrap} className="flex h-full min-h-[320px] flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <div className="scroll-thin flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-x-auto" role="group" aria-label="Timeframe">
          {TIMEFRAMES.map((t) => (
            <button key={t} onClick={() => setTf(t)} aria-pressed={tf === t}
              className={cn("num shrink-0 rounded px-1.5 py-0.5 text-[11px]", tf === t ? "bg-surface-2 text-primary" : "text-muted-foreground hover:text-foreground")}>
              {t}
            </button>
          ))}
          <button onClick={fit} className="ml-1 shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" aria-label="Fit candles">Fit</button>
          <button onClick={latest} className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" aria-label="Jump to latest candle">Latest</button>
        </div>
        <span className="hidden shrink-0 whitespace-nowrap text-[11px] text-muted-foreground md:inline">Price in {quoteCcy}</span>
      </div>
      <div className="flex min-w-0 items-center gap-2 border-b border-border px-2 py-1 text-[11px] text-muted-foreground" role="status">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot, status.tone === "live" && "animate-pulse")} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{status.text}</span>
        {status.retry && <button onClick={hist.retry} className="shrink-0 rounded border border-border px-1.5 text-foreground hover:bg-surface-2">Retry</button>}
        {diag.length > 0 && (
          <button onClick={() => setDetails((d) => !d)} aria-expanded={details} className="shrink-0 hover:text-foreground">{details ? "Hide" : "Details"}</button>
        )}
      </div>
      {details && diag.length > 0 && (
        <ul className="scroll-thin max-h-40 space-y-0.5 overflow-y-auto border-b border-border px-2 py-1.5 text-[11px] text-muted-foreground">
          {diag.map((d, i) => <li key={i}>{d}</li>)}
        </ul>
      )}
      <div className="relative min-h-[260px] flex-1">
        <div ref={el} className="absolute inset-0" />
        {chartError && <div role="alert" className="p-6 text-center text-xs text-muted-foreground">Chart failed to load. Refresh to try again.</div>}
        {emptyMsg && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center text-xs text-muted-foreground"><div>{emptyMsg}</div></div>
        )}
      </div>
    </div>
  );
}
