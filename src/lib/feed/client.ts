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
  version = 0;

  private ws: WebSocket | null = null;
  private topics = new Map<string, number>();
  private listeners = new Set<() => void>();
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

  private async discover() {
    const { data, error } = await supabase
      .from("worker_status")
      .select("public_url,last_heartbeat_at,coverage,status")
      .order("last_heartbeat_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      if (this.status === "checking") { this.status = "setup"; this.setupReason = "Could not read market service status."; this.notify(); }
      return;
    }
    const hb = data ? new Date(data.last_heartbeat_at).getTime() : null;
    this.lastHeartbeatAt = hb;
    this.coverage = (data?.coverage as Record<string, Record<string, string>>) ?? {};
    const alive = hb != null && Date.now() - hb < HEARTBEAT_MAX_AGE_MS;
    if (!data) {
      this.status = "setup";
      this.setupReason = "The live market service has not connected yet. Deploy the worker to start streaming launches.";
    } else if (!data.public_url) {
      this.status = "setup";
      this.setupReason = "The market service is sending data but has no PUBLIC_URL set, so the browser cannot stream from it.";
    } else if (!alive && !this.ws) {
      this.status = "setup";
      this.setupReason = `The market service last checked in ${Math.round((Date.now() - hb!) / 1000)}s ago and looks offline.`;
    }
    if (data?.public_url && (alive || this.ws) && data.public_url !== this.workerUrl) {
      this.workerUrl = data.public_url.replace(/\/$/, "");
      this.connect();
    }
    this.notify();
  }

  private connect() {
    if (!this.workerUrl) return;
    this.ws?.close();
    this.status = this.everConnected ? "reconnecting" : "connecting";
    const ws = new WebSocket(this.workerUrl.replace(/^http/, "ws") + "/ws");
    this.ws = ws;
    ws.onopen = async () => {
      this.backoff = 1000;
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
      }
      this.notify();
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.status = "reconnecting";
      this.notify();
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

  /** Read-only on-chain history (chart only). Returns null on network failure so callers keep their last snapshot. */
  async history(id: string, tf: string, signal?: AbortSignal) {
    if (!this.workerUrl) return null;
    try {
      const r = await fetch(`${this.workerUrl}/api/history?market=${encodeURIComponent(id)}&tf=${encodeURIComponent(tf)}`, { signal: signal ?? null });
      if (!r.ok) return null;
      return (await r.json()) as import("./types").ChartHistory;
    } catch { return null; }
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
