import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { feed } from "@/lib/feed/client";
import type { Candle, ChartHistory } from "@/lib/feed/types";
import { useChartHistory } from "@/lib/feed/useChartHistory";
import { BAR_SPACING, RIGHT_OFFSET, fitRange, initialRange } from "@/lib/chart/viewport";
import { isCandle, priceDigits, rowTailFrom, seriesRows, type ChartRow, type GapMode } from "@/lib/chart/series";
import { INTERVALS } from "@/lib/market/candles";
import { Button } from "@/components/ui/button";
import { fmtPriceSig } from "@/lib/format";
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
  const api = useRef<{ chart: any; candles: any; buyVolume: any; sellVolume: any; up: string; down: string } | null>(null);
  const [tf, setTf] = useState<(typeof TIMEFRAMES)[number]>("1m");
  const [ready, setReady] = useState(false);
  const [chartError, setChartError] = useState(false);
  const [visible, setVisible] = useState(false);
  const [details, setDetails] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [live, setLive] = useState<{ candles: Candle[]; note: string } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Default: traded intervals side by side (quiet intervals compressed, disclosed). "time" keeps real spacing.
  const [gapMode, setGapMode] = useState<GapMode>("compact");
  const digits = useRef(4);
  const shown = useRef<{ key: string; list: ChartRow[] } | null>(null);

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
      const surface = cssVar("--surface-2");
      const chart = lc.createChart(el.current, {
        autoSize: true,
        layout: { background: { color: "transparent" }, textColor: fg, fontFamily: "JetBrains Mono, monospace", fontSize: 11 },
        // Subtle terminal grid; the volume pane is separated by a thin divider.
        grid: { vertLines: { color: border + "26" }, horzLines: { color: border + "40" } },
        rightPriceScale: { borderColor: border, scaleMargins: { top: 0.12, bottom: 0.08 } },
        // Fixed narrow bars, latest candle right-aligned; sparse data never stretches across the screen.
        timeScale: { borderColor: border, timeVisible: true, secondsVisible: true, barSpacing: BAR_SPACING, minBarSpacing: 0.5, rightOffset: RIGHT_OFFSET, shiftVisibleRangeOnNewBar: true },
        crosshair: {
          mode: lc.CrosshairMode.Normal,
          vertLine: { color: fg + "99", width: 1, style: lc.LineStyle.Dashed, labelBackgroundColor: surface },
          horzLine: { color: fg + "99", width: 1, style: lc.LineStyle.Dashed, labelBackgroundColor: surface },
        },
      });
      const up = cssVar("--up"), down = cssVar("--down");
      // Close >= open is bullish (green), close < open bearish (red); body, border and wick all follow.
      const candles = chart.addSeries(lc.CandlestickSeries, {
        upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
        priceFormat: { type: "custom", formatter: (p: number) => fmtPriceSig(p, digits.current), minMove: 1e-12 },
      });
      chart.applyOptions({ layout: { panes: { separatorColor: border, separatorHoverColor: border + "66", enableResize: true } } });
      // Separate volume pane: verified buy volume above zero, sell volume below zero.
      const volFmt = (v: number) => { const x = Math.abs(v); return x < 1e-9 ? "0" : x >= 1000 ? `${(x / 1000).toFixed(1)}K` : x >= 1 ? x.toFixed(2) : x.toPrecision(2); };
      const volumeOptions = { priceFormat: { type: "custom" as const, formatter: volFmt, minMove: 1e-9 }, lastValueVisible: false, priceLineVisible: false };
      const buyVolume = chart.addSeries(lc.HistogramSeries, { ...volumeOptions, color: up + "b3" }, 1);
      const sellVolume = chart.addSeries(lc.HistogramSeries, { ...volumeOptions, color: down + "b3" }, 1);
      chart.panes()[0]?.setStretchFactor(3);
      chart.panes()[1]?.setStretchFactor(1);
      chart.subscribeCrosshairMove((p: any) => setHover(typeof p?.time === "number" ? p.time : null));
      api.current = { chart, candles, buyVolume, sellVolume, up, down };
      setReady(true);
    }).catch(() => { if (!disposed) setChartError(true); });
    return () => { disposed = true; api.current?.chart.remove(); api.current = null; };
  }, []);

  const hist = useChartHistory(marketId, tf, fetchHistory, ready && visible, feed.onChart);
  const h: ChartHistory | null = hist.data;
  const historyOff = h?.state === "unsupported" || h?.state === "unknown_market";
  const useLive = h?.state === "unsupported" && liveTrades;

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
  const viewKey = `${marketId}|${tf}|${useLive ? "live" : "hist"}|${gapMode}`;
  const expanded = useMemo(() => seriesRows(list, INTERVALS[tf] ?? 60, gapMode), [list, tf, gapMode]);
  const precision = useMemo(() => priceDigits(list), [list]);
  const pressure = useMemo(() => list.length && list.every((c) => c.buyVolume != null && c.sellVolume != null)
    ? list.reduce((p, c) => ({ buy: p.buy + (c.buyVolume ?? 0), sell: p.sell + (c.sellVolume ?? 0) }), { buy: 0, sell: 0 }) : null, [list]);

  // OHLCV readout: hovered candle, else the latest real candle (blank whitespace slots show "no swaps").
  const legend = useMemo(() => {
    if (!list.length) return null;
    const c = hover != null ? list.find((x) => x.t === hover) ?? null : list[list.length - 1]!;
    return { t: hover ?? list[list.length - 1]!.t, c };
  }, [hover, list]);

  const resetView = useCallback((n: number, fit = false) => {
    const a = api.current;
    if (!a || !el.current || !n) return;
    a.chart.timeScale().setVisibleLogicalRange((fit ? fitRange : initialRange)(n, el.current.clientWidth));
  }, []);

  useEffect(() => {
    const a = api.current;
    if (!a) return;
    const bar = (c: ChartRow) => isCandle(c) ? ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c }) : ({ time: c.t });
    const vol = (c: ChartRow, side: "buyVolume" | "sellVolume") => isCandle(c) && c[side] != null
      ? ({ time: c.t, value: (c[side] ?? 0) * (side === "sellVolume" ? -1 : 1) }) : ({ time: c.t });
    const rows = expanded.rows;
    if (digits.current !== precision.sig || !shown.current) {
      digits.current = precision.sig;
      a.candles.applyOptions({ priceFormat: { type: "custom", formatter: (p: number) => fmtPriceSig(p, digits.current), minMove: precision.minMove } });
    }
    const prev = shown.current?.key === viewKey ? shown.current.list : null;
    const from = prev ? rowTailFrom(prev, rows) : -1;
    if (from >= 0) {
      // A new real swap: update the latest candle's close/high/low/volume, or append the next traded interval.
      for (const c of rows.slice(from)) { a.candles.update(bar(c)); a.buyVolume.update(vol(c, "buyVolume")); a.sellVolume.update(vol(c, "sellVolume")); }
    } else {
      const ts = a.chart.timeScale();
      const range = prev ? ts.getVisibleRange() : null;
      const tracking = prev ? ts.scrollPosition() >= RIGHT_OFFSET - 1 : true;
      a.candles.setData(rows.map(bar));
      a.buyVolume.setData(rows.map((c) => vol(c, "buyVolume")));
      a.sellVolume.setData(rows.map((c) => vol(c, "sellVolume")));
      // First data for this market/timeframe: narrow right-aligned view. Later replacements keep the user's pan/zoom.
      if (!prev || !prev.length) resetView(rows.length);
      else if (tracking) ts.scrollToRealTime();
      else if (range) ts.setVisibleRange(range);
    }
    shown.current = { key: viewKey, list: rows };
  }, [expanded, viewKey, ready, resetView, precision]);

  const fit = useCallback(() => resetView(shown.current?.list.length ?? 0, true), [resetView]);
  const latest = useCallback(() => api.current?.chart.timeScale().scrollToRealTime(), []);

  // ---- status (outside the canvas) ----
  const streaming = h?.live?.state === "streaming";
  const status = ((): { tone: Tone; text: string; retry?: boolean } => {
    if (hist.latest) return { tone: "warn", text: `${hist.latest.error ?? `Latest attempt: ${hist.latest.state}`} · retaining ${h?.swaps ?? 0} verified swaps`, retry: true };
    if (useLive) return { tone: "live", text: `Swaps streamed by PumpPortal · ${list.reduce((n, c) => n + c.buys + c.sells, 0)} swaps` };
    if (!h) return hist.netErr ? { tone: "bad", text: "Market service unreachable · retrying", retry: true } : { tone: "ok", text: "Loading on-chain history…" };
    if (historyOff) return { tone: "warn", text: h.error ?? "On-chain chart history isn't available for this market" };
    const lastSwap = h.newestTs ? `last swap ${ago(h.newestTs * 1000, now)}` : "no swaps yet";
    const head = `${h.marketKind === "amm" ? "PumpSwap" : "Pump.fun"} · ${h.swaps} swaps · ${lastSwap}`;
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
    const gaps = [h.rejectedEvents ? `${h.rejectedEvents} rejected` : "", h.missingTransactions ? `${h.missingTransactions} missing` : "", h.transportFailedTransactions ? `${h.transportFailedTransactions} failed` : ""].filter(Boolean).join(" · ");
    return { tone: streaming ? "live" : h.state === "partial" && !(h.pendingTransactions ?? 0) ? "warn" : "ok", text: `${mode} · ${head}${scanning}${h.refreshing ? " · refreshing" : ""}${gaps ? ` · ${gaps}` : ""}` };
  })();

  const diag = ((): string[] => {
    if (!h || historyOff) return h?.error ? [h.error] : [];
    const out: string[] = [];
    if (gapMode === "compact" && expanded.gaps) out.push(`Compact view: ${expanded.gaps} quiet ${tf} intervals with no verified swaps are compressed so traded candles sit side by side. Each candle keeps its real timestamp and OHLC; nothing is joined or filled. Switch "Gaps" to "Time" for real time spacing.`);
    if (expanded.omitted) out.push(`Time spacing: ${expanded.omitted} older empty interval slots omitted at the 6,000-slot display cap; all verified candles are retained. Blank intervals contain no OHLC or volume; incomplete coverage can also leave blanks.`);
    out.push(`Source: ${h.marketKind === "amm" ? `PumpSwap Buy/Sell events (${h.poolVerified ? "exact on-chain pool and mint verified" : "pool and mint verification pending"}; gross SOL swap notional, excluding separately reported fees)` : "Pump.fun TradeEvents"} decoded from confirmed transactions via free public Solana RPC (read-only; never used for prices or paper orders).`);
    out.push(streaming
      ? `Delivery: live hints from Solana logsSubscribe for this market address, each swap fetched and validated before charting, plus polled catch-up.${h.live?.hintToChartMs != null ? ` Last live swap charted ${(h.live.hintToChartMs / 1000).toFixed(1)}s after its notification (${((h.live.chainToChartMs ?? 0) / 1000).toFixed(1)}s after block time)${h.live.hintToChartMedianMs != null ? `; median ${(h.live.hintToChartMedianMs / 1000).toFixed(1)}s over recent live swaps` : ""}. Every confirmed swap isn't guaranteed to arrive live; the polled catch-up fills misses.` : ""}`
      : `Delivery: polled history (not tick streaming)${h.live?.state && h.live.state !== "off" ? ` — live stream ${h.live.state}${h.live.error ? ` (${h.live.error})` : ""}` : ""}. New swaps can take several seconds to appear.`);
    if (h.oldestTs && h.newestTs) out.push(`Range: verified swaps from ${new Date(h.oldestTs * 1000).toISOString()} to ${new Date(h.newestTs * 1000).toISOString()}.`);
    const b = h.backfill;
    if (b) out.push(b.state === "in_progress" ? `Older history: loading (${b.listedSignatures} of max ${b.maxSignatures} transactions listed).`
      : b.state === "done_start" ? "Older history: complete back to the market address's first transaction."
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
    if (h.marketKind !== "amm" && h.curveStatus && h.curveStatus !== "active") out.push("Curve completed — these are its pre-migration swaps; open the destination market for its separate pool history.");
    if (h.error) out.push(`Last error: ${h.error}`);
    if (h.lastRateLimitAt) out.push(`Last rate limit: ${clock(h.lastRateLimitAt)}.`);
    out.push(`Last RPC contact ${clock(h.lastSuccessAt)}${h.completedAt ? ` · coverage complete ${clock(h.completedAt)}` : ""}.`);
    out.push(`Prices are SOL per token from verified swaps. Market cap / USD view is not offered: it would need a verified historical SOL/USD rate for every candle, which this chart doesn't have.`);
    out.push("Each candle aggregates verified swaps in its interval. Blank slots have no invented OHLC or volume. Buy volume above zero and sell volume below zero use verified swap direction, not candle colour. Missing coverage is not proof an interval had no swaps.");
    return out;
  })();

  const emptyMsg = (() => {
    if (chartError || list.length) return null;
    if (useLive) return live ? <>No swaps observed for this market yet.<br />{live.note}</> : null;
    if (!h) return null;
    if (historyOff) return <>{h.error}</>;
    if (h.state === "empty") return <>No successful swaps found in this market's recent transactions.</>;
    if (h.state === "rate_limited") return <>Waiting for the free Solana RPC to allow more requests…</>;
    if (h.state === "unavailable") return <>On-chain history couldn't be loaded yet. Retrying automatically.</>;
    if (h.state === "partial" && !(h.pendingTransactions ?? 0)) return <>No verified swaps decoded yet — some transactions couldn't be loaded or verified, so this isn't proof the market had none.</>;
    return <>Loading recent swaps…</>;
  })();

  const dot = { live: "bg-up", ok: "bg-muted-foreground", warn: "bg-warn", bad: "bg-down" }[status.tone];

  return (
    <div ref={wrap} className="flex h-full min-h-[320px] flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <div className="scroll-thin flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-x-auto" role="group" aria-label="Timeframe">
          {TIMEFRAMES.map((t) => (
            <Button variant="ghost" size="xs" key={t} onClick={() => setTf(t)} aria-pressed={tf === t}
              className={cn("num shrink-0 rounded px-1.5 py-0.5 text-[11px]", tf === t ? "bg-surface-2 text-primary" : "text-muted-foreground hover:text-foreground")}>
              {t}
            </Button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 border-l border-border pl-1">
          <Button variant="ghost" size="xs" onClick={() => setGapMode((m) => (m === "compact" ? "time" : "compact"))} className="text-[11px] text-muted-foreground"
            aria-label={gapMode === "compact" ? "Quiet intervals compressed; switch to real time spacing" : "Real time spacing; switch to compact traded intervals"}>
            {gapMode === "compact" ? "Gaps: Compact" : "Gaps: Time"}
          </Button>
          <Button variant="ghost" size="xs" onClick={fit} className="text-[11px] text-muted-foreground" aria-label="Fit candles">Fit</Button>
          <Button variant="ghost" size="xs" onClick={latest} className="text-[11px] text-muted-foreground" aria-label="Jump to latest candle">Latest</Button>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-2 border-b border-border px-2 py-1 text-[11px] text-muted-foreground" role="status">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot, status.tone === "live" && "animate-pulse")} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{status.text}</span>
        {status.retry && <Button variant="outline" size="xs" onClick={hist.retry} className="shrink-0">Retry</Button>}
        {diag.length > 0 && (
          <Button variant="ghost" size="xs" onClick={() => setDetails((d) => !d)} aria-expanded={details} className="shrink-0">{details ? "Hide" : "Details"}</Button>
        )}
      </div>
      <div className="num hidden flex-wrap gap-x-3 border-b border-border px-2 py-1 text-[11px] sm:flex" aria-label="Verified swap volume">
        <span className="text-muted-foreground">Volume · available history</span>
        {pressure ? <><span className="text-up">Buy {pressure.buy.toFixed(3)} {quoteCcy}</span><span className="text-down">Sell {pressure.sell.toFixed(3)} {quoteCcy}</span><span className="text-muted-foreground">Buy {((pressure.buy / (pressure.buy + pressure.sell)) * 100).toFixed(1)}%</span></> : <span className="text-muted-foreground">Buy/sell volume unavailable</span>}
        {gapMode === "compact" && expanded.gaps > 0 && <span className="text-warn">{expanded.gaps} quiet intervals compressed</span>}
        {expanded.omitted > 0 && <span className="text-warn">Older time gaps compressed</span>}
      </div>
      {details && diag.length > 0 && (
        <ul className="scroll-thin max-h-40 space-y-0.5 overflow-y-auto border-b border-border px-2 py-1.5 text-[11px] text-muted-foreground">
          {diag.map((d, i) => <li key={i}>{d}</li>)}
        </ul>
      )}
      <div className="relative min-h-[260px] flex-1">
        <div ref={el} className="absolute inset-0" />
        {legend && <Legend t={legend.t} c={legend.c} tf={tf} quoteCcy={quoteCcy} sig={precision.sig} />}
        {gapMode === "compact" && expanded.gaps > 0 && (
          <span className="num pointer-events-none absolute left-2 top-11 z-10 rounded bg-background/70 px-1 text-[10px] text-warn sm:hidden">gaps compressed</span>
        )}
        {chartError && <div role="alert" className="p-6 text-center text-xs text-muted-foreground">Chart failed to load. Refresh to try again.</div>}
        {emptyMsg && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center text-xs text-muted-foreground"><div>{emptyMsg}</div></div>
        )}
      </div>
    </div>
  );
}

function Legend({ t, c, tf, quoteCcy, sig }: { t: number; c: Candle | null; tf: string; quoteCcy: string; sig: number }) {
  const time = new Date(t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: tf.endsWith("s") ? "2-digit" : undefined });
  const tone = c ? (c.c >= c.o ? "text-up" : "text-down") : "text-muted-foreground";
  const chg = c && c.o ? ((c.c - c.o) / c.o) * 100 : null;
  const f = (p: number) => fmtPriceSig(p, sig);
  return (
    <div className="num pointer-events-none absolute left-2 top-1.5 z-10 flex max-w-[calc(100%-5rem)] flex-wrap gap-x-2 gap-y-0 rounded bg-background/70 px-1.5 py-0.5 text-[10.5px] leading-4 backdrop-blur-sm" aria-live="off">
      <span className="text-muted-foreground"><span className="hidden sm:inline">{tf} · {quoteCcy} · </span>{time}</span>
      {c ? (
        <>
          <span className="hidden sm:inline"><span className="text-muted-foreground">O</span> <span className={tone}>{f(c.o)}</span></span>
          <span className="hidden sm:inline"><span className="text-muted-foreground">H</span> <span className={tone}>{f(c.h)}</span></span>
          <span className="hidden sm:inline"><span className="text-muted-foreground">L</span> <span className={tone}>{f(c.l)}</span></span>
          <span><span className="text-muted-foreground">C</span> <span className={tone}>{f(c.c)}</span></span>
          {chg != null && <span className={tone}>{chg >= 0 ? "+" : ""}{chg.toFixed(2)}%</span>}
          <span><span className="text-muted-foreground">Vol</span> {c.v.toFixed(3)}</span>
          {c.buyVolume != null && c.sellVolume != null && <span className="hidden sm:inline"><span className="text-up">B {c.buyVolume.toFixed(3)}</span> <span className="text-down">S {c.sellVolume.toFixed(3)}</span></span>}
          <span className="text-muted-foreground">{c.buys + c.sells} swaps</span>
        </>
      ) : <span className="text-muted-foreground">no verified swaps recorded in this interval</span>}
    </div>
  );
}
