import { memo, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { fmtAge, fmtCompact, fmtPrice } from "@/lib/format";
import { marketUsd, type MarketSummary, type Reference } from "@/lib/feed/types";
import { CopyButton, FeedBadge, TokenAvatar } from "./bits";

function useFlash(v: number | null) {
  const prev = useRef(v);
  const [cls, setCls] = useState("");
  useEffect(() => {
    if (prev.current != null && v != null && v !== prev.current) {
      setCls(v > prev.current ? "flash-up" : "flash-down");
      const t = setTimeout(() => setCls(""), 900);
      prev.current = v;
      return () => clearTimeout(t);
    }
    prev.current = v;
  }, [v]);
  return cls;
}

export const MarketRow = memo(function MarketRow({ m, reference, now }: { m: MarketSummary; reference: Reference | null; now: number }) {
  const u = marketUsd(m, reference);
  const flash = useFlash(m.priceQuote);
  const s = m.stats?.["5m"];
  return (
    <Link
      to="/m/$marketId"
      params={{ marketId: m.id }}
      className={cn("row-in group flex gap-2 border-b border-border/60 px-2 py-2 hover:bg-surface-2", flash)}
    >
      <TokenAvatar m={m} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-semibold">{m.symbol ?? "—"}</span>
          <span className="truncate text-xs text-muted-foreground">{m.name}</span>
          <CopyButton value={m.mint} label="mint address" />
          <span className="ml-auto num text-xs text-muted-foreground">{fmtAge(m.launchedAt, now)}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="text-foreground/70">{m.venue}</span>
          <span>MC <b className="num font-medium text-foreground">{fmtCompact(u.mcapUsd)}</b></span>
          <span>V <b className="num font-medium text-foreground">{fmtCompact(u.volUsd("5m"))}</b></span>
          <span>L <b className="num font-medium text-foreground">{fmtCompact(u.liquidityUsd)}</b></span>
          <span className="num"><span className="text-up">{s?.buys ?? 0}</span>/<span className="text-down">{s?.sells ?? 0}</span></span>
          <span className="num">{fmtPrice(u.priceUsd)}</span>
          <FeedBadge m={m} />
        </div>
        {m.curveProgress != null && m.status === "active" && (
          <div className="mt-1 flex items-center gap-1.5">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full bg-primary" style={{ width: `${(m.curveProgress * 100).toFixed(1)}%` }} />
            </div>
            <span className="num text-[10px] text-muted-foreground">{(m.curveProgress * 100).toFixed(0)}%</span>
          </div>
        )}
      </div>
    </Link>
  );
});
