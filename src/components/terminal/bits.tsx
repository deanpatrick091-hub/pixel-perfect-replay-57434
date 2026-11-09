import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FeedStatus, MarketSummary } from "@/lib/feed/types";

export function TokenAvatar({ m, size = 28 }: { m: Pick<MarketSummary, "imageUri" | "symbol">; size?: number }) {
  const [err, setErr] = useState(false);
  const letter = (m.symbol ?? "?").slice(0, 2).toUpperCase();
  if (!m.imageUri || err)
    return (
      <div style={{ width: size, height: size }} className="grid shrink-0 place-items-center rounded bg-surface-2 text-[10px] font-semibold text-muted-foreground">
        {letter}
      </div>
    );
  return (
    <img src={m.imageUri} alt="" loading="lazy" onError={() => setErr(true)} style={{ width: size, height: size }} className="shrink-0 rounded bg-surface-2 object-cover" />
  );
}

export function PaperBadge({ className }: { className?: string }) {
  return (
    <span className={cn("rounded-sm bg-paper px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-paper-foreground", className)}>
      Paper Trading
    </span>
  );
}

const STATUS: Record<FeedStatus, { label: string; cls: string }> = {
  checking: { label: "Checking", cls: "bg-muted-foreground" },
  setup: { label: "Not connected", cls: "bg-warn" },
  connecting: { label: "Connecting", cls: "bg-warn pulse-dot" },
  connected: { label: "Live", cls: "bg-up pulse-dot" },
  reconnecting: { label: "Reconnecting", cls: "bg-warn pulse-dot" },
  stale: { label: "Stale", cls: "bg-down" },
};

export function StatusDot({ status, lastAt }: { status: FeedStatus; lastAt?: number }) {
  const s = STATUS[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title={lastAt ? `Last update ${new Date(lastAt).toLocaleTimeString()}` : undefined}>
      <span className={cn("h-1.5 w-1.5 rounded-full", s.cls)} />
      {s.label}
    </span>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); });
      }}
      className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {done ? <Check className="h-3 w-3 text-up" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

export function ExplorerLink({ address, kind = "account" }: { address: string; kind?: "account" | "token" | "tx" }) {
  const href = `https://solscan.io/${kind}/${address}`;
  return (
    <a href={href} target="_blank" rel="noreferrer" aria-label="Open in Solscan" className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

export function Delta({ v, className }: { v: number | null | undefined; className?: string }) {
  if (v == null || !Number.isFinite(v)) return <span className={cn("num text-muted-foreground", className)}>—</span>;
  return <span className={cn("num", v > 0 ? "text-up" : v < 0 ? "text-down" : "text-muted-foreground", className)}>{`${v > 0 ? "+" : ""}${v.toFixed(Math.abs(v) >= 100 ? 0 : 1)}%`}</span>;
}

export function FeedBadge({ m }: { m: Pick<MarketSummary, "tradeFeed" | "status"> }) {
  if (m.status === "migrated") return <span className="rounded-sm bg-surface-2 px-1 text-[10px] text-muted-foreground">Migrated</span>;
  if (m.tradeFeed === "live") return null;
  return (
    <span className="rounded-sm bg-surface-2 px-1 text-[10px] text-warn" title="No live swap source for this market; paper execution disabled">
      {m.tradeFeed === "unverified" ? "Swaps unverified" : "Trades unavailable"}
    </span>
  );
}
