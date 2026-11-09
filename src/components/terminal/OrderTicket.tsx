import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { placeMarketOrder, type OrderResult } from "@/lib/trading.functions";
import { quoteBuy, quoteSell } from "@/lib/market/quote";
import { quoteUsd, type MarketSummary, type Reference } from "@/lib/feed/types";
import { fmtPrice, fmtQty, fmtUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PaperBadge } from "./bits";
import { usePaperAccount } from "./AppShell";

export function useAppConfig() {
  return useQuery({
    queryKey: ["app-config"],
    queryFn: async () => {
      const { data, error } = await supabase.from("app_config").select("*").eq("id", 1).single();
      if (error) throw error;
      return data;
    },
    staleTime: 60_000,
  });
}

export function OrderTicket({ m, reference }: { m: MarketSummary; reference: Reference | null }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const cfg = useAppConfig();
  const acct = usePaperAccount(!!user);
  const place = useServerFn(placeMarketOrder);
  const [tab, setTab] = useState<"market" | "limit">("market");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slip, setSlip] = useState("5");
  const [state, setState] = useState<{ kind: "idle" | "pending" | "filled" | "rejected"; msg?: string }>({ kind: "idle" });
  const idem = useRef<string>(crypto.randomUUID());
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const settings = useQuery({
    queryKey: ["user-settings"],
    enabled: !!user,
    queryFn: async () => (await supabase.from("user_settings").select("*").maybeSingle()).data,
  });
  const position = useQuery({
    queryKey: ["position", m.mint],
    enabled: !!user,
    queryFn: async () => (await supabase.from("paper_positions").select("*").eq("mint", m.mint).maybeSingle()).data,
  });
  useEffect(() => { if (settings.data) setSlip(String(settings.data.default_slippage_bps / 100)); }, [settings.data]);

  const qUsd = quoteUsd(reference, m.quoteCcy);
  const fee = cfg.data?.fee_bps ?? 100;
  const staleSec = cfg.data?.quote_stale_seconds ?? 30;
  const stateAge = m.stateUpdatedAt ? (now - m.stateUpdatedAt) / 1000 : Infinity;
  const held = position.data ? Number(position.data.qty) - Number(position.data.reserved_qty) : 0;
  const cash = acct.data ? Number(acct.data.cash_usd) - Number(acct.data.reserved_cash_usd) : 0;
  const amt = Number(amount);

  const blocked =
    m.status !== "active" ? "This market has migrated. Trade the destination pool."
    : m.tradeFeed !== "live" ? (m.tradeFeed === "unverified" ? "Live swaps unverified for this pool — paper execution disabled." : "Launch detected · trades unavailable — paper execution disabled.")
    : stateAge > staleSec ? `Market state is ${Number.isFinite(stateAge) ? Math.round(stateAge) + "s" : ""} old (limit ${staleSec}s) — quotes paused.`
    : !qUsd ? "SOL/USD reference is stale or unavailable."
    : m.reserveQuote == null || m.reserveBase == null ? "Pool reserves unavailable — cannot quote."
    : null;

  const preview = useMemo(() => {
    if (!qUsd || !m.reserveQuote || !m.reserveBase || !(amt > 0)) return null;
    const s = { reserveQuote: m.reserveQuote, reserveBase: m.reserveBase, quoteUsd: qUsd, feeBps: fee };
    return side === "buy" ? quoteBuy(s, amt) : quoteSell(s, amt);
  }, [qUsd, m.reserveQuote, m.reserveBase, amt, side, fee]);

  const insufficient = side === "buy" ? amt > cash : amt > held;
  useEffect(() => { idem.current = crypto.randomUUID(); }, [side, amount, slip, m.id]);

  async function submit() {
    if (!preview || state.kind === "pending") return;
    setState({ kind: "pending" });
    try {
      const r: OrderResult = await place({
        data: { marketId: m.id, side, amount: amt, slippageBps: Math.round(Number(slip) * 100), expectedPriceUsd: preview.execPriceUsd, idempotencyKey: idem.current },
      });
      if (r.status === "filled") {
        setState({ kind: "filled", msg: `${side === "buy" ? "Bought" : "Sold"} ${fmtQty(r.qty)} ${m.symbol ?? ""} @ ${fmtPrice(r.price_usd)}` });
        toast.success(`Paper ${side} filled`, { description: `${fmtQty(r.qty)} ${m.symbol ?? ""} @ ${fmtPrice(r.price_usd)}` });
        setAmount("");
      } else {
        setState({ kind: "rejected", msg: r.reason ?? "Rejected" });
      }
      idem.current = crypto.randomUUID();
      void qc.invalidateQueries({ queryKey: ["paper-account"] });
      void qc.invalidateQueries({ queryKey: ["position", m.mint] });
      void qc.invalidateQueries({ queryKey: ["portfolio"] });
    } catch (e) {
      setState({ kind: "rejected", msg: e instanceof Error ? e.message : "Order failed" });
    }
  }

  const presets = (settings.data?.buy_presets_usd as number[] | undefined) ?? [25, 50, 100, 250];

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between">
        <div className="flex gap-1 text-xs" role="tablist">
          {(["market", "limit"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={cn("rounded px-2 py-1 capitalize", tab === t ? "bg-surface-2 text-foreground" : "text-muted-foreground")}>{t}</button>
          ))}
        </div>
        <PaperBadge />
      </div>

      <div className="grid grid-cols-2 gap-1 rounded bg-background p-0.5">
        <button onClick={() => setSide("buy")} aria-pressed={side === "buy"} className={cn("rounded py-1.5 text-xs font-semibold", side === "buy" ? "bg-up text-up-foreground" : "text-muted-foreground")}>Buy</button>
        <button onClick={() => setSide("sell")} aria-pressed={side === "sell"} className={cn("rounded py-1.5 text-xs font-semibold", side === "sell" ? "bg-down text-down-foreground" : "text-muted-foreground")}>Sell</button>
      </div>

      {tab === "limit" ? (
        <p className="rounded border border-border bg-background p-3 text-xs text-muted-foreground">
          Limit orders (reserved funds, fill on fresh quotes, safe cancellation) are the next feature being built. Use a market order for now.
        </p>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {side === "buy" ? "Amount (USD)" : `Amount (${m.symbol ?? "tokens"})`}
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00"
              className="num rounded border border-input bg-background px-2 py-2 text-sm text-foreground" />
          </label>
          <div className="flex flex-wrap gap-1">
            {side === "buy"
              ? presets.map((p) => <Button key={p} size="xs" variant="chip" onClick={() => setAmount(String(p))}>${p}</Button>)
              : [25, 50, 75, 100].map((p) => <Button key={p} size="xs" variant="chip" disabled={held <= 0} onClick={() => setAmount(String(p === 100 ? held : +(held * p / 100).toFixed(6)))}>{p}%</Button>)}
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{side === "buy" ? <>Cash <b className="num text-foreground">{user ? fmtUsd(cash) : "—"}</b></> : <>Held <b className="num text-foreground">{fmtQty(held)}</b></>}</span>
            <label className="flex items-center gap-1">Slippage
              <input value={slip} onChange={(e) => setSlip(e.target.value.replace(/[^0-9.]/g, ""))} className="num w-12 rounded border border-input bg-background px-1 py-0.5 text-right text-foreground" aria-label="Slippage percent" />%
            </label>
          </div>

          <dl className="grid grid-cols-2 gap-y-1 rounded border border-border bg-background p-2 text-xs">
            <dt className="text-muted-foreground">Market</dt><dd className="truncate text-right">{m.symbol} · {m.venue} · {m.quoteCcy}</dd>
            <dt className="text-muted-foreground">{side === "buy" ? "You receive" : "You receive"}</dt>
            <dd className="num text-right">{preview ? (side === "buy" ? `${fmtQty((preview as any).qty)} ${m.symbol ?? ""}` : fmtUsd((preview as any).netUsd)) : "—"}</dd>
            <dt className="text-muted-foreground">Avg price</dt><dd className="num text-right">{preview ? fmtPrice(preview.execPriceUsd) : "—"}</dd>
            <dt className="text-muted-foreground">Price impact</dt><dd className={cn("num text-right", preview && Math.abs(preview.impactBps) > 300 && "text-warn")}>{preview ? `${(Math.abs(preview.impactBps) / 100).toFixed(2)}%` : "—"}</dd>
            <dt className="text-muted-foreground">Est. fee ({(fee / 100).toFixed(1)}%)</dt><dd className="num text-right">{preview ? fmtUsd(preview.feeUsd) : "—"}</dd>
            <dt className="text-muted-foreground">Quote model</dt><dd className="truncate text-right text-muted-foreground">{m.quoteModel ?? "—"}</dd>
          </dl>

          {!user ? (
            <Button asChild><Link to="/auth">Sign in to place paper orders</Link></Button>
          ) : (
            <Button variant={side === "buy" ? "buy" : "sell"} disabled={!!blocked || !preview || insufficient || state.kind === "pending"} onClick={submit}>
              {state.kind === "pending" ? "Submitting…" : insufficient ? (side === "buy" ? "Insufficient virtual cash" : "Insufficient holdings") : `Paper ${side} ${m.symbol ?? ""}`}
            </Button>
          )}
          {blocked && <p className="text-xs text-warn">{blocked}</p>}
          {state.kind === "filled" && <p className="text-xs text-up">Filled · {state.msg}</p>}
          {state.kind === "rejected" && <p className="text-xs text-down">Rejected · {state.msg}</p>}
        </>
      )}
    </div>
  );
}
