import { config } from "../config.ts";
import { log } from "../log.ts";

// Shared Solana JSON-RPC client with a hard global budget. Public mainnet RPC allows roughly
// 100 req/10s per IP (40/10s per method); we stay well under it and back off on 429/403.
export class RpcLimited extends Error { constructor(public status: number) { super(`rpc ${status}`); } }

const MAX_CONCURRENT = 2;
const MIN_GAP_MS = Math.max(100, Math.round(1000 / Math.max(0.5, config.rpcMaxRps)));
let active = 0, lastStart = 0, cooldownUntil = 0, penalty = 0;
const waiters: (() => void)[] = [];

export const rpcStats = { requests: 0, errors: 0, limited: 0, lastLimitedAt: 0 as number, cooldownUntil: 0 as number };
export const rpcCoolingDown = () => Date.now() < cooldownUntil;

async function slot() {
  for (;;) {
    const now = Date.now();
    if (now < cooldownUntil) throw new RpcLimited(429);
    if (active < MAX_CONCURRENT && now - lastStart >= MIN_GAP_MS) { active++; lastStart = now; return; }
    await new Promise<void>((r) => { waiters.push(r); setTimeout(r, Math.max(MIN_GAP_MS - (now - lastStart), 20)); });
  }
}
function release() { active--; waiters.shift()?.(); }

export async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  await slot();
  try {
    rpcStats.requests++;
    const r = await fetch(config.solanaRpcUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 429 || r.status === 403) {
      penalty = Math.min(penalty ? penalty * 2 : 5_000, 120_000);
      cooldownUntil = Date.now() + penalty;
      rpcStats.limited++; rpcStats.lastLimitedAt = Date.now(); rpcStats.cooldownUntil = cooldownUntil;
      log("warn", "solana rpc rate limited", { status: r.status, backoffMs: penalty });
      throw new RpcLimited(r.status);
    }
    if (!r.ok) { rpcStats.errors++; throw new Error(`rpc http ${r.status}`); }
    const j: any = await r.json();
    if (j.error) {
      if (j.error.code === -32429 || /rate limit|too many/i.test(String(j.error.message))) {
        penalty = Math.min(penalty ? penalty * 2 : 5_000, 120_000);
        cooldownUntil = Date.now() + penalty; rpcStats.limited++; rpcStats.lastLimitedAt = Date.now(); rpcStats.cooldownUntil = cooldownUntil;
        throw new RpcLimited(429);
      }
      rpcStats.errors++; throw new Error(`rpc error ${j.error.code}: ${j.error.message}`);
    }
    penalty = Math.max(0, Math.floor(penalty / 2));
    return j.result as T;
  } finally { release(); }
}
