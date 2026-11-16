import { useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { FeedStatus, MarketSummary, Reference, Trade } from "./types";

// Browser connection to the market worker. Snapshot first, then apply batched updates.
// The worker announces its public URL via heartbeat (worker_status table), so the site needs no config.

const HEARTBEAT_MAX_AGE_MS = 60_000;
const STALE_AFTER_MS = 20_000;

class FeedClient {
  status: FeedStatus = "checking";
  workerUrl: string | null = null;
  lastHeartbeatAt: number | null = null;
  coverage: Record<string, Record<string, string>> = {};
  markets = new Map<string, MarketSummary>();
  tapes = new Map<string, Trade[]>();
  reference: Reference | null = null;
  lastMessageAt = 0;
  seq = 0;
  gapNotice: string | null = null;
  setupReason = "Checking for the live market service…";
  /** Why the feed isn't live: never seen, heartbeat stopped, misconfigured, status unreadable, or socket unreachable. */
  setupKind: "never" | "offline" | "no_url" | "read_error" | "unreachable" | null = null;
  lastCheckAt: number | null = null;
  private wsFailures = 0;
  version = 0;

  private ws: WebSocket | null = null;
  private topics = new Map<string, number>();
  private listeners = new Set<() => void>();
  private chartListeners = new Map<string, Set<() => void>>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private backoff = 1000;
  private everConnected = false;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getVersion = () => this.version;

  private notify() {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.version++;
      this.listeners.forEach((l) => l());
    }, 120);
  }

  start() {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    void this.discover();
    setInterval(() => void this.discover(), 15_000);
    setInterval(() => {
      if (this.status === "connected" && Date.now() - this.lastMessageAt > STALE_AFTER_MS) {
        this.status = "stale";
        this.notify();
      }
    }, 2000);
  }

  /** User-triggered re-check: re-read the heartbeat and reconnect immediately. */
  retry = () => {
    this.status = "checking"; this.setupReason = "Checking for the live market service…"; this.notify();
    this.backoff = 1000; this.wsFailures = 0;
    if (this.workerUrl && !this.ws) this.connect();
    void this.discover();
  };

  private setup(kind: NonNullable<FeedClient["setupKind"]>, reason: string) {
    this.status = "setup"; this.setupKind = kind; this.setupReason = reason;
  }

  private async discover() {
    // Security-definer lookup: latest heartbeat time/status/URL only, so a long-dead worker reads as "offline since", not "never".
    const { data: rows, error } = await supabase.rpc("worker_service_status");
    this.lastCheckAt = Date.now();
    const data = rows?.[0] ?? null;
    if (error) {
      if (this.status !== "connected" && this.status !== "stale") this.setup("read_error", "Could not read the market service's status. Retrying every 15 seconds.");
      this.notify();
      return;
    }
    const hb = data?.last_heartbeat_at ? new Date(data.last_heartbeat_at).getTime() : null;
    this.lastHeartbeatAt = hb;
    const alive = hb != null && Date.now() - hb < HEARTBEAT_MAX_AGE_MS;
    if (!data || hb == null) this.setup("never", "The live market service has never checked in. It must be deployed and running before launches can stream.");
    else if (!data.public_url) this.setup("no_url", "The market service is checking in but has no PUBLIC_URL set, so the browser cannot stream from it.");
    else if (!alive && !this.ws) this.setup("offline", `The market service last checked in ${new Date(hb).toLocaleString()} and is offline. Its host must be running again before live data returns.`);
    else if (this.status === "setup" && this.setupKind !== "unreachable") { this.status = "checking"; this.setupKind = null; }
    if (data?.public_url && alive) {
      const url = data.public_url.replace(/\/$/, "");
      const changed = url !== this.workerUrl;
      this.workerUrl = url;
      if (changed || (!this.ws && this.setupKind !== "unreachable")) this.connect();
    }
    this.notify();
  }

  private connect() {
    if (!this.workerUrl) return;
    if (this.ws) { const old = this.ws; this.ws = null; old.close(); }
    if (this.status !== "setup") this.status = this.everConnected ? "reconnecting" : "connecting";
    const ws = new WebSocket(this.workerUrl.replace(/^http/, "ws") + "/ws");
    this.ws = ws;
    ws.onopen = async () => {
      this.backoff = 1000; this.wsFailures = 0; this.setupKind = null;
      const wasConnected = this.everConnected;
      this.everConnected = true;
      this.status = "connected";
      this.lastMessageAt = Date.now();
      const topics = [...this.topics.keys()];
      if (topics.length) ws.send(JSON.stringify({ op: "sub", topics }));
      // Events missed while disconnected cannot be replayed: refresh the snapshot and say so.
      await this.loadSnapshot();
      for (const t of topics) if (t.startsWith("market:")) await this.loadMarket(t.slice(7));
      if (wasConnected) this.gapNotice = `Reconnected at ${new Date().toLocaleTimeString()} — snapshot refreshed; swaps during the gap may be missing from the tape.`;
      this.notify();
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      if (this.status === "stale") this.status = "connected";
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.reference) this.reference = msg.reference;
      if (typeof msg.seq === "number") this.seq = msg.seq;
      if (msg.type === "batch") {
        for (const m of msg.markets as MarketSummary[]) this.markets.set(m.id, m);
        for (const t of msg.trades as (Trade | { migration: unknown })[]) {
          if ("migration" in t) continue;
          const tape = this.tapes.get(t.marketId);
          if (!tape) continue;
          if (tape.some((x) => x.id === t.id)) continue;
          tape.unshift(t);
          if (tape.length > 200) tape.length = 200;
        }
        // Read-only chart nudge: new verified swaps for a viewed market; the chart refetches its timeframe.
        if (Array.isArray(msg.charts)) for (const id of msg.charts) this.chartListeners.get(id)?.forEach((f) => f());
      }
      this.notify();
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.wsFailures++;
      // Heartbeat says alive but the socket never opens: likely PUBLIC_URL/ALLOWED_ORIGINS, not a dead host.
      if (!this.everConnected && this.wsFailures >= 3) this.setup("unreachable", `The market service checks in, but this browser can't open its live connection (${this.workerUrl}). Check its PUBLIC_URL and that ALLOWED_ORIGINS includes ${location.origin}.`);
      else if (this.status !== "setup") this.status = "reconnecting";
      this.notify();
      const alive = this.lastHeartbeatAt != null && Date.now() - this.lastHeartbeatAt < HEARTBEAT_MAX_AGE_MS;
      if (!alive) { this.setup("offline", `The market service stopped responding${this.lastHeartbeatAt ? ` (last check-in ${new Date(this.lastHeartbeatAt).toLocaleString()})` : ""}.`); this.notify(); return; }
      const wait = Math.min(this.backoff, 20_000);
      this.backoff *= 2;
      setTimeout(() => this.connect(), wait);
    };
  }

  async loadSnapshot() {
    if (!this.workerUrl) return;
    try {
      const r = await fetch(`${this.workerUrl}/api/snapshot`);
      const j = await r.json();
      this.reference = j.reference;
      this.seq = j.seq;
      for (const m of j.markets as MarketSummary[]) this.markets.set(m.id, m);
      this.notify();
    } catch { /* surfaced through status */ }
  }

  async loadMarket(id: string) {
    if (!this.workerUrl) return null;
    const r = await fetch(`${this.workerUrl}/api/markets/${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    const j = await r.json();
    this.reference = j.reference;
    for (const m of [j.market, ...(j.siblings ?? [])] as MarketSummary[]) this.markets.set(m.id, m);
    this.tapes.set(id, j.tape ?? []);
    this.notify();
    return j.market as MarketSummary;
  }

  async candles(id: string, tf: string) {
    if (!this.workerUrl) return null;
    const r = await fetch(`${this.workerUrl}/api/candles?market=${encodeURIComponent(id)}&tf=${tf}`);
    if (!r.ok) return null;
    return (await r.json()) as { candles: import("./types").Candle[]; note: string; historyFrom: number | null; quoteCcy: string | null };
  }

  /** Subscribe to "new verified swaps" nudges for a market (sent over the existing worker socket). */
  onChart = (id: string, f: () => void) => {
    let set = this.chartListeners.get(id);
    if (!set) this.chartListeners.set(id, (set = new Set()));
    set.add(f);
    return () => { set!.delete(f); if (!set!.size) this.chartListeners.delete(id); };
  };

  /** Read-only on-chain history (chart only). Returns null on network failure/timeout so callers keep their last snapshot. */
  async history(id: string, tf: string, signal?: AbortSignal, opts: { retry?: boolean } = {}) {
    if (!this.workerUrl) return null;
    // Own timeout (not AbortSignal.any/timeout, which older iOS Safari lacks) so a suspended request can't hang polling.
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort);
    const t = setTimeout(() => ctl.abort(), 15_000);
    try {
      const r = await fetch(`${this.workerUrl}/api/history?market=${encodeURIComponent(id)}&tf=${encodeURIComponent(tf)}${opts.retry ? "&retry=1" : ""}`, { signal: ctl.signal, cache: "no-store" });
      if (!r.ok) return null;
      return (await r.json()) as import("./types").ChartHistory;
    } catch { return null; } finally { clearTimeout(t); signal?.removeEventListener("abort", onAbort); }
  }

  watch(topic: string) {
    const n = this.topics.get(topic) ?? 0;
    this.topics.set(topic, n + 1);
    if (n === 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op: "sub", topics: [topic] }));
    }
    return () => {
      const c = (this.topics.get(topic) ?? 1) - 1;
      if (c <= 0) {
        this.topics.delete(topic);
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op: "unsub", topics: [topic] }));
      } else this.topics.set(topic, c);
    };
  }
}

export const feed = new FeedClient();

/** Re-renders (batched) whenever the feed changes. */
export function useFeed(topic?: string) {
  useEffect(() => { feed.start(); }, []);
  useEffect(() => (topic ? feed.watch(topic) : undefined), [topic]);
  useSyncExternalStore(feed.subscribe, feed.getVersion, () => 0);
  return feed;
}
