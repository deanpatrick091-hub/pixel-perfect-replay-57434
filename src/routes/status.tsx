import type { ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFeed } from "@/lib/feed/client";
import { StatusDot } from "@/components/terminal/bits";
import { fmtAge } from "@/lib/format";

export const Route = createFileRoute("/status")({
  head: () => ({
    meta: [
      { title: "Coverage & feed status — bondfire" },
      { name: "description", content: "Which Solana launchpads and pools are live, and the health of the market data feed." },
      { property: "og:title", content: "Market coverage — bondfire" },
      { property: "og:description", content: "Supported markets, live feed status and setup steps." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Status,
});

function Status() {
  const feed = useFeed();
  const ws = useQuery({
    queryKey: ["worker-status"],
    refetchInterval: 10_000,
    queryFn: async () => (await supabase.from("worker_status").select("*").order("last_heartbeat_at", { ascending: false }).limit(1).maybeSingle()).data,
  });
  const hb = ws.data;
  const stats = (hb?.stats ?? {}) as Record<string, any>;
  const coverage = (hb?.coverage ?? {}) as Record<string, Record<string, string>>;

  return (
    <div className="scroll-thin h-full overflow-y-auto p-3">
      <div className="mx-auto max-w-4xl space-y-3">
        <div className="panel p-4">
          <div className="mb-2 flex items-center gap-3"><h1 className="text-sm font-semibold">Feed status</h1><StatusDot status={feed.status} lastAt={feed.lastMessageAt} /></div>
          {!hb ? (
            <p className="text-sm text-muted-foreground">The market service has never checked in. Follow the setup steps below.</p>
          ) : (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs md:grid-cols-4">
              <Item k="Last heartbeat" v={`${fmtAge(new Date(hb.last_heartbeat_at).getTime())} ago`} />
              <Item k="Upstream" v={stats["feed"]?.upstream ?? "—"} />
              <Item k="Last event" v={stats["feed"]?.lastEventAt ? `${fmtAge(stats["feed"].lastEventAt)} ago` : "—"} />
              <Item k="Reconnects" v={stats["feed"]?.reconnects ?? "—"} />
              <Item k="Launches seen" v={stats["feed"]?.launches ?? "—"} />
              <Item k="Migrations seen" v={stats["feed"]?.migrations ?? "—"} />
              <Item k="Trade subscriptions" v={stats["feed"]?.activeTradeSubscriptions ?? "—"} />
              <Item k="Metered trade msgs" v={stats["feed"]?.tradeMessages ?? "—"} />
              <Item k="Tracked markets" v={stats["trackedMarkets"] ?? "—"} />
              <Item k="SOL/USD" v={stats["solUsd"]?.price ? `$${stats["solUsd"].price} (${stats["solUsd"].source})` : "unavailable"} />
              <Item k="Browser stream" v={hb.public_url ? "available" : "PUBLIC_URL not set"} />
              <Item k="Last browser update" v={feed.lastMessageAt ? `${fmtAge(feed.lastMessageAt)} ago` : "—"} />
            </dl>
          )}
        </div>

        <div className="panel p-4">
          <h2 className="mb-2 text-sm font-semibold">Coverage</h2>
          {Object.keys(coverage).length === 0 ? (
            <p className="text-xs text-muted-foreground">Reported by the market service once it is running. Planned first: pump.fun bonding curves (launches, migrations, live swaps with a funded PumpPortal key) and verified PumpSwap destination pools.</p>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {Object.entries(coverage).map(([k, v]) => (
                  <tr key={k} className="border-b border-border/40 align-top">
                    <td className="py-1.5 pr-3 font-semibold">{k}</td>
                    <td className="py-1.5 text-muted-foreground">{Object.entries(v).map(([a, b]) => <div key={a}><span className="text-foreground">{a}:</span> {b}</div>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">Listings and timing come from our own feed and will differ from Axiom, FOMO and DEX Screener.</p>
        </div>

        <div className="panel p-4 text-xs leading-relaxed">
          <h2 className="mb-2 text-sm font-semibold">Setup</h2>
          <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
            <li>Save a long random <b className="text-foreground">WORKER_INGEST_SECRET</b> in this project&apos;s secrets.</li>
            <li>Deploy the <code>worker/</code> folder to an always-on host (Railway, Fly.io or Render) using <code>worker/Dockerfile</code>.</li>
            <li>Set the worker variables from <code>worker/.env.example</code> — the same secret, <code>INGEST_URL</code> pointing at this site&apos;s <code>/api/public/worker-ingest</code>, and its own <code>PUBLIC_URL</code>.</li>
            <li>Optional: add a PumpPortal API key funded with at least 0.02 SOL as <code>PUMPPORTAL_API_KEY</code> to unlock live swaps, charts and paper execution.</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

const Item = ({ k, v }: { k: string; v: ReactNode }) => (
  <div className="flex justify-between gap-2 border-b border-border/30 py-0.5"><dt className="text-muted-foreground">{k}</dt><dd className="num">{v}</dd></div>
);
