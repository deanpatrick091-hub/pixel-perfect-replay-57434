import type { ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useFeed } from "@/lib/feed/client";
import { fmtUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { PaperBadge, StatusDot } from "./bits";

export function usePaperAccount(enabled: boolean) {
  return useQuery({
    queryKey: ["paper-account"],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_paper_account");
      if (error) throw error;
      return data?.[0] ?? null;
    },
    refetchInterval: 15_000,
  });
}

function BalanceChip() {
  const { user, ready } = useAuth();
  const acct = usePaperAccount(!!user);
  if (!ready) return null;
  if (!user)
    return (
      <Button asChild size="xs" variant="default">
        <Link to="/auth">Sign in to paper trade</Link>
      </Button>
    );
  return (
    <div className="flex items-center gap-2">
      <Link to="/portfolio" className="flex items-center gap-2 rounded border border-border bg-surface px-2 py-1 hover:border-primary/50">
        <span className="num text-xs font-semibold">{acct.data ? fmtUsd(Number(acct.data.cash_usd)) : "…"}</span>
        <PaperBadge />
      </Link>
      <Button size="icon-xs" variant="ghost" aria-label="Sign out" onClick={() => supabase.auth.signOut()}>
        <LogOut />
      </Button>
    </div>
  );
}

const NAV = [
  { to: "/", label: "Discover" },
  { to: "/portfolio", label: "Portfolio" },
  { to: "/status", label: "Coverage" },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const feed = useFeed();
  const navigate = useNavigate();
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-11 shrink-0 items-center gap-4 border-b border-border bg-sidebar px-3">
        <button onClick={() => navigate({ to: "/" })} className="flex items-center gap-1.5 font-semibold tracking-tight">
          <span className="grid h-5 w-5 place-items-center rounded-sm bg-primary text-[11px] font-bold text-primary-foreground">B</span>
          <span className="hidden sm:inline">bondfire</span>
        </button>
        <nav className="flex items-center gap-1">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              activeOptions={{ exact: n.to === "/" }}
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground data-[status=active]:bg-surface-2 data-[status=active]:text-foreground"
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <Link to="/status" className="hidden sm:block"><StatusDot status={feed.status} lastAt={feed.lastMessageAt} /></Link>
          <BalanceChip />
        </div>
      </header>
      {feed.gapNotice && (
        <div className="flex items-center justify-between border-b border-border bg-paper px-3 py-1 text-xs text-paper-foreground">
          <span>{feed.gapNotice}</span>
          <button className="underline" onClick={() => { feed.gapNotice = null; }}>Dismiss</button>
        </div>
      )}
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}

export function SetupState({ reason }: { reason: string }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="panel max-w-lg p-5">
        <div className="mb-2 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-warn" />
          <h2 className="text-sm font-semibold">Live market service not connected</h2>
        </div>
        <p className="text-sm text-muted-foreground">{reason}</p>
        <p className="mt-3 text-xs text-muted-foreground">
          No tokens, prices or trades are shown until real data arrives — nothing here is simulated except your paper orders.
        </p>
        <Button asChild size="sm" variant="secondary" className="mt-4"><Link to="/status">See setup &amp; coverage</Link></Button>
      </div>
    </div>
  );
}
