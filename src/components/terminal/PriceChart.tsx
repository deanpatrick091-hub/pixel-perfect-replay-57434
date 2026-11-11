import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { feed } from "@/lib/feed/client";
import type { Candle, ChartHistory } from "@/lib/feed/types";
import { useChartHistory } from "@/lib/feed/useChartHistory";
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

const fetchHistory = (id: string, tf: string, signal: AbortSignal) => feed.history(id, tf, signal);
const clock = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleTimeString() : "never");

export function PriceChart({ marketId, quoteCcy, tick, liveTrades }: { marketId: string; quoteCcy: string; tick: number; liveTrades: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<{ chart: any; candles: any; volume: any; up: string; down: string } | null>(null);
  const [tf, setTf] = useState<(typeof TIMEFRAMES)[number]>("1m");
  const [ready, setReady] = useState(false);
  const [chartError, setChartError] = useState(false);
  const [visible, setVisible] = useState(false);
  const [live, setLive] = useState<{ candles: Candle[]; note: string } | null>(null);
  const fitted = useRef<string | null>(null);

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
        grid: { vertLines: { color: border }, horzLines: { color: border } },
        rightPriceScale: { borderColor: border },
        timeScale: { borderColor: border, timeVisible: true, secondsVisible: true },
        crosshair: { mode: lc.CrosshairMode.Normal },
        localization: { priceFormatter: (p: number) => fmtPrice(p, "") },
      });
      const up = cssVar("--up"), down = cssVar("--down");
      // Close >= open is bullish (green), close < open bearish (red); body, border and wick all follow.
      const candles = chart.addSeries(lc.CandlestickSeries, {
        upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
        priceFormat: { type: "custom", formatter: (p: number) => fmtPrice(p, ""), minMove: 1e-12 },
      });
      const volume = chart.addSeries(lc.HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" } });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      api.current = { chart, candles, volume, up, down };
      setReady(true);
    }).catch(() => { if (!disposed) setChartError(true); });
    return () => { disposed = true; api.current?.chart.remove(); api.current = null; };
  }, []);

  const hist = useChartHistory(marketId, tf, fetchHistory, ready && visible);
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

  useEffect(() => {
    const a = api.current;
    if (!a) return;
    a.candles.setData(list.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c })));
    a.volume.setData(list.map((c) => ({ time: c.t, value: c.v, color: (c.c >= c.o ? a.up : a.down) + "88" })));
    // Fit once per market/timeframe; later refreshes keep the user's pan/zoom.
    if (list.length && fitted.current !== viewKey) { a.chart.timeScale().fitContent(); fitted.current = viewKey; }
  }, [list, viewKey, ready]);

  const fit = useCallback(() => api.current?.chart.timeScale().fitContent(), []);
  const latest = useCallback(() => api.current?.chart.timeScale().scrollToRealTime(), []);

  const label = (() => {
    if (useLive) return { tone: "muted", text: `Source: swaps streamed live to this worker · ${live?.note ?? ""}` };
    if (!h) return hist.netErr ? { tone: "warn", text: "Market service unreachable · retrying" } : { tone: "muted", text: "Loading on-chain history…" };
    if (historyOff) return { tone: "muted", text: h.error ?? "On-chain history not available for this market." };
    const range = h.oldestTs && h.newestTs ? ` · swaps ${new Date(h.oldestTs * 1000).toLocaleTimeString()}–${new Date(h.newestTs * 1000).toLocaleTimeString()}` : "";
    const base = `Polled history (not tick streaming) · Solana RPC · Pump trade events · ${h.swaps} swaps${range} · last RPC success ${clock(h.lastSuccessAt)}`;
    const stale = hist.netErr ? `Market service unreachable · showing snapshot from ${clock(h.lastSuccessAt)} · ` : "";
    const curve = h.curveStatus && h.curveStatus !== "active" ? "Curve completed — these are its pre-migration swaps; the destination pool isn't charted · " : "";
    const gap = h.missingTransactions ? ` · ${h.missingTransactions} transactions unavailable from RPC` : "";
    if (h.state === "rate_limited") return { tone: "warn", text: `${stale}${curve}Rate limited by Solana RPC — retrying · ${base}${gap}` };
    if (h.state === "unavailable") return { tone: "warn", text: `${stale}${curve}Solana RPC request failed — retrying · ${base}${gap}` };
    if (h.state === "loading") return { tone: "muted", text: "Loading recent swaps from Solana RPC…" };
    if (h.state === "partial") return { tone: hist.netErr ? "warn" : "muted", text: `${stale}${curve}Scanning · ${h.pendingTransactions ?? 0} transactions left · ${base}${gap}` };
    return { tone: hist.netErr ? "warn" : "muted", text: `${stale}${curve}${base} · scan complete ${clock(h.completedAt)}${gap}` };
  })();

  const emptyMsg = (() => {
    if (chartError || list.length) return null;
    if (useLive) return live ? <>No swaps observed for this market yet.<br />{live.note}</> : null;
    if (!h) return null;
    if (historyOff) return <>{h.error}</>;
    if (h.state === "empty") return <>No successful swaps found in this curve's {h.windowSignatures ?? "recent"} most recent transactions.</>;
    if (h.state === "rate_limited") return <>Solana RPC is rate limiting requests. Candles appear once it allows more.</>;
    if (h.state === "unavailable") return <>On-chain history could not be loaded. Retrying automatically.</>;
    return <>Loading recent swaps…</>;
  })();

  return (
    <div ref={wrap} className="flex h-full min-h-[320px] flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        {TIMEFRAMES.map((t) => (
          <button key={t} onClick={() => setTf(t)} aria-pressed={tf === t}
            className={cn("num rounded px-1.5 py-0.5 text-[11px]", tf === t ? "bg-surface-2 text-primary" : "text-muted-foreground hover:text-foreground")}>
            {t}
          </button>
        ))}
        <button onClick={fit} className="ml-2 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" aria-label="Fit all candles">Fit</button>
        <button onClick={latest} className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" aria-label="Jump to latest candle">Latest</button>
        <span className="ml-auto text-[11px] text-muted-foreground">Price in {quoteCcy} · scroll to zoom, drag to pan</span>
      </div>
      <div className="relative min-h-[280px] flex-1">
        <div ref={el} className="absolute inset-0" />
        {chartError && <div role="status" className="p-6 text-center text-xs text-muted-foreground">Chart failed to load. Refresh to try again.</div>}
        {label && !chartError && (
          <div role="status" className={cn("pointer-events-none absolute left-2 top-1 z-10 max-w-[90%] text-[10px]", label.tone === "warn" ? "text-down" : "text-muted-foreground")}>
            {label.text}
          </div>
        )}
        {emptyMsg && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center text-xs text-muted-foreground"><div>{emptyMsg}</div></div>
        )}
      </div>
    </div>
  );
}
