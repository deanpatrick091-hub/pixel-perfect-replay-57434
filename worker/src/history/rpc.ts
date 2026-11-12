import { config } from "../config.ts";
import { log } from "../log.ts";

// Shared Solana JSON-RPC client with one hard global budget for all chart-history work.
// Public mainnet RPC documents ~100 req/10s per IP and 40 req/10s per method; we stay well below that,
// never retry around a 429/403, and keep a bounded priority queue (live > recent > backfill).

export type Priority = 0 | 1 | 2; // 0 live notification, 1 recent history, 2 older backfill
export class RpcLimited extends Error { constructor(public status: number, public retryAt = 0) { super(`rpc rate limited (${status})`); } }
export class RpcForbidden extends Error { constructor(public retryAt = 0) { super("rpc refused access (HTTP 403)"); } }
export class RpcTransport extends Error { constructor(public kind: "timeout" | "network" | "http", message: string) { super(message); } }
export class RpcBusy extends Error { constructor() { super("rpc queue full"); } }
export class RpcError extends Error { constructor(public code: number, message: string) { super(`rpc error ${code}: ${message}`); } }
/** Errors that mean "stop and back off globally" (never retried around). */
export const isBackoff = (e: unknown): e is RpcLimited | RpcForbidden => e instanceof RpcLimited || e instanceof RpcForbidden;

export interface RpcOptions {
  url: string; maxRps: number; maxConcurrent?: number; maxQueue?: number; timeoutMs?: number; transportRetries?: number;
  fetch?: typeof fetch; now?: () => number; retryDelayMs?: number;
}

export function createRpc(o: RpcOptions) {
  const now = o.now ?? Date.now;
  const doFetch = o.fetch ?? fetch;
  const maxConcurrent = o.maxConcurrent ?? 2;
  const maxQueue = o.maxQueue ?? 100;
  const timeoutMs = o.timeoutMs ?? 15_000;
  const retries = o.transportRetries ?? 1;
  const retryDelay = o.retryDelayMs ?? 750;
  const baseGap = Math.max(50, Math.round(1000 / Math.max(0.2, o.maxRps)));
  // Adaptive: each rate limit slows the shared budget (x1.5, down to 1/4 of the configured rate);
  // it creeps back 5% per 20 consecutive successes. Never faster than configured.
  let gap = baseGap, okStreak = 0;
  type W = { prio: Priority; seq: number; go: () => void; fail: (e: Error) => void };
  const queue: W[] = [];
  let active = 0, lastStart = 0, cooldownUntil = 0, cooldownReason: "rate_limited" | "forbidden" | null = null, penalty = 0, seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stats = {
    requests: 0, ok: 0, timeouts: 0, transportErrors: 0, rpcErrors: 0, limited: 0, forbidden: 0, rejectedBusy: 0, retried: 0,
    queued: 0, maxQueue, lastLimitedAt: 0, cooldownUntil: 0, cooldownReason: null as string | null,
    lastError: null as string | null, lastErrorAt: 0, latencyMs: null as number | null, budgetRps: 1000 / gap,
  };
  const coolingDown = () => now() < cooldownUntil;

  function startCooldown(kind: "rate_limited" | "forbidden") {
    // 429: 5s doubling to 2min. 403 means the endpoint refuses us: much longer (1min doubling to 10min).
    const base = kind === "forbidden" ? 60_000 : 5_000, cap = kind === "forbidden" ? 600_000 : 120_000;
    penalty = Math.min(penalty ? penalty * 2 : base, cap);
    gap = Math.min(Math.round(gap * 1.5), baseGap * 4); okStreak = 0; stats.budgetRps = 1000 / gap;
    if (kind === "forbidden") penalty = Math.max(penalty, base);
    cooldownUntil = now() + penalty; cooldownReason = kind;
    stats.cooldownUntil = cooldownUntil; stats.cooldownReason = kind;
    // Queued work is released with the same backoff error instead of waiting on a held slot.
    for (const w of queue.splice(0)) w.fail(kind === "forbidden" ? new RpcForbidden(cooldownUntil) : new RpcLimited(429, cooldownUntil));
    stats.queued = 0;
  }

  function pump() {
    if (timer) { clearTimeout(timer); timer = null; }
    while (queue.length && active < maxConcurrent) {
      const t = now();
      if (t < cooldownUntil) { startCooldown(cooldownReason ?? "rate_limited"); return; }
      const wait = gap - (t - lastStart);
      if (wait > 0) { timer = setTimeout(pump, wait); return; }
      let best = 0;
      for (let i = 1; i < queue.length; i++) if (queue[i].prio < queue[best].prio || (queue[i].prio === queue[best].prio && queue[i].seq < queue[best].seq)) best = i;
      const [w] = queue.splice(best, 1);
      stats.queued = queue.length;
      active++; lastStart = t;
      w.go();
    }
  }

  function slot(prio: Priority) {
    if (coolingDown()) return Promise.reject(cooldownReason === "forbidden" ? new RpcForbidden(cooldownUntil) : new RpcLimited(429, cooldownUntil));
    if (queue.length >= maxQueue) { stats.rejectedBusy++; return Promise.reject(new RpcBusy()); }
    return new Promise<void>((go, fail) => { queue.push({ prio, seq: seq++, go, fail }); stats.queued = queue.length; pump(); });
  }
  function release() { active--; pump(); }

  async function once<T>(method: string, params: unknown[]): Promise<T> {
    stats.requests++;
    const t0 = now();
    let r: Response;
    try {
      r = await doFetch(o.url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timeout = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
      if (timeout) stats.timeouts++;
      throw new RpcTransport(timeout ? "timeout" : "network", timeout ? `${method} timed out after ${Math.round(timeoutMs / 1000)}s` : `${method} network error: ${(err as Error)?.message ?? err}`);
    }
    if (r.status === 429) { stats.limited++; stats.lastLimitedAt = now(); startCooldown("rate_limited"); throw new RpcLimited(429, cooldownUntil); }
    if (r.status === 403) { stats.forbidden++; startCooldown("forbidden"); throw new RpcForbidden(cooldownUntil); }
    if (r.status >= 500) throw new RpcTransport("http", `${method} HTTP ${r.status}`);
    if (!r.ok) { stats.rpcErrors++; throw new RpcError(r.status, `HTTP ${r.status}`); }
    let j: any;
    try { j = await r.json(); } catch { throw new RpcTransport("network", `${method} returned an unreadable body`); }
    if (j?.error) {
      if (j.error.code === -32429 || /rate limit|too many/i.test(String(j.error.message))) {
        stats.limited++; stats.lastLimitedAt = now(); startCooldown("rate_limited"); throw new RpcLimited(429, cooldownUntil);
      }
      stats.rpcErrors++;
      throw new RpcError(Number(j.error.code), String(j.error.message));
    }
    stats.ok++;
    const ms = now() - t0;
    stats.latencyMs = stats.latencyMs == null ? ms : Math.round(stats.latencyMs * 0.8 + ms * 0.2);
    penalty = Math.floor(penalty / 2);
    if (++okStreak >= 20 && gap > baseGap) { gap = Math.max(baseGap, Math.round(gap * 0.95)); okStreak = 0; stats.budgetRps = 1000 / gap; }
    return j.result as T;
  }

  /** One budgeted RPC call. Transport failures (timeout/network/5xx) are retried a bounded number of times. */
  async function rpc<T>(method: string, params: unknown[], prio: Priority = 1): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await slot(prio);
      try { return await once<T>(method, params); }
      catch (err) {
        if (!(err instanceof RpcTransport)) throw err;
        stats.transportErrors++; stats.lastError = err.message; stats.lastErrorAt = now();
        if (attempt >= retries) { log("warn", "solana rpc transport failure", { method, err: err.message }); throw err; }
        stats.retried++;
      } finally { release(); }
      await new Promise((res) => setTimeout(res, retryDelay * (attempt + 1) + Math.random() * 250));
    }
  }

  return { rpc, stats, coolingDown, cooldownUntil: () => cooldownUntil, queueLength: () => queue.length };
}

const client = createRpc({ url: config.solanaRpcUrl, maxRps: config.rpcMaxRps, timeoutMs: config.rpcTimeoutMs, maxQueue: 100 });
export const rpc = client.rpc;
export const rpcStats = client.stats;
export const rpcCoolingDown = client.coolingDown;
export const rpcCooldownUntil = client.cooldownUntil;
