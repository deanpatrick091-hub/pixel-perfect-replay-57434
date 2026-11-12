import WebSocket from "ws";
import { log } from "../log.ts";

// Free Solana `logsSubscribe` (mentions: [curve], commitment: confirmed) for curves someone is viewing.
// A notification is only a hint that a confirmed transaction touched the curve: failed ones are dropped here,
// and swaps are only charted after the same getTransaction + TradeEvent validation as history.
// https://solana.com/docs/rpc/websocket/logssubscribe

export interface LiveHint { curve: string; signature: string; slot: number; receivedAt: number }
type Sock = { readyState: number; send(d: string): void; close(): void; terminate?(): void; on(ev: string, fn: (...a: any[]) => void): void };
export interface LiveOptions {
  url: string; maxSubs: number; onHint: (h: LiveHint) => void; onReconnect?: (curves: string[]) => void;
  connect?: (url: string) => Sock; now?: () => number; pingMs?: number;
}
export type CurveLiveState = "streaming" | "subscribing" | "reconnecting" | "unavailable" | "off";

export function createLiveLogs(o: LiveOptions) {
  const now = o.now ?? Date.now;
  const connect = o.connect ?? ((u: string) => new WebSocket(u) as unknown as Sock);
  let ws: Sock | null = null, open = false, backoff = 1_000, nextId = 1, everOpen = false, closedByUs = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null, lastMsgAt = 0, dropped = false;
  const wanted = new Set<string>();
  const subs = new Map<string, { id: number | null; reqId: number; since: number }>(); // curve -> server subscription
  const byReq = new Map<number, string>(), bySub = new Map<number, string>(), unsubReqs = new Set<number>();
  const stats = { connects: 0, reconnects: 0, notifications: 0, failedExcluded: 0, lastNotificationAt: 0, lastError: null as string | null, subscribed: 0 };

  function send(m: unknown) { if (ws && open) ws.send(JSON.stringify(m)); }
  function subscribe(curve: string) {
    const reqId = nextId++;
    subs.set(curve, { id: null, reqId, since: 0 });
    byReq.set(reqId, curve);
    send({ jsonrpc: "2.0", id: reqId, method: "logsSubscribe", params: [{ mentions: [curve] }, { commitment: "confirmed" }] });
  }
  function unsubscribe(curve: string) {
    const s = subs.get(curve);
    subs.delete(curve);
    if (s?.id != null) { bySub.delete(s.id); const r = nextId++; unsubReqs.add(r); send({ jsonrpc: "2.0", id: r, method: "logsUnsubscribe", params: [s.id] }); }
  }

  function start() {
    if (ws || closedByUs) return;
    stats.connects++;
    const sock = connect(o.url);
    ws = sock;
    sock.on("open", () => {
      open = true; backoff = 1_000; lastMsgAt = now();
      // Only an unexpected drop counts as a reconnect (and needs catch-up); idle close/reopen doesn't.
      if (dropped) { stats.reconnects++; o.onReconnect?.([...wanted]); }
      dropped = false; stats.lastError = null;
      everOpen = true;
      for (const c of wanted) subscribe(c);
    });
    sock.on("message", (raw: unknown) => {
      lastMsgAt = now();
      let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
      if (typeof m.id === "number" && byReq.has(m.id)) {
        const curve = byReq.get(m.id)!; byReq.delete(m.id);
        const s = subs.get(curve);
        if (!s || s.reqId !== m.id) return;
        if (typeof m.result === "number") { s.id = m.result; s.since = now(); bySub.set(m.result, curve); }
        else { stats.lastError = `logsSubscribe failed: ${m.error?.message ?? "unknown"}`; subs.delete(curve); }
        stats.subscribed = [...subs.values()].filter((x) => x.id != null).length;
        return;
      }
      if (typeof m.id === "number" && unsubReqs.delete(m.id)) return;
      if (m.method !== "logsNotification") return;
      const curve = bySub.get(m.params?.subscription);
      const v = m.params?.result?.value;
      if (!curve || !v || typeof v.signature !== "string") return;
      stats.notifications++;
      if (v.err != null) { stats.failedExcluded++; return; } // failed transactions never produce valid swaps
      stats.lastNotificationAt = now();
      o.onHint({ curve, signature: v.signature, slot: Number(m.params.result.context?.slot) || 0, receivedAt: now() });
    });
    const down = (why: string) => {
      if (ws !== sock) return;
      ws = null; open = false;
      subs.clear(); byReq.clear(); bySub.clear(); unsubReqs.clear(); stats.subscribed = 0;
      if (closedByUs) return;
      stats.lastError = why; dropped = true;
      const wait = backoff; backoff = Math.min(backoff * 2, 30_000);
      log("warn", "solana ws disconnected", { why, retryMs: wait });
      if (wanted.size) reconnectTimer = setTimeout(() => { reconnectTimer = null; start(); }, wait);
    };
    sock.on("close", () => down("closed"));
    sock.on("error", (e: Error) => { stats.lastError = e?.message ?? "error"; try { sock.close(); } catch { /* */ } down(e?.message ?? "error"); });
  }

  // Liveness: public WS can go silent without closing; ping and drop a dead socket.
  const ping = setInterval(() => {
    if (!ws || !open) return;
    if (now() - lastMsgAt > (o.pingMs ?? 30_000) * 2.5) { const s = ws; try { s.terminate ? s.terminate() : s.close(); } catch { /* */ } return; }
    try { (ws as any).ping?.(); } catch { /* */ }
  }, o.pingMs ?? 30_000);
  (ping as any).unref?.();

  /** Replace the set of curves to stream (most recently viewed first; capped). */
  function setWanted(curves: string[]) {
    const next = new Set(curves.slice(0, o.maxSubs));
    for (const c of [...wanted]) if (!next.has(c)) { wanted.delete(c); unsubscribe(c); }
    for (const c of next) if (!wanted.has(c)) { wanted.add(c); if (open) subscribe(c); }
    if (wanted.size && !ws && !reconnectTimer) start();
    if (!wanted.size && ws) { const s = ws; ws = null; open = false; subs.clear(); byReq.clear(); bySub.clear(); stats.subscribed = 0; try { s.close(); } catch { /* */ } }
  }

  function state(curve: string): CurveLiveState {
    if (!wanted.has(curve)) return "off";
    const s = subs.get(curve);
    if (open && s?.id != null) return "streaming";
    if (open) return s ? "subscribing" : "unavailable";
    return dropped ? "reconnecting" : "subscribing";
  }
  function stop() { closedByUs = true; clearInterval(ping); if (reconnectTimer) clearTimeout(reconnectTimer); ws?.close(); ws = null; }
  return { setWanted, state, stats, stop, since: (c: string) => subs.get(c)?.since ?? null };
}
