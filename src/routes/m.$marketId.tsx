import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useFeed } from "@/lib/feed/client";
import { marketUsd, quoteUsd, type MarketSummary } from "@/lib/feed/types";
import { fmtAge, fmtCompact, fmtPrice, fmtQty, shortAddr } from "@/lib/format";
import { SetupState } from "@/components/terminal/AppShell";
import { CopyButton, Delta, ExplorerLink, FeedBadge, StatusDot, TokenAvatar } from "@/components/terminal/bits";
import { PriceChart } from "@/components/terminal/PriceChart";
import { OrderTicket } from "@/components/terminal/OrderTicket";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/m/$marketId")({
  head: () => ({
    meta: [
      { title: "Token terminal — bondfire" },
      { name: "description", content: "Live chart, swap tape and paper order ticket for a Solana meme-coin market." },
      { property: "og:title", content: "Token terminal — bondfire" },
      { property: "og:description", content: "Live candles from real swaps and a paper order ticket." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Terminal,
});

function Terminal() {
  const { marketId } = Route.useParams();
  const feed = useFeed(`market:${marketId}`);
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState<"loading" | "ok" | "missing">("loading");
  const [mobileTab, setMobileTab] = useState<"chart" | "tape" | "trade">("chart");

  useEffect(() => {
    if (!feed.workerUrl) return;
    setLoaded("loading");
    feed.loadMarket(marketId).then((m) => setLoaded(m ? "ok" : "missing"));
  }, [marketId, feed.workerUrl, feed]);

  const m = feed.markets.get(marketId);
  if (feed.status === "setup") return <SetupState reason={feed.setupReason} />;
  if (!m) {
    return (
      <div className="grid h-full place-items-center p-6 text-sm text-muted-foreground">
        {loaded === "missing" ? "This market isn't tracked by the live service (it may have been evicted or never observed)." : "Loading market…"}
      </div>
    );
  }
  const tape = feed.tapes.get(marketId) ?? [];
  const u = marketUsd(m, feed.reference);
  const siblings = [...feed.markets.values()].filter((x) => x.mint === m.mint);
  const dest = m.migratedTo ? feed.markets.get(m.migratedTo) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <TokenAvatar m={m} size={32} />
          <div>
            <div className="flex items-center gap-1.5">
              <h1 className="font-semibold">{m.symbol}</h1>
              <span className="text-xs text-muted-foreground">{m.name}</span>
              <FeedBadge m={m} />
            </div>
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <span>{m.chain}</span>·<span>mint {shortAddr(m.mint)}</span><CopyButton value={m.mint} label="mint" /><ExplorerLink address={m.mint} kind="token" />
              <span>· {m.kind === "curve" ? "curve" : "pool"} {shortAddr(m.address)}</span><CopyButton value={m.address} label="market address" /><ExplorerLink address={m.address} />
            </div>
          </div>
        </div>
        <div>
          <div className="num text-lg font-semibold">{fmtPrice(u.priceUsd)}</div>
          <div className="num text-[11px] text-muted-foreground">{fmtPrice(m.priceQuote, "")} {m.quoteCcy}</div>
        </div>
        <Stats m={m} u={u} />
        <div className="ml-auto flex items-center gap-2 text-xs">
          <label className="flex items-center gap-1 text-muted-foreground">Pool
            <select value={m.id} onChange={(e) => navigate({ to: "/m/$marketId", params: { marketId: e.target.value } })} className="rounded border border-border bg-surface px-1 py-0.5 text-foreground">
              {siblings.map((s) => <option key={s.id} value={s.id}>{s.venue} · {s.kind === "curve" ? "curve" : "pool"} · {s.quoteCcy}{s.status !== "active" ? ` (${s.status})` : ""}</option>)}
            </select>
          </label>
          <StatusDot status={feed.status} lastAt={feed.lastMessageAt} />
        </div>
      </div>

      {m.status === "migrated" && (
        <div className="flex items-center gap-2 border-b border-border bg-paper px-3 py-1.5 text-xs text-paper-foreground">
          This bonding curve completed and migrated. Its history stays here; new trading happens on the destination pool.
          {dest ? (
            <Link to="/m/$marketId" params={{ marketId: dest.id }} className="inline-flex items-center gap-1 font-semibold underline">Open {dest.venue} pool <ArrowRight className="h-3 w-3" /></Link>
          ) : <span>Destination pool is being verified…</span>}
        </div>
      )}

      <div className="flex border-b border-border lg:hidden" role="tablist">
        {(["chart", "tape", "trade"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={mobileTab === t} onClick={() => setMobileTab(t)} className={cn("flex-1 py-2 text-xs capitalize", mobileTab === t ? "border-b-2 border-primary" : "text-muted-foreground")}>{t}</button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_300px] lg:grid-rows-[1fr_240px]">
        <div className={cn("min-h-[320px] border-border lg:border-r lg:border-b", mobileTab !== "chart" && "hidden lg:block")}>
          <PriceChart marketId={m.id} quoteCcy={m.quoteCcy} tick={tape[0]?.receivedAt ?? 0} />
        </div>
        <aside className={cn("scroll-thin overflow-y-auto border-border lg:row-span-2", mobileTab !== "trade" && "hidden lg:block")}>
          <OrderTicket m={m} reference={feed.reference} />
        </aside>
        <div className={cn("flex min-h-0 flex-col border-border lg:border-r", mobileTab !== "tape" && "hidden lg:flex")}>
          <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs">
            <span className="font-semibold">Live swaps</span>
            <span className="text-muted-foreground">public on-chain trades · not your paper fills</span>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-background text-left text-muted-foreground">
                <tr><th className="px-2 py-1 font-normal">Age</th><th className="font-normal">Side</th><th className="text-right font-normal">Price</th><th className="text-right font-normal">{m.symbol}</th><th className="text-right font-normal">{m.quoteCcy}</th><th className="px-2 text-right font-normal">Tx</th></tr>
              </thead>
              <tbody>
                {tape.length === 0 && <tr><td colSpan={6} className="p-3 text-muted-foreground">{m.tradeFeed === "live" ? "Waiting for the next swap…" : "Live swaps unavailable for this market."}</td></tr>}
                {tape.map((t) => (
                  <tr key={t.id} className="row-in border-b border-border/40">
                    <td className="num px-2 py-1 text-muted-foreground">{fmtAge(t.receivedAt)}</td>
                    <td className={t.side === "buy" ? "text-up" : "text-down"}>{t.side}</td>
                    <td className="num text-right">{fmtPrice(quoteUsd(feed.reference, t.quoteCcy) ? t.priceQuote * quoteUsd(feed.reference, t.quoteCcy)! : null)}</td>
                    <td className="num text-right">{fmtQty(t.baseQty)}</td>
                    <td className="num text-right">{t.quoteQty.toFixed(3)}</td>
                    <td className="px-2 text-right"><a className="text-muted-foreground hover:text-foreground" href={`https://solscan.io/tx/${t.signature}`} target="_blank" rel="noreferrer">{t.signature.slice(0, 6)}</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stats({ m, u }: { m: MarketSummary; u: ReturnType<typeof marketUsd> }) {
  const s = m.stats;
  const cell = (label: string, v: React.ReactNode) => (
    <div className="flex flex-col"><span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span><span className="num text-xs">{v}</span></div>
  );
  return (
    <div className="flex flex-wrap gap-4">
      {cell("5m", <Delta v={s?.["5m"].changePct} />)}
      {cell("1h", <Delta v={s?.["1h"].changePct} />)}
      {cell("24h", <Delta v={s?.["24h"].changePct} />)}
      {cell("Mkt cap", fmtCompact(u.mcapUsd))}
      {cell("FDV", fmtCompact(u.fdvUsd))}
      {cell("Liquidity", fmtCompact(u.liquidityUsd))}
      {cell("Vol 1h", fmtCompact(u.volUsd("1h")))}
      {cell("B/S 1h", <><span className="text-up">{s?.["1h"].buys ?? 0}</span>/<span className="text-down">{s?.["1h"].sells ?? 0}</span></>)}
      {m.curveProgress != null && cell("Curve", `${(m.curveProgress * 100).toFixed(1)}%`)}
    </div>
  );
}
