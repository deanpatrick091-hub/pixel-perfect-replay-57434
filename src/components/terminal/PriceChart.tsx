import { useEffect, useRef, useState } from "react";
import { feed } from "@/lib/feed/client";
import type { Candle } from "@/lib/feed/types";
import { fmtPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

export const TIMEFRAMES = ["1s", "5s", "15s", "1m", "5m", "15m", "1h", "4h", "1D"] as const;

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function PriceChart({ marketId, quoteCcy, tick }: { marketId: string; quoteCcy: string; tick: number }) {
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<{ chart: any; candles: any; volume: any } | null>(null);
  const [tf, setTf] = useState<(typeof TIMEFRAMES)[number]>("15s");
  const [count, setCount] = useState<number | null>(null);
  const [note, setNote] = useState<string>("");
  const fitted = useRef(false);

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
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
      ro = new ResizeObserver(() => {});
    });
    return () => { disposed = true; ro?.disconnect(); api.current?.chart.remove(); api.current = null; };
  }, []);

  useEffect(() => { fitted.current = false; }, [tf, marketId]);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const res = await feed.candles(marketId, tf);
      if (cancelled || !res || !api.current) return;
      setCount(res.candles.length);
      setNote(res.note);
      const up = cssVar("--up"), down = cssVar("--down");
      api.current.candles.setData(res.candles.map((c: Candle) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c })));
      api.current.volume.setData(res.candles.map((c: Candle) => ({ time: c.t, value: c.v, color: (c.c >= c.o ? up : down) + "88" })));
      if (!fitted.current && res.candles.length) { api.current.chart.timeScale().fitContent(); fitted.current = true; }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [marketId, tf, tick]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        {TIMEFRAMES.map((t) => (
          <button key={t} onClick={() => setTf(t)} aria-pressed={tf === t}
            className={cn("num rounded px-1.5 py-0.5 text-[11px]", tf === t ? "bg-surface-2 text-primary" : "text-muted-foreground hover:text-foreground")}>
            {t}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-muted-foreground">Price in {quoteCcy} · scroll to zoom, drag to pan</span>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={el} className="absolute inset-0" />
        {count === 0 && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center text-xs text-muted-foreground">
            <div>No swaps observed for this market yet.<br />{note}</div>
          </div>
        )}
      </div>
    </div>
  );
}
