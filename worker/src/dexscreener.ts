import { log } from "./log.ts";

// DEX Screener public REST, shared cache across all users, simple token-bucket rate limit (~250 req/min budget).
const TTL_MS = 15_000;
const cache = new Map<string, { at: number; data: any }>();
let tokens = 250;
setInterval(() => { tokens = 250; }, 60_000).unref();
export const dexStats = { requests: 0, errors: 0, lastSuccessAt: 0 as number, rateLimited: 0 };

/** Returns the cached or fresh body plus the time it was actually fetched (stale bodies keep their old time). */
async function getAt(url: string): Promise<{ data: any; at: number } | null> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  if (tokens <= 0) { dexStats.rateLimited++; return hit ?? null; }
  tokens--;
  dexStats.requests++;
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) { dexStats.errors++; log("warn", "dexscreener error", { status: r.status, url }); return hit ?? null; }
    const entry = { at: Date.now(), data: await r.json() };
    cache.set(url, entry);
    dexStats.lastSuccessAt = entry.at;
    return entry;
  } catch (e) {
    dexStats.errors++;
    return hit ?? null;
  }
}
const get = async (url: string) => (await getAt(url))?.data ?? null;

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
  const r = await getAt(`https://api.dexscreener.com/latest/dex/pairs/solana/${pool}`);
  const p = r?.data?.pairs?.[0] ?? r?.data?.pair ?? null;
  return p ? { pair: p, at: r!.at } : null;
}
