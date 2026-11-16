import WebSocket from "ws";
import { log } from "../log.ts";

// Solana logsSubscribe notifications are hints: swaps are validated through getTransaction before charting.
export interface LiveHint { curve: string; signature: string; slot: number; receivedAt: number }
type Sock = { readyState: number; send(d: string): void; close(): void; terminate?(): void; on(ev: string, fn: (...a: any[]) => void): void };
export interface LiveOptions {
  url: string; maxSubs: number; onHint: (h: LiveHint) => void; onReconnect?: (curves: string[]) => void;
  connect?: (url: string) => Sock; now?: () => number; pingMs?: number;
}
export type CurveLiveState = "streaming" | "subscribing" | "reconnecting" | "unavailable" | "off";
const ACK_TIMEOUT_MS = 15_000;
const RETRY_BASE_MS = 1_000, RETRY_MAX_MS = 30_000;

export function createLiveLogs(o: LiveOptions) {
  const now = o.now ?? Date.now;
  const connect = o.connect ?? ((u: string) => new WebSocket(u) as unknown as Sock);
  let ws: Sock | null = null, open = false, backoff = 1_000, nextId = 1, closedByUs = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null, lastMsgAt = 0, dropped = false;
  const wanted = new Set<string>();
  const subs = new Map<string, { id: number | null; reqId: number; sentAt: number; since: number }>();
  const byReq = new Map<number, string>(), bySub = new Map<number, string>(), unsubReqs = new Set<number>();
  const retries = new Map<string, { tries: number; at: number }>();
  const stats = { connects: 0, reconnects: 0, notifications: 0, failedExcluded: 0, lastNotificationAt: 0, lastError: null as string | null, subscribed: 0 };

  function send(m: unknown) { if (ws && open) ws.send(JSON.stringify(m)); }
  function countSubs() { stats.subscribed = [...subs.values()].filter((s) => s.id != null).length; }
  function unsubscribeId(id: number) {
    bySub.delete(id);
    const reqId = nextId++; unsubReqs.add(reqId);
    send({ jsonrpc: "2.0", id: reqId, method: "logsUnsubscribe", params: [id] });
  }
  function subscribe(curve: string) {
    const reqId = nextId++;
    subs.set(curve, { id: null, reqId, sentAt: now(), since: 0 });
    byReq.set(reqId, curve);
    send({ jsonrpc: "2.0", id: reqId, method: "logsSubscribe", params: [{ mentions: [curve] }, { commitment: "confirmed" }] });
  }
  function retryLater(curve: string, error: string) {
    const tries = Math.min((retries.get(curve)?.tries ?? 0) + 1, 6);
    retries.set(curve, { tries, at: now() + Math.min(RETRY_BASE_MS * 2 ** (tries - 1), RETRY_MAX_MS) });
    stats.lastError = error;
  }
  function unsubscribe(curve: string) {
    const s = subs.get(curve);
    subs.delete(curve); retries.delete(curve);
    if (s) byReq.delete(s.reqId);
    if (s?.id != null) unsubscribeId(s.id);
    countSubs();
  }
  function reconcile() {
    if (!open) return;
    for (const [curve, s] of subs) {
      if (s.id == null && now() - s.sentAt >= ACK_TIMEOUT_MS) {
        byReq.delete(s.reqId); subs.delete(curve);
        retryLater(curve, "logsSubscribe acknowledgement timed out; retrying");
      }
    }
    // A failed request must be retried even when the viewed-address set hasn't changed.
    for (const curve of wanted) if (!subs.has(curve) && now() >= (retries.get(curve)?.at ?? 0)) subscribe(curve);
    countSubs();
  }

  function start() {
    if (ws || closedByUs) return;
    stats.connects++;
    const sock = connect(o.url);
    ws = sock;
    sock.on("open", () => {
      if (ws !== sock || closedByUs) return;
      open = true; backoff = 1_000; lastMsgAt = now();
      if (dropped) { stats.reconnects++; o.onReconnect?.([...wanted]); }
      dropped = false; stats.lastError = null;
      reconcile();
    });
    // Quiet markets still produce WebSocket pong frames. They are not JSON message events.
    const alive = () => { if (ws === sock) lastMsgAt = now(); };
    sock.on("pong", alive);
    sock.on("ping", alive);
    sock.on("message", (raw: unknown) => {
      if (ws !== sock || closedByUs) return;
      lastMsgAt = now();
      let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
      if (typeof m.id === "number" && byReq.has(m.id)) {
        const curve = byReq.get(m.id)!; byReq.delete(m.id);
        const s = subs.get(curve);
        if (!s || s.reqId !== m.id || !wanted.has(curve)) {
          if (typeof m.result === "number") unsubscribeId(m.result);
          return;
        }
        if (typeof m.result === "number") {
          s.id = m.result; s.since = now(); bySub.set(m.result, curve); retries.delete(curve);
        } else {
          subs.delete(curve);
          retryLater(curve, `logsSubscribe failed: ${m.error?.message ?? "unknown"}; retrying`);
        }
        countSubs();
        return;
      }
      if (typeof m.id === "number" && unsubReqs.delete(m.id)) return;
      // A request can complete after cancellation/timeout. Release that server-side subscription too.
      if (typeof m.id === "number" && typeof m.result === "number") { unsubscribeId(m.result); return; }
      if (m.method !== "logsNotification") return;
      const curve = bySub.get(m.params?.subscription);
      const v = m.params?.result?.value;
      if (!curve || !wanted.has(curve) || !v || typeof v.signature !== "string") return;
      stats.notifications++;
      if (v.err != null) { stats.failedExcluded++; return; }
      stats.lastNotificationAt = now();
      o.onHint({ curve, signature: v.signature, slot: Number(m.params.result.context?.slot) || 0, receivedAt: now() });
    });
    const down = (why: string) => {
      if (ws !== sock) return;
      ws = null; open = false;
      subs.clear(); byReq.clear(); bySub.clear(); unsubReqs.clear(); stats.subscribed = 0;
      if (closedByUs) return;
      stats.lastError = why; dropped = true;
      const wait = backoff; backoff = Math.min(backoff * 2, RETRY_MAX_MS);
      log("warn", "solana ws disconnected", { why, retryMs: wait });
      if (wanted.size) reconnectTimer = setTimeout(() => { reconnectTimer = null; start(); }, wait);
    };
    sock.on("close", () => down("closed"));
    sock.on("error", (e: Error) => { if (ws !== sock) return; stats.lastError = e?.message ?? "error"; try { sock.close(); } catch { /* */ } down(e?.message ?? "error"); });
  }

  const ping = setInterval(() => {
    if (!ws || !open) return;
    if (now() - lastMsgAt > (o.pingMs ?? 30_000) * 2.5) { const s = ws; try { s.terminate ? s.terminate() : s.close(); } catch { /* */ } return; }
    reconcile();
    try { (ws as any).ping?.(); } catch { /* */ }
  }, o.pingMs ?? 30_000);
  (ping as any).unref?.();

  /** Replace viewed addresses, most recently viewed first; never exceed maxSubs. */
  function setWanted(curves: string[]) {
    const next = new Set([...new Set(curves)].slice(0, o.maxSubs));
    for (const c of [...wanted]) if (!next.has(c)) { wanted.delete(c); unsubscribe(c); }
    for (const c of next) wanted.add(c);
    if (wanted.size && !ws && !reconnectTimer) start();
    reconcile();
    if (!wanted.size && ws) {
      const s = ws; ws = null; open = false;
      subs.clear(); byReq.clear(); bySub.clear(); unsubReqs.clear(); retries.clear(); stats.subscribed = 0;
      try { s.close(); } catch { /* */ }
    }
  }

  function state(curve: string): CurveLiveState {
    if (!wanted.has(curve)) return "off";
    const s = subs.get(curve);
    if (open && s?.id != null) return "streaming";
    if (open) return s ? "subscribing" : "unavailable";
    return dropped ? "reconnecting" : "subscribing";
  }
  function stop() {
    closedByUs = true; clearInterval(ping); if (reconnectTimer) clearTimeout(reconnectTimer);
    const s = ws; ws = null; open = false;
    wanted.clear(); subs.clear(); byReq.clear(); bySub.clear(); unsubReqs.clear(); retries.clear(); stats.subscribed = 0;
    s?.close();
  }
  return { setWanted, state, stats, stop, since: (c: string) => subs.get(c)?.since ?? null };
}
