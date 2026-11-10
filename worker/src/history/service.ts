import { CandleBuilder } from "../../../src/lib/market/candles.ts";
import { log } from "../log.ts";
import { rpc, RpcLimited, rpcStats, rpcCoolingDown } from "./rpc.ts";
import { bondingCurvePda, extractSwaps, type VerifiedSwap } from "./pumpEvents.ts";
import type { Market } from "../store.ts";

// Read-only chart history for viewed Pump.fun curves, from public Solana RPC.
// Kept entirely separate from the Store: it never touches executable state, quotes or paper orders.
const TTL_MS = 20_000;
const FIRST_PAGE = 60;      // transactions decoded on first view
const INCREMENTAL_PAGE = 40; // newer transactions decoded per refresh
const MAX_ENTRIES = 40;

export type HistoryState = "ok" | "empty" | "loading" | "rate_limited" | "unavailable" | "unsupported";

interface Entry {
  marketId: string; swaps: Map<string, VerifiedSwap>; builder: CandleBuilder; newestSig: string | null;
  scanned: number; rejected: number; fetchedAt: number | null; attemptedAt: number; state: HistoryState; error: string | null;
  inflight: Promise<void> | null; lastUsed: number;
}
const cache = new Map<string, Entry>();
export const historyStats = { refreshes: 0, failures: 0, swapsDecoded: 0, entries: () => cache.size, rpc: rpcStats };

function entry(id: string): Entry {
  let e = cache.get(id);
  if (!e) {
    e = { marketId: id, swaps: new Map(), builder: new CandleBuilder(20_000, 86_400), newestSig: null, scanned: 0, rejected: 0,
      fetchedAt: null, attemptedAt: 0, state: "loading", error: null, inflight: null, lastUsed: Date.now() };
    cache.set(id, e);
    if (cache.size > MAX_ENTRIES) {
      const old = [...cache.values()].filter((x) => !x.inflight).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (old) cache.delete(old.marketId);
    }
  }
  return e;
}

async function refresh(e: Entry, m: Market) {
  historyStats.refreshes++;
  e.attemptedAt = Date.now();
  try {
    const limit = e.newestSig ? INCREMENTAL_PAGE : FIRST_PAGE;
    const params: Record<string, unknown> = { limit, commitment: "confirmed" };
    if (e.newestSig) params.until = e.newestSig;
    const sigs = await rpc<{ signature: string; slot: number; err: unknown; blockTime: number | null }[]>("getSignaturesForAddress", [m.address, params]);
    const ok = sigs.filter((s) => s.err == null);
    for (const s of [...ok].reverse()) { // oldest first
      if ([...e.swaps.keys()].some((k) => k.startsWith(s.signature + ":"))) continue;
      const tx = await rpc<any>("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      e.scanned++;
      const swaps = extractSwaps(tx, s.signature, m.address, m.mint);
      if (!swaps.length) e.rejected++;
      for (const w of swaps) {
        if (e.swaps.has(w.id)) continue;
        e.swaps.set(w.id, w);
        e.builder.add({ id: w.id, ts: w.blockTime * 1000, price: w.price, baseQty: w.baseQty, quoteQty: w.quoteQty, side: w.side });
        historyStats.swapsDecoded++;
      }
    }
    if (sigs.length) e.newestSig = sigs[0].signature;
    e.fetchedAt = Date.now();
    e.error = null;
    e.state = e.swaps.size ? "ok" : "empty";
  } catch (err) {
    historyStats.failures++;
    // Keep previously decoded swaps; report the failure kind alongside them.
    e.state = err instanceof RpcLimited ? "rate_limited" : "unavailable";
    e.error = err instanceof RpcLimited ? `Solana RPC rate limited (HTTP ${err.status}); backing off` : "Solana RPC request failed";
    log("warn", "history refresh failed", { market: m.id, err: String(err) });
  }
}

export function supportsHistory(m: Market | undefined): m is Market {
  return !!m && m.kind === "curve" && m.venue === "pumpfun" && m.status === "active" && m.quoteCcy === "SOL";
}

/** Returns cached history; kicks off a deduplicated background refresh when stale. */
export function history(m: Market | undefined, id: string, intervalSec: number) {
  if (!supportsHistory(m)) return { state: "unsupported" as HistoryState, candles: [], swaps: 0, fetchedAt: null, error: "On-chain history is available only for active Pump.fun bonding curves." };
  if (bondingCurvePda(m.mint) !== m.address) return { state: "unsupported" as HistoryState, candles: [], swaps: 0, fetchedAt: null, error: "Curve address does not match the Pump program's derived address for this mint." };
  const e = entry(id);
  e.lastUsed = Date.now();
  const stale = !e.fetchedAt || Date.now() - e.fetchedAt > TTL_MS;
  const retryOk = Date.now() - e.attemptedAt > (e.state === "rate_limited" || e.state === "unavailable" ? TTL_MS : 0);
  if (stale && !e.inflight && retryOk && !rpcCoolingDown()) {
    e.inflight = refresh(e, m).finally(() => { e.inflight = null; });
  }
  const swaps = [...e.swaps.values()];
  return {
    state: (e.inflight && !e.fetchedAt ? "loading" : e.state) as HistoryState,
    refreshing: !!e.inflight, candles: e.builder.candles(intervalSec), swaps: swaps.length,
    fetchedAt: e.fetchedAt, error: e.error, scannedTransactions: e.scanned,
    oldestTs: swaps.length ? Math.min(...swaps.map((s) => s.blockTime)) : null,
    newestTs: swaps.length ? Math.max(...swaps.map((s) => s.blockTime)) : null,
    ttlSec: TTL_MS / 1000,
  };
}
