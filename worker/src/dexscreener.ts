import { log } from "./log.ts";

// DEX Screener public REST (pair/token endpoints are documented at 300 req/min; we budget below that).
// One shared client: per-URL cache with the real fetch time, in-flight de-duplication, a continuously
// refilling token bucket (no fixed-window bursts), bounded concurrency, and a global cooldown on HTTP 429
// that honours Retry-After. During cooldown nothing is sent; callers get the cached body with its old time.
const TTL_MS = 15_000;
export const DEX_RATE_PER_MIN = 200, DEX_BURST = 8, DEX_MAX_CONCURRENT = 3, DEX_BATCH = 30;
const COOLDOWN_BASE_MS = 30_000, COOLDOWN_MAX_MS = 300_000;

export interface DexClientOptions { fetch?: typeof fetch; now?: () => number; ratePerMin?: number; burst?: number; maxConcurrent?: number }
type Entry = { at: number; data: any };

export function createDexClient(o: DexClientOptions = {}) {
  const now = o.now ?? Date.now;
  const doFetch = o.fetch ?? fetch;
  const rate = (o.ratePerMin ?? DEX_RATE_PER_MIN) / 60_000, burst = o.burst ?? DEX_BURST, maxC = o.maxConcurrent ?? DEX_MAX_CONCURRENT;
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<Entry | null>>();
  let tokens = burst, refilledAt = now(), active = 0, cooldownUntil = 0, strikes = 0;
  const stats = { requests: 0, errors: 0, lastSuccessAt: 0, rateLimited: 0, http429: 0, deduped: 0, skippedBudget: 0, skippedCooldown: 0, skippedBusy: 0, cooldownUntil: 0, lastRetryAfterSec: null as number | null };

  function take(): "ok" | "cooldown" | "budget" | "busy" {
    const t = now();
    if (t < cooldownUntil) return "cooldown";
    tokens = Math.min(burst, tokens + (t - refilledAt) * rate); refilledAt = t;
    if (active >= maxC) return "busy";
    if (tokens < 1) return "budget";
    tokens -= 1; return "ok";
  }

  async function getAt(url: string): Promise<Entry | null> {
    const hit = cache.get(url);
    if (hit && now() - hit.at < TTL_MS) return hit;
    const running = inflight.get(url);
    if (running) { stats.deduped++; return (await running) ?? hit ?? null; }
    const gate = take();
    if (gate !== "ok") {
      stats.rateLimited++;
      if (gate === "cooldown") stats.skippedCooldown++; else if (gate === "budget") stats.skippedBudget++; else stats.skippedBusy++;
      return hit ?? null;
    }
    const p = (async (): Promise<Entry | null> => {
      active++; stats.requests++;
      try {
        const r = await doFetch(url, { headers: { accept: "application/json" } });
        if (r.status === 429) {
          stats.http429++; stats.errors++; strikes++;
          const ra = Number(r.headers.get("retry-after"));
          const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, COOLDOWN_MAX_MS) : Math.min(COOLDOWN_BASE_MS * 2 ** (strikes - 1), COOLDOWN_MAX_MS);
          stats.lastRetryAfterSec = Number.isFinite(ra) && ra > 0 ? ra : null;
          cooldownUntil = Math.max(cooldownUntil, now() + wait); stats.cooldownUntil = cooldownUntil; tokens = 0;
          log("warn", "dexscreener rate limited; global cooldown", { waitMs: wait, retryAfter: stats.lastRetryAfterSec });
          return null;
        }
        if (!r.ok) { stats.errors++; log("warn", "dexscreener error", { status: r.status, url }); return null; }
        const entry = { at: now(), data: await r.json() };
        cache.set(url, entry); strikes = 0; stats.lastSuccessAt = entry.at;
        return entry;
      } catch { stats.errors++; return null; }
      finally { active--; inflight.delete(url); }
    })();
    inflight.set(url, p);
    return (await p) ?? hit ?? null;
  }

  const pairUrl = (pool: string) => `https://api.dexscreener.com/latest/dex/pairs/solana/${pool}`;

  /** Many pools in batched requests (≤30 per call); each result keeps the batch's real fetch time. */
  async function pairsAt(pools: string[]): Promise<Map<string, { pair: DexPair; at: number }>> {
    const out = new Map<string, { pair: DexPair; at: number }>();
    const need: string[] = [];
    for (const a of new Set(pools)) {
      const hit = cache.get(pairUrl(a));
      const p = hit?.data?.pairs?.[0] ?? null;
      if (hit && now() - hit.at < TTL_MS) { if (p) out.set(a, { pair: p, at: hit.at }); } else need.push(a);
    }
    for (let i = 0; i < need.length; i += DEX_BATCH) {
      const chunk = need.slice(i, i + DEX_BATCH);
      const r = await getAt(pairUrl(chunk.join(",")));
      const fresh = r != null && cache.get(pairUrl(chunk.join(","))) === r;
      for (const a of chunk) {
        const p = fresh ? (r!.data?.pairs ?? []).find((x: DexPair) => x.pairAddress === a) : null;
        if (p) { const e = { at: r!.at, data: { pairs: [p] } }; if (!cache.get(pairUrl(a)) || cache.get(pairUrl(a))!.at < e.at) cache.set(pairUrl(a), e); out.set(a, { pair: p, at: r!.at }); }
        else { const old = cache.get(pairUrl(a)); const op = old?.data?.pairs?.[0]; if (op) out.set(a, { pair: op, at: old!.at }); }
      }
    }
    return out;
  }
  return { getAt, pairsAt, stats, coolingDown: () => now() < cooldownUntil };
}

const client = createDexClient();
export const dexStats = client.stats;
export const pairsAt = client.pairsAt;
const get = async (url: string) => (await client.getAt(url))?.data ?? null;

export interface DexPair {
  chainId: string; dexId: string; pairAddress: string; baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string }; priceNative?: string; priceUsd?: string;
  liquidity?: { usd?: number; base?: number; quote?: number }; fdv?: number; marketCap?: number;
  volume?: Record<string, number>; info?: { imageUrl?: string }; pairCreatedAt?: number;
}

export async function tokenPairs(mint: string): Promise<DexPair[]> {
  const d = await get(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`);
  return Array.isArray(d) ? d : [];
}

export async function pair(pool: string): Promise<DexPair | null> {
  return (await pairAt(pool))?.pair ?? null;
}

/** Pair plus when DEX Screener actually returned it (not when we last asked), so freshness isn't overstated. */
export async function pairAt(pool: string): Promise<{ pair: DexPair; at: number } | null> {
  return (await client.pairsAt([pool])).get(pool) ?? null;
}
