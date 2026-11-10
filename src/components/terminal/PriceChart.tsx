import { useEffect, useRef, useState } from "react";
import { feed } from "@/lib/feed/client";
import type { Candle, ChartHistory } from "@/lib/feed/types";
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

export function PriceChart({ marketId, quoteCcy, tick }: { marketId: string; quoteCcy: string; tick: number }) {
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<{ chart: any; candles: any; volume: any } | null>(null);
  const [tf, setTf] = useState<(typeof TIMEFRAMES)[number]>("1m");
  const [hist, setHist] = useState<ChartHistory | null>(null);
  const [histNetErr, setHistNetErr] = useState(false);
  const [histTick, setHistTick] = useState(0);
  const drewHist = useRef(false);
  const [count, setCount] = useState<number | null>(null);
  const [note, setNote] = useState<string>("");
  const [ready, setReady] = useState(false);
  const [chartError, setChartError] = useState(false);
  const fitted = useRef(false);

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
      const candles = chart.addSeries(lc.CandlestickSeries, {
        upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
        priceFormat: { type: "custom", formatter: (p: number) => fmtPrice(p, ""), minMove: 1e-12 },
      });
      const volume = chart.addSeries(lc.HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" } });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      api.current = { chart, candles, volume };
      setReady(true);
    }).catch(() => {
      if (!disposed) setChartError(true);
    });
    return () => { disposed = true; api.current?.chart.remove(); api.current = null; };
  }, []);

  useEffect(() => { fitted.current = false; }, [tf, marketId]);

  const draw = (list: Candle[]) => {
    if (!api.current) return;
    const up = cssVar("--up"), down = cssVar("--down");
    api.current.candles.setData(list.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c })));
    api.current.volume.setData(list.map((c) => ({ time: c.t, value: c.v, color: (c.c >= c.o ? up : down) + "88" })));
    if (!fitted.current && list.length) { api.current.chart.timeScale().fitContent(); fitted.current = true; }
  };

  useEffect(() => { setHist(null); setHistNetErr(false); drewHist.current = false; }, [marketId]);
  useEffect(() => { drewHist.current = false; }, [tf]);

  // Live candles (non-1m timeframes) from swaps the worker streams.
  useEffect(() => {
    if (!ready || tf === "1m") return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const res = await feed.candles(marketId, tf);
      if (cancelled || !res || !api.current) return;
      setCount(res.candles.length);
      setNote(res.note);
      draw(res.candles);
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [marketId, tf, tick, ready]);

  // 1m: on-chain history, polled while the chart is open. Failed polls keep the last good candles.
  useEffect(() => {
    if (!ready || tf !== "1m") return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const res = await feed.history(marketId);
      if (cancelled) return;
      if (!res) { setHistNetErr(true); }
      else {
        setHistNetErr(false);
        setHist((prev) => (res.candles.length || !prev?.candles.length ? res : { ...res, candles: prev.candles }));
        if (res.candles.length) { draw(res.candles); drewHist.current = true; }
        else if (!drewHist.current) draw([]);
      }
      const busy = !res || res.state === "loading" || res.refreshing;
      setTimeout(() => { if (!cancelled) setHistTick((n) => n + 1); }, busy ? 4000 : 15000);
    }, histTick === 0 ? 100 : 0);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketId, tf, ready, histTick]);

  const time = (ms: number | null) => (ms ? new Date(ms).toLocaleTimeString() : "never");
  const histLabel = (() => {
    if (tf !== "1m") return null;
    if (histNetErr) return { tone: "warn", text: `Market service unreachable · showing last data (${time(hist?.fetchedAt ?? null)})` };
    if (!hist) return { tone: "muted", text: "Loading on-chain history…" };
    const base = `Source: Solana RPC · Pump trade events · ${hist.swaps} swaps · updated ${time(hist.fetchedAt)}${hist.refreshing ? " · refreshing…" : ""}`;
    if (hist.state === "rate_limited") return { tone: "warn", text: `Rate limited by Solana RPC — retrying shortly · ${hist.candles.length ? "showing last data · " : ""}${base}` };
    if (hist.state === "unavailable") return { tone: "warn", text: `On-chain history unavailable right now · ${hist.candles.length ? "showing last data · " : ""}${base}` };
    if (hist.state === "unsupported") return { tone: "muted", text: hist.error ?? "On-chain history not available for this market." };
    if (hist.state === "loading") return { tone: "muted", text: "Loading recent swaps from Solana RPC…" };
    return { tone: "muted", text: base };
  })();
  const histEmpty = tf === "1m" && hist && !hist.candles.length && !histNetErr;

  return (
    <div className="flex h-full min-h-[320px] flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        {TIMEFRAMES.map((t) => (
          <button key={t} onClick={() => setTf(t)} aria-pressed={tf === t}
            className={cn("num rounded px-1.5 py-0.5 text-[11px]", tf === t ? "bg-surface-2 text-primary" : "text-muted-foreground hover:text-foreground")}>
            {t}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-muted-foreground">Price in {quoteCcy} · scroll to zoom, drag to pan</span>
      </div>
      <div className="relative min-h-[280px] flex-1">
        <div ref={el} className="absolute inset-0" />
        {chartError && <div role="status" className="p-6 text-center text-xs text-muted-foreground">Chart failed to load. Refresh to try again.</div>}
        {histLabel && (
          <div role="status" className={cn("pointer-events-none absolute left-2 top-1 z-10 max-w-[90%] text-[10px]", histLabel.tone === "warn" ? "text-down" : "text-muted-foreground")}>
            {histLabel.text}
          </div>
        )}
        {!chartError && histEmpty && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center text-xs text-muted-foreground">
            <div>
              {hist!.state === "empty" ? <>No successful swaps found in this curve's recent transactions.</>
                : hist!.state === "rate_limited" ? <>Solana RPC is rate limiting requests. Candles will appear once it allows more.</>
                : hist!.state === "unavailable" ? <>On-chain history could not be loaded. Retrying automatically.</>
                : hist!.state === "unsupported" ? <>{hist!.error}</>
                : <>Loading recent swaps…</>}
            </div>
          </div>
        )}
        {!chartError && tf !== "1m" && count === 0 && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center text-xs text-muted-foreground">
            <div>No swaps observed for this market yet.<br />{note}</div>
          </div>
        )}
      </div>
    </div>
  );
}
