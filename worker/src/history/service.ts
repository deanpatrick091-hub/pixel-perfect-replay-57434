import { CandleBuilder, type Candle } from "../../../src/lib/market/candles.ts";
import { log } from "../log.ts";
import { rpc as defaultRpc, RpcLimited, rpcStats, rpcCoolingDown } from "./rpc.ts";
import { bondingCurvePda, extractSwaps, type VerifiedSwap } from "./pumpEvents.ts";
import { marketId, type Market } from "../store.ts";

// Read-only chart history for viewed Pump.fun curves, from public Solana RPC.
// Kept entirely separate from the Store: it never touches executable state, quotes or paper orders.
//
// Identity vs order: a swap's identity is `signature:eventIndex`. Its chart order is
// slot -> RPC signature rank -> eventIndex. getSignaturesForAddress lists newest first, so within a slot we keep
// the RPC's reported order (deterministic) rather than claiming a true transaction index we don't have.
export const TTL_MS = 20_000;          // refresh a complete snapshot at most this often
const CONTINUE_MS = 2_000;             // continue a partial scan this soon
const SIG_PAGE = 100;                  // signatures per getSignaturesForAddress page
const FIRST_WINDOW = 100;              // first view: only the most recent N signatures (older history is never fetched)
const SIG_PAGES_PER_REFRESH = 3;
const TX_PER_REFRESH = 30;
const MAX_NULL_TRIES = 5;              // getTransaction null -> retry, then report as missing
const MAX_PENDING = 600;               // beyond this the oldest pending are dropped and counted as a gap
const MAX_ENTRIES = 40;

export type HistoryState = "ok" | "partial" | "empty" | "loading" | "rate_limited" | "unavailable" | "unsupported" | "unknown_market";

interface SigMeta { signature: string; slot: number; rank: number; tries: number; done: boolean }
interface RankedSwap extends VerifiedSwap { rank: number }
interface SigRow { signature: string; slot: number; err: unknown; blockTime: number | null }

interface Entry {
  marketId: string; curve: string; mint: string;
  sigs: Map<string, SigMeta>; swaps: Map<string, RankedSwap>;
  newestSig: string | null; // newest signature of the last COMPLETED signature scan
  scan: { until: string | null; before: string | null; rows: SigRow[] } | null;
  highRank: number; scanned: number; nonSwapTx: number; failedTx: number; rejectedEvents: number; missingTx: number; droppedTx: number;
  lastSuccessAt: number | null; completedAt: number | null; attemptedAt: number;
  failure: { kind: "rate_limited" | "unavailable"; message: string; at: number } | null;
  inflight: Promise<void> | null; lastUsed: number; version: number; built: { version: number; builder: CandleBuilder } | null;
}

export interface HistoryDeps { rpc: <T>(method: string, params: unknown[]) => Promise<T>; coolingDown: () => boolean; now?: () => number }

export type Support = { ok: true; curveStatus: Market["status"] } | { ok: false; state: "unsupported" | "unknown_market"; reason: string };

export function checkSupport(m: Market | undefined, id: string): Support {
  if (!m || m.id !== id) return { ok: false, state: "unknown_market", reason: "The connected market worker isn't tracking this market (it may have restarted), so its history can't be checked." };
  if (m.chain !== "solana") return { ok: false, state: "unsupported", reason: "On-chain history is only implemented for Solana markets." };
  if (m.kind === "amm") return { ok: false, state: "unsupported", reason: `Chart history for ${m.venue} AMM pools isn't implemented. Only Pump.fun bonding-curve swaps are decoded.` };
  if (m.venue !== "pumpfun") return { ok: false, state: "unsupported", reason: `Chart history for ${m.venue} isn't implemented.` };
  if (m.quoteCcy !== "SOL") return { ok: false, state: "unsupported", reason: `Only SOL-quoted curves are decoded (this one is quoted in ${m.quoteCcy}).` };
  if (id !== marketId("solana", "curve", m.address)) return { ok: false, state: "unsupported", reason: "Market id does not match its curve address." };
  let pda: string | null = null;
  try { pda = bondingCurvePda(m.mint); } catch { /* invalid mint */ }
  if (pda !== m.address) return { ok: false, state: "unsupported", reason: "Curve address does not match the Pump program's derived address for this mint." };
  return { ok: true, curveStatus: m.status };
}

const orderKey = (s: RankedSwap) => `${String(s.slot).padStart(12, "0")}:${String(s.rank).padStart(10, "0")}:${String(s.eventIndex).padStart(4, "0")}`;

export function createHistoryService(deps: HistoryDeps) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, Entry>();
  const stats = { refreshes: 0, failures: 0, swapsDecoded: 0, entries: () => cache.size, rpc: rpcStats };

  function entry(m: Market): Entry {
    let e = cache.get(m.id);
    if (!e) {
      e = { marketId: m.id, curve: m.address, mint: m.mint, sigs: new Map(), swaps: new Map(), newestSig: null, scan: null, highRank: 0,
        scanned: 0, nonSwapTx: 0, failedTx: 0, rejectedEvents: 0, missingTx: 0, droppedTx: 0, lastSuccessAt: null, completedAt: null, attemptedAt: 0,
        failure: null, inflight: null, lastUsed: now(), version: 0, built: null };
      cache.set(m.id, e);
      if (cache.size > MAX_ENTRIES) {
        const old = [...cache.values()].filter((x) => !x.inflight && x !== e).sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (old) cache.delete(old.marketId);
      }
    }
    return e;
  }

  const pending = (e: Entry) => [...e.sigs.values()].filter((s) => !s.done);

  async function scanSignatures(e: Entry) {
    if (!e.scan) e.scan = { until: e.newestSig, before: null, rows: [] };
    const scan = e.scan;
    for (let page = 0; page < SIG_PAGES_PER_REFRESH; page++) {
      const params: Record<string, unknown> = { limit: SIG_PAGE, commitment: "confirmed" };
      if (scan.until) params.until = scan.until;
      if (scan.before) params.before = scan.before;
      const rows = await deps.rpc<SigRow[]>("getSignaturesForAddress", [e.curve, params]);
      e.lastSuccessAt = now();
      scan.rows.push(...rows);
      if (rows.length) scan.before = rows[rows.length - 1].signature;
      const exhausted = rows.length < SIG_PAGE;
      const windowFull = !scan.until && scan.rows.length >= FIRST_WINDOW;
      if (exhausted || windowFull) {
        // Scan closed with no gap: rank newest-first rows so older ones get lower ranks, then advance the anchor.
        for (let i = scan.rows.length - 1; i >= 0; i--) {
          const r = scan.rows[i];
          if (e.sigs.has(r.signature)) continue;
          const rank = ++e.highRank;
          if (r.err != null) { e.failedTx++; continue; } // failed transactions can't contain valid swaps
          e.sigs.set(r.signature, { signature: r.signature, slot: r.slot, rank, tries: 0, done: false });
        }
        if (scan.rows.length) e.newestSig = scan.rows[0].signature;
        e.scan = null;
        const p = pending(e);
        if (p.length > MAX_PENDING) {
          for (const s of p.sort((a, b) => a.rank - b.rank).slice(0, p.length - MAX_PENDING)) { s.done = true; e.droppedTx++; }
        }
        return;
      }
    }
    // Page budget used up: keep the cursor and the old anchor; newer transactions are not skipped.
  }

  async function decodeTransactions(e: Entry) {
    const batch = pending(e).sort((a, b) => b.rank - a.rank).slice(0, TX_PER_REFRESH);
    for (const s of batch) {
      const tx = await deps.rpc<any>("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      e.lastSuccessAt = now();
      if (tx == null) { // not yet available on this RPC node: retry later, never mark processed
        if (++s.tries >= MAX_NULL_TRIES) { s.done = true; e.missingTx++; }
        continue;
      }
      s.done = true;
      e.scanned++;
      const r = extractSwaps(tx, s.signature, e.curve, e.mint);
      e.rejectedEvents += r.rejectedEvents;
      if (r.reason === "failed_tx") e.failedTx++;
      else if (!r.swaps.length) e.nonSwapTx++;
      for (const w of r.swaps) {
        if (e.swaps.has(w.id)) continue;
        e.swaps.set(w.id, { ...w, rank: s.rank });
        e.version++;
        stats.swapsDecoded++;
      }
    }
  }

  async function refresh(e: Entry) {
    stats.refreshes++;
    e.attemptedAt = now();
    try {
      if (e.scan || !e.completedAt || now() - e.completedAt >= TTL_MS || !e.newestSig) await scanSignatures(e);
      await decodeTransactions(e);
      e.failure = null;
      if (!e.scan && pending(e).length === 0) e.completedAt = now();
    } catch (err) {
      stats.failures++;
      // Keep every decoded swap and the scan cursor; report the failure kind alongside them.
      e.failure = err instanceof RpcLimited
        ? { kind: "rate_limited", message: `Solana RPC rate limited (HTTP ${err.status}); backing off`, at: now() }
        : { kind: "unavailable", message: "Solana RPC request failed", at: now() };
      log("warn", "history refresh failed", { market: e.marketId, err: String(err) });
    }
  }

  function builderFor(e: Entry) {
    if (e.built?.version === e.version) return e.built.builder;
    const b = new CandleBuilder(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    for (const s of e.swaps.values()) b.add({ id: orderKey(s), ts: s.blockTime * 1000, price: s.price, baseQty: s.baseQty, quoteQty: s.quoteQty, side: s.side });
    e.built = { version: e.version, builder: b };
    return b;
  }

  function due(e: Entry) {
    if (e.inflight || deps.coolingDown()) return false;
    const since = now() - e.attemptedAt;
    if (e.failure) return since >= TTL_MS;
    if (e.scan || pending(e).length) return since >= CONTINUE_MS;
    return !e.completedAt || now() - e.completedAt >= TTL_MS;
  }

  /** Coherent snapshot of cached history; kicks off a deduplicated background refresh when due. */
  function history(m: Market | undefined, id: string, intervalSec: number) {
    const sup = checkSupport(m, id);
    if (!sup.ok) return { state: sup.state as HistoryState, error: sup.reason, candles: [] as Candle[], swaps: 0, lastSuccessAt: null, completedAt: null };
    const e = entry(m!);
    e.lastUsed = now();
    if (due(e)) e.inflight = refresh(e).finally(() => { e.inflight = null; });
    const b = builderFor(e);
    const candles = b.candles(intervalSec);
    const used = candles.reduce((n, c) => n + c.buys + c.sells, 0);
    const times = [...e.swaps.values()].map((s) => s.blockTime);
    const pend = pending(e).length;
    const state: HistoryState =
      !e.lastSuccessAt && !e.failure ? "loading"
      : e.failure ? e.failure.kind
      : e.scan || pend ? "partial"
      : used ? "ok" : "empty";
    return {
      state, refreshing: !!e.inflight, candles, swaps: used,
      lastSuccessAt: e.lastSuccessAt, completedAt: e.completedAt, error: e.failure?.message ?? null, failureAt: e.failure?.at ?? null,
      scannedTransactions: e.scanned, pendingTransactions: pend + (e.scan ? e.scan.rows.length : 0), missingTransactions: e.missingTx + e.droppedTx,
      nonSwapTransactions: e.nonSwapTx, failedTransactions: e.failedTx, rejectedEvents: e.rejectedEvents,
      oldestTs: times.length ? Math.min(...times) : null, newestTs: times.length ? Math.max(...times) : null,
      curveStatus: sup.curveStatus, windowSignatures: FIRST_WINDOW, ttlSec: TTL_MS / 1000,
    };
  }

  return { history, stats, _inflight: (id: string) => cache.get(id)?.inflight ?? null };
}

const service = createHistoryService({ rpc: defaultRpc, coolingDown: rpcCoolingDown });
export const history = service.history;
export const historyStats = service.stats;
