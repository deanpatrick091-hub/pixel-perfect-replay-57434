import type { ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { resetPaperAccount } from "@/lib/trading.functions";
import { fmtAge, fmtPrice, fmtQty, fmtUsd } from "@/lib/format";
import { usePaperAccount } from "@/components/terminal/AppShell";
import { PaperBadge } from "@/components/terminal/bits";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/portfolio")({
  head: () => ({
    meta: [
      { title: "Portfolio — bondfire paper trading" },
      { name: "description", content: "Your virtual cash, open paper positions, P&L, fills and order history." },
      { property: "og:title", content: "Paper portfolio — bondfire" },
      { property: "og:description", content: "Track virtual cash, positions and P&L from simulated meme-coin trades." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Portfolio,
});

const STALE_MS = 60_000;

function usePortfolio(enabled: boolean) {
  return useQuery({
    queryKey: ["portfolio"],
    enabled,
    refetchInterval: 10_000,
    queryFn: async () => {
      const [pos, orders, fills, ref] = await Promise.all([
        supabase.from("paper_positions").select("*").order("updated_at", { ascending: false }),
        supabase.from("paper_orders").select("*").order("created_at", { ascending: false }).limit(100),
        supabase.from("paper_fills").select("*").order("created_at", { ascending: false }).limit(100),
        supabase.from("reference_prices").select("*").eq("pair", "SOL/USD").maybeSingle(),
      ]);
      const mints = [...new Set((pos.data ?? []).map((p) => p.mint))];
      const mk = mints.length ? await supabase.from("markets").select("id,mint,symbol,venue,status,price_quote,quote_ccy,state_updated_at").in("mint", mints) : { data: [] };
      return { positions: pos.data ?? [], orders: orders.data ?? [], fills: fills.data ?? [], sol: ref.data, markets: mk.data ?? [] };
    },
  });
}

function Portfolio() {
  const { user, ready } = useAuth();
  const acct = usePaperAccount(!!user);
  const p = usePortfolio(!!user);
  const qc = useQueryClient();
  const reset = useServerFn(resetPaperAccount);

  if (!ready) return null;
  if (!user)
    return (
      <div className="grid h-full place-items-center">
        <div className="panel p-5 text-center">
          <p className="mb-3 text-sm">Sign in to get $10,000 in virtual cash and track your paper trades.</p>
          <Button asChild><Link to="/auth">Sign in</Link></Button>
        </div>
      </div>
    );

  const sol = p.data?.sol;
  const solFresh = sol && Date.now() - new Date(sol.updated_at).getTime() < 5 * 60_000 ? Number(sol.price) : null;
  const rows = (p.data?.positions ?? []).filter((x) => Number(x.qty) > 0 || Number(x.realized_pnl_usd) !== 0).map((pos) => {
    const mkts = (p.data?.markets ?? []).filter((m) => m.mint === pos.mint);
    const mark = mkts.find((m) => m.status === "active") ?? mkts.find((m) => m.id === pos.last_market_id);
    const markAt = mark?.state_updated_at ? new Date(mark.state_updated_at).getTime() : null;
    const markUsd = mark?.price_quote != null && solFresh ? Number(mark.price_quote) * solFresh : null;
    const qty = Number(pos.qty);
    const cost = Number(pos.cost_basis_usd);
    const value = markUsd != null ? qty * markUsd : null;
    return { pos, mark, markAt, markUsd, qty, avg: qty > 0 ? cost / qty : null, value, upnl: value != null ? value - cost : null, stale: !markAt || Date.now() - markAt > STALE_MS };
  });
  const cash = acct.data ? Number(acct.data.cash_usd) : null;
  const posValue = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  const unpriced = rows.some((r) => r.qty > 0 && r.value == null);
  const upnl = rows.reduce((s, r) => s + (r.upnl ?? 0), 0);
  const rpnl = rows.reduce((s, r) => s + Number(r.pos.realized_pnl_usd), 0);
  const fees = rows.reduce((s, r) => s + Number(r.pos.fees_usd), 0);
  const openOrders = (p.data?.orders ?? []).filter((o) => o.status === "open" || o.status === "pending");

  return (
    <div className="scroll-thin h-full overflow-y-auto p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="text-sm font-semibold">Portfolio</h1>
        <PaperBadge />
        <AlertDialog>
          <AlertDialogTrigger asChild><Button size="xs" variant="outline" className="ml-auto">Reset account</Button></AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Reset your paper account?</AlertDialogTitle>
              <AlertDialogDescription>
                This clears every paper position, cancels open orders and restores your virtual cash to {fmtUsd(Number(acct.data?.starting_balance_usd ?? 10000))}. Your order history is kept.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={async () => {
                try { await reset(); toast.success("Paper account reset"); } catch (e) { toast.error(String(e)); }
                void qc.invalidateQueries();
              }}>Reset</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-6">
        {[
          ["Virtual cash", fmtUsd(cash)],
          ["Positions value", unpriced ? `${fmtUsd(posValue)}*` : fmtUsd(posValue)],
          ["Equity", cash != null ? fmtUsd(cash + posValue) : "—"],
          ["Unrealised P&L", fmtUsd(upnl)],
          ["Realised P&L", fmtUsd(rpnl)],
          ["Fees paid", fmtUsd(fees)],
        ].map(([k, v]) => (
          <div key={k} className="panel px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</div><div className="num text-sm font-semibold">{v}</div></div>
        ))}
      </div>
      {unpriced && <p className="mb-2 text-xs text-warn">* Some positions have no fresh mark (market state or SOL/USD unavailable) and are excluded from value.</p>}

      <Section title="Open positions">
        <Table head={["Token", "Qty", "Avg entry", "Mark", "Value", "Unrealised", "Realised", "Fees", "Mark source"]}>
          {rows.length === 0 && <EmptyRow n={9} text="No positions yet. Buy something from Discover." />}
          {rows.map((r) => (
            <tr key={r.pos.mint} className="border-b border-border/40">
              <td className="px-2 py-1.5">{r.mark ? <Link to="/m/$marketId" params={{ marketId: r.mark.id }} className="font-semibold hover:text-primary">{r.pos.symbol ?? r.pos.mint.slice(0, 6)}</Link> : r.pos.symbol}</td>
              <td className="num">{fmtQty(r.qty)}</td>
              <td className="num">{fmtPrice(r.avg)}</td>
              <td className={cn("num", r.stale && "text-warn")}>{fmtPrice(r.markUsd)}</td>
              <td className="num">{fmtUsd(r.value)}</td>
              <td className={cn("num", (r.upnl ?? 0) >= 0 ? "text-up" : "text-down")}>{fmtUsd(r.upnl)}</td>
              <td className={cn("num", Number(r.pos.realized_pnl_usd) >= 0 ? "text-up" : "text-down")}>{fmtUsd(Number(r.pos.realized_pnl_usd))}</td>
              <td className="num">{fmtUsd(Number(r.pos.fees_usd))}</td>
              <td className="text-muted-foreground">{r.mark ? `${r.mark.venue}${r.stale ? ` · stale ${fmtAge(r.markAt)}` : ` · ${fmtAge(r.markAt)} ago`}` : "no market"}</td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Open orders">
        <Table head={["Time", "Token", "Side", "Type", "Amount", "Limit", "Status"]}>
          {openOrders.length === 0 && <EmptyRow n={7} text="No open orders." />}
          {openOrders.map((o) => (
            <tr key={o.id}><td className="px-2">{new Date(o.created_at).toLocaleTimeString()}</td><td>{o.symbol}</td><td>{o.side}</td><td>{o.order_type}</td><td className="num">{o.amount}</td><td className="num">{fmtPrice(o.limit_price_usd)}</td><td>{o.status}</td></tr>
          ))}
        </Table>
      </Section>

      <Section title="Fills">
        <Table head={["Time", "Token", "Side", "Qty", "Price", "Notional", "Fee", "Impact", "Realised"]}>
          {(p.data?.fills ?? []).length === 0 && <EmptyRow n={9} text="No fills yet." />}
          {(p.data?.fills ?? []).map((f) => (
            <tr key={f.id} className="border-b border-border/40">
              <td className="px-2 py-1 text-muted-foreground">{new Date(f.created_at).toLocaleString()}</td>
              <td>{f.symbol}</td>
              <td className={f.side === "buy" ? "text-up" : "text-down"}>{f.side}</td>
              <td className="num">{fmtQty(Number(f.qty))}</td>
              <td className="num">{fmtPrice(Number(f.price_usd))}</td>
              <td className="num">{fmtUsd(Number(f.notional_usd))}</td>
              <td className="num">{fmtUsd(Number(f.fee_usd))}</td>
              <td className="num">{(Math.abs(Number(f.price_impact_bps)) / 100).toFixed(2)}%</td>
              <td className="num">{f.realized_pnl_usd != null ? fmtUsd(Number(f.realized_pnl_usd)) : "—"}</td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Order history" badge>
        <Table head={["Time", "Token", "Side", "Type", "Amount", "Status", "Reason"]}>
          {(p.data?.orders ?? []).length === 0 && <EmptyRow n={7} text="No orders yet." />}
          {(p.data?.orders ?? []).map((o) => (
            <tr key={o.id} className="border-b border-border/40">
              <td className="px-2 py-1 text-muted-foreground">{new Date(o.created_at).toLocaleString()}</td>
              <td>{o.symbol}</td>
              <td className={o.side === "buy" ? "text-up" : "text-down"}>{o.side}</td>
              <td>{o.order_type}</td>
              <td className="num">{o.side === "buy" ? fmtUsd(Number(o.amount)) : fmtQty(Number(o.amount))}</td>
              <td className={cn(o.status === "filled" ? "text-up" : o.status === "rejected" ? "text-down" : "text-muted-foreground")}>{o.status}</td>
              <td className="max-w-[320px] truncate text-muted-foreground" title={o.reject_reason ?? ""}>{o.reject_reason ?? ""}</td>
            </tr>
          ))}
        </Table>
      </Section>
    </div>
  );
}

function Section({ title, children, badge }: { title: string; children: ReactNode; badge?: boolean }) {
  return (
    <section className="panel mb-3 overflow-hidden">
      <h2 className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs font-semibold">{title}{badge && <PaperBadge />}</h2>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}
function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <table className="w-full text-xs">
      <thead className="text-left text-muted-foreground"><tr>{head.map((h, i) => <th key={h} className={cn("py-1 font-normal", i === 0 && "px-2")}>{h}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  );
}
const EmptyRow = ({ n, text }: { n: number; text: string }) => <tr><td colSpan={n} className="px-2 py-3 text-muted-foreground">{text}</td></tr>;
