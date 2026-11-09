import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { SlidersHorizontal } from "lucide-react";
import { useFeed } from "@/lib/feed/client";
import { marketUsd, type MarketSummary } from "@/lib/feed/types";
import { SetupState } from "@/components/terminal/AppShell";
import { MarketRow } from "@/components/terminal/MarketRow";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Discover — bondfire paper trading terminal" },
      { name: "description", content: "Watch new Solana meme-coin launches stream in live and practise trading them with virtual cash." },
      { property: "og:title", content: "bondfire — live meme-coin discovery, paper trades" },
      { property: "og:description", content: "Real launches, real swaps, simulated trades. Practise with $10,000 in virtual cash." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Discover,
});

type Sort = "newest" | "mcap" | "volume" | "progress";
interface Filters { venue: string; maxAgeMin: number; minLiq: number; minMcap: number; minVol: number }
const DEFAULT_FILTERS: Filters = { venue: "all", maxAgeMin: 0, minLiq: 0, minMcap: 0, minVol: 0 };
const COLS = [
  { key: "new", title: "New Pairs" },
  { key: "final_stretch", title: "Final Stretch" },
  { key: "migrated", title: "Migrated" },
] as const;

function usePersisted<T>(key: string, init: T) {
  const [v, setV] = useState<T>(init);
  useEffect(() => {
    try { const s = localStorage.getItem(key); if (s) setV({ ...init, ...JSON.parse(s) }); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = (n: T) => { setV(n); try { localStorage.setItem(key, JSON.stringify(n)); } catch {} };
  return [v, set] as const;
}

function Discover() {
  const feed = useFeed("discovery");
  const [filters, setFilters] = usePersisted<Filters>("bf.discover.filters", DEFAULT_FILTERS);
  const [sorts, setSorts] = usePersisted<Record<string, Sort>>("bf.discover.sorts", { new: "newest", final_stretch: "progress", migrated: "newest" });
  const [showFilters, setShowFilters] = useState(false);
  const [mobileCol, setMobileCol] = useState<string>("new");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const cols = useMemo(() => {
    const out: Record<string, MarketSummary[]> = { new: [], final_stretch: [], migrated: [] };
    const all = [...feed.markets.values()];
    const hasAmm = new Set(all.filter((m) => m.kind === "amm").map((m) => m.migratedFrom));
    for (const m of all) {
      if (m.kind === "curve" && m.status === "migrated" && hasAmm.has(m.id)) continue; // show the destination pool instead
      const u = marketUsd(m, feed.reference);
      if (filters.venue !== "all" && m.venue !== filters.venue) continue;
      if (filters.maxAgeMin && now - m.launchedAt > filters.maxAgeMin * 60_000) continue;
      if (filters.minLiq && (u.liquidityUsd ?? 0) < filters.minLiq) continue;
      if (filters.minMcap && (u.mcapUsd ?? 0) < filters.minMcap) continue;
      if (filters.minVol && (u.volUsd("1h") ?? 0) < filters.minVol) continue;
      (out[m.stage] ??= []).push(m);
    }
    for (const k of Object.keys(out)) {
      const s = sorts[k] ?? "newest";
      const key = (m: MarketSummary) => {
        const u = marketUsd(m, feed.reference);
        return s === "newest" ? m.launchedAt : s === "mcap" ? u.mcapUsd ?? 0 : s === "volume" ? u.volUsd("1h") ?? 0 : m.curveProgress ?? 0;
      };
      out[k] = (out[k] ?? []).sort((a, b) => key(b) - key(a)).slice(0, 150);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed.version, filters, sorts, Math.floor(now / 5000)]);

  if (feed.status === "setup" || (feed.status === "checking" && !feed.markets.size)) return <SetupState reason={feed.setupReason} />;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <h1 className="text-sm font-semibold">Pulse</h1>
        <span className="text-xs text-muted-foreground">Solana · pump.fun launches, curves &amp; migrations</span>
        <button onClick={() => setShowFilters((v) => !v)} className={cn("ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-accent", showFilters && "bg-accent")} aria-expanded={showFilters}>
          <SlidersHorizontal className="h-3.5 w-3.5" /> Filters
        </button>
      </div>
      {showFilters && <FilterBar f={filters} onChange={setFilters} />}
      <div className="flex border-b border-border md:hidden" role="tablist">
        {COLS.map((c) => (
          <button key={c.key} role="tab" aria-selected={mobileCol === c.key} onClick={() => setMobileCol(c.key)}
            className={cn("flex-1 py-2 text-xs", mobileCol === c.key ? "border-b-2 border-primary text-foreground" : "text-muted-foreground")}>
            {c.title} <span className="num">{cols[c.key]?.length ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 md:grid-cols-3">
        {COLS.map((c) => (
          <section key={c.key} className={cn("flex min-h-0 flex-col border-border md:border-r md:last:border-r-0", mobileCol !== c.key && "hidden md:flex")}>
            <div className="hidden items-center gap-2 border-b border-border px-2 py-1.5 md:flex">
              <h2 className="text-xs font-semibold">{c.title}</h2>
              <span className="num text-xs text-muted-foreground">{cols[c.key]?.length ?? 0}</span>
              <select aria-label={`Sort ${c.title}`} value={sorts[c.key]} onChange={(e) => setSorts({ ...sorts, [c.key]: e.target.value as Sort })}
                className="ml-auto rounded border border-border bg-surface px-1 py-0.5 text-[11px]">
                <option value="newest">Newest</option>
                <option value="mcap">Market cap</option>
                <option value="volume">Volume 1h</option>
                <option value="progress">Curve progress</option>
              </select>
            </div>
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto [overflow-anchor:auto]">
              {!cols[c.key]?.length ? (
                <p className="p-4 text-xs text-muted-foreground">
                  {c.key === "new" ? "Waiting for the next launch…" : c.key === "final_stretch" ? "No curve is past the Final Stretch threshold yet. Curve progress updates only for markets with live swaps." : "No verified migrations observed since the service started."}
                </p>
              ) : (
                cols[c.key]!.map((m) => <MarketRow key={m.id} m={m} reference={feed.reference} now={now} />)
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function FilterBar({ f, onChange }: { f: Filters; onChange: (f: Filters) => void }) {
  const field = "rounded border border-border bg-surface px-1.5 py-1 text-xs num w-24";
  return (
    <div className="flex flex-wrap items-end gap-3 border-b border-border bg-surface px-3 py-2 text-xs">
      <label className="flex flex-col gap-1">Venue
        <select className={field} value={f.venue} onChange={(e) => onChange({ ...f, venue: e.target.value })}>
          <option value="all">All</option><option value="pumpfun">pump.fun</option><option value="pumpswap">PumpSwap</option>
        </select>
      </label>
      <label className="flex flex-col gap-1">Max age
        <select className={field} value={f.maxAgeMin} onChange={(e) => onChange({ ...f, maxAgeMin: Number(e.target.value) })}>
          <option value={0}>Any</option><option value={5}>5m</option><option value={60}>1h</option><option value={1440}>24h</option>
        </select>
      </label>
      {(["minLiq", "minMcap", "minVol"] as const).map((k) => (
        <label key={k} className="flex flex-col gap-1">{k === "minLiq" ? "Min liquidity $" : k === "minMcap" ? "Min market cap $" : "Min volume 1h $"}
          <input type="number" min={0} className={field} value={f[k] || ""} placeholder="0" onChange={(e) => onChange({ ...f, [k]: Number(e.target.value) || 0 })} />
        </label>
      ))}
      <button className="rounded px-2 py-1 text-muted-foreground hover:bg-accent" onClick={() => onChange(DEFAULT_FILTERS)}>Reset</button>
    </div>
  );
}
