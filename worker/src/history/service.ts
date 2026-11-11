import { CandleBuilder, type Candle } from "../../../src/lib/market/candles.ts";
import { log } from "../log.ts";
import { rpc as defaultRpc, RpcLimited, rpcStats, rpcCoolingDown } from "./rpc.ts";
import { bondingCurvePda, extractSwaps, type VerifiedSwap } from "./pumpEvents.ts";
import { marketId, type Market } from "../store.ts";

// Read-only chart history for viewed Pump.fun curves, from public Solana RPC.
// Kept entirely separate from the Store: it never touches executable state, quotes or paper orders.
//
// Identity vs order: a swap's identity is `signature:instructionPosition`. Its chart order is
// slot -> position within the slot -> event position. Within a slot we use the RPC's `transactionIndex` when every
// retained swap in that slot has a valid one; otherwise we fall back to the RPC's newest-first listing order
// (deterministic, but not guaranteed to be true execution order).
export const TTL_MS = 20_000;          // refresh a finished scan at most this often
const CONTINUE_MS = 2_000;             // continue an in-progress scan this soon
const SIG_PAGE = 100;                  // signatures per getSignaturesForAddress page
const FIRST_WINDOW = 100;              // first view: only the most recent N signatures (older history is never fetched)
const SIG_PAGES_PER_REFRESH = 3;
const TX_PER_REFRESH = 30;
const MAX_TRIES = 5;                   // getTransaction null/transport error -> retry, then report (never "complete")
const MAX_PENDING = 600;               // pending beyond this: oldest dropped and counted as a gap
export const MAX_SCAN_ROWS = 600;      // an open scan longer than this is closed early; the older remainder is a disclosed gap
export const MAX_SWAPS = 5_000;        // retained swaps per market; oldest trimmed and disclosed
export const MAX_DONE_SIGS = 3_000;    // retained processed signatures per market (dedup only); oldest forgotten
const MAX_ENTRIES = 40;

export type HistoryState = "ok" | "partial" | "empty" | "loading" | "rate_limited" | "unavailable" | "unsupported" | "unknown_market";
export type Coverage = "in_progress" | "complete" | "incomplete";

interface SigMeta { signature: string; slot: number; rank: number; txIndex: number | null; tries: number; lastErr: "transport" | "null" | null; done: boolean }
interface RankedSwap extends VerifiedSwap { rank: number; txIndex: number | null }
interface SigRow { signature: string; slot: number; err: unknown; blockTime: number | null; transactionIndex?: number | null }

interface Entry {
  marketId: string; curve: string; mint: string;
  sigs: Map<string, SigMeta>; swaps: Map<string, RankedSwap>;
  newestSig: string | null; // newest signature of the last closed signature scan
  scan: { until: string | null; before: string | null; rows: SigRow[] } | null;
  highRank: number; scanned: number; nonSwapTx: number; failedTx: number; rejectedEvents: number;
  missingTx: number; transportFailedTx: number; droppedTx: number; scanGaps: number; trimmedSwaps: number; trimmedBeforeTs: number | null;
  lastRpcAt: number | null; lastDataAt: number | null; scanDoneAt: number | null; completedAt: number | null; attemptedAt: number;
  failure: { kind: "rate_limited" | "unavailable"; message: string; at: number } | null;
  lastTxError: { message: string; at: number } | null;
  inflight: Promise<void> | null; lastUsed: number; version: number; built: { version: number; builder: CandleBuilder } | null;
}

export interface HistoryDeps { rpc: <T>(method: string, params: unknown[]) => Promise<T>; coolingDown: () => boolean; cooldownUntil?: () => number; now?: () => number }

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

const validIdx = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/** Deterministic chart order for retained swaps (see header). */
export function orderSwaps<T extends { slot: number; rank: number; txIndex: number | null; eventIndex: number }>(list: T[]): T[] {
  const slotHasAllIdx = new Map<number, boolean>();
  for (const s of list) slotHasAllIdx.set(s.slot, (slotHasAllIdx.get(s.slot) ?? true) && s.txIndex != null);
  return [...list].sort((a, b) => {
    if (a.slot !== b.slot) return a.slot - b.slot;
    const useIdx = slotHasAllIdx.get(a.slot);
    const d = useIdx ? a.txIndex! - b.txIndex! : a.rank - b.rank;
    return d || a.rank - b.rank || a.eventIndex - b.eventIndex;
  });
}

export function createHistoryService(deps: HistoryDeps) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, Entry>();
  const stats = { refreshes: 0, failures: 0, swapsDecoded: 0, entries: () => cache.size, rpc: rpcStats };

  function entry(m: Market): Entry {
    let e = cache.get(m.id);
    if (!e) {
      e = { marketId: m.id, curve: m.address, mint: m.mint, sigs: new Map(), swaps: new Map(), newestSig: null, scan: null, highRank: 0,
        scanned: 0, nonSwapTx: 0, failedTx: 0, rejectedEvents: 0, missingTx: 0, transportFailedTx: 0, droppedTx: 0, scanGaps: 0,
        trimmedSwaps: 0, trimmedBeforeTs: null, lastRpcAt: null, lastDataAt: null, scanDoneAt: null, completedAt: null, attemptedAt: 0,
        failure: null, lastTxError: null, inflight: null, lastUsed: now(), version: 0, built: null };
      cache.set(m.id, e);
      if (cache.size > MAX_ENTRIES) {
        const old = [...cache.values()].filter((x) => !x.inflight && x !== e).sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (old) cache.delete(old.marketId);
      }
    }
    return e;
  }

  const pending = (e: Entry) => [...e.sigs.values()].filter((s) => !s.done);

  function closeScan(e: Entry, rows: SigRow[]) {
    // Rank newest-first rows so older ones get lower ranks; ranks only ever increase, so they stay unique.
    const seen = new Set<string>();
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (seen.has(r.signature) || e.sigs.has(r.signature)) continue;
      seen.add(r.signature);
      const rank = ++e.highRank;
      if (r.err != null) { e.failedTx++; continue; } // failed transactions can't contain valid swaps
      e.sigs.set(r.signature, { signature: r.signature, slot: r.slot, rank, txIndex: validIdx(r.transactionIndex), tries: 0, lastErr: null, done: false });
    }
    if (rows.length) e.newestSig = rows[0].signature;
    e.scan = null;
    e.scanDoneAt = now();
    const p = pending(e);
    if (p.length > MAX_PENDING) for (const s of p.sort((a, b) => a.rank - b.rank).slice(0, p.length - MAX_PENDING)) { s.done = true; e.droppedTx++; }
    // Forget the oldest processed signatures (dedup only; the scan anchor never re-lists them).
    const done = [...e.sigs.values()].filter((s) => s.done);
    if (done.length > MAX_DONE_SIGS) for (const s of done.sort((a, b) => a.rank - b.rank).slice(0, done.length - MAX_DONE_SIGS)) e.sigs.delete(s.signature);
  }

  async function scanSignatures(e: Entry) {
    if (!e.scan) e.scan = { until: e.newestSig, before: null, rows: [] };
    const scan = e.scan;
    for (let page = 0; page < SIG_PAGES_PER_REFRESH; page++) {
      const params: Record<string, unknown> = { limit: SIG_PAGE, commitment: "confirmed" };
      if (scan.until) params.until = scan.until;
      if (scan.before) params.before = scan.before;
      const rows = await deps.rpc<SigRow[]>("getSignaturesForAddress", [e.curve, params]);
      e.lastRpcAt = now();
      scan.rows.push(...rows);
      if (rows.length) scan.before = rows[rows.length - 1].signature;
      const exhausted = rows.length < SIG_PAGE;
      const windowFull = !scan.until && scan.rows.length >= FIRST_WINDOW;
      if (exhausted || windowFull) return closeScan(e, scan.rows);
      if (scan.rows.length >= MAX_SCAN_ROWS) {
        // Too busy to close the gap back to the anchor within bounds: keep the newest rows and disclose the gap.
        e.scanGaps++;
        log("warn", "history scan gap", { market: e.marketId, rows: scan.rows.length });
        return closeScan(e, scan.rows.slice(0, MAX_SCAN_ROWS));
      }
    }
    // Page budget used up: keep the cursor and the old anchor; newer transactions are not skipped.
  }

  function trimSwaps(e: Entry) {
    if (e.swaps.size <= MAX_SWAPS) return;
    const ordered = orderSwaps([...e.swaps.values()]);
    for (const s of ordered.slice(0, e.swaps.size - MAX_SWAPS)) { e.swaps.delete(s.id); e.trimmedSwaps++; }
    const first = ordered[ordered.length - MAX_SWAPS];
    e.trimmedBeforeTs = first ? first.blockTime : e.trimmedBeforeTs;
    e.version++;
  }

  async function decodeTransactions(e: Entry) {
    const batch = pending(e).sort((a, b) => b.rank - a.rank).slice(0, TX_PER_REFRESH);
    for (const s of batch) {
      let tx: any;
      try {
        tx = await deps.rpc<any>("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
      } catch (err) {
        if (err instanceof RpcLimited) throw err;
        // One bad transaction must not block the rest. Retry, then report it as a transport failure (not "missing").
        s.lastErr = "transport";
        e.lastTxError = { message: String((err as Error)?.message ?? err), at: now() };
        if (++s.tries >= MAX_TRIES) { s.done = true; e.transportFailedTx++; }
        log("warn", "history transaction fetch failed", { market: e.marketId, signature: s.signature, err: String(err) });
        continue;
      }
      e.lastRpcAt = now();
      if (tx == null) { // not yet available on this RPC node: retry later, never mark processed
        s.lastErr = "null";
        if (++s.tries >= MAX_TRIES) { s.done = true; e.missingTx++; }
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
        e.swaps.set(w.id, { ...w, rank: s.rank, txIndex: s.txIndex });
        e.version++;
        e.lastDataAt = now();
        stats.swapsDecoded++;
      }
    }
    trimSwaps(e);
  }

  const gapCount = (e: Entry) => e.missingTx + e.transportFailedTx + e.droppedTx + e.scanGaps + e.trimmedSwaps;

  async function refresh(e: Entry) {
    stats.refreshes++;
    e.attemptedAt = now();
    try {
      if (e.scan || !e.scanDoneAt || now() - e.scanDoneAt >= TTL_MS || !e.newestSig) await scanSignatures(e);
      await decodeTransactions(e);
      e.failure = null;
      // completedAt means full coverage of the scanned window: nothing pending and nothing lost or rejected.
      if (!e.scan && pending(e).length === 0 && gapCount(e) === 0 && e.rejectedEvents === 0) e.completedAt = now();
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
    // CandleBuilder breaks same-timestamp ties by id, so ids here are the zero-padded chart order.
    orderSwaps([...e.swaps.values()]).forEach((s, i) =>
      b.add({ id: String(i).padStart(10, "0"), ts: s.blockTime * 1000, price: s.price, baseQty: s.baseQty, quoteQty: s.quoteQty, side: s.side }));
    e.built = { version: e.version, builder: b };
    return b;
  }

  function wantsWork(e: Entry) {
    if (e.inflight) return false;
    const since = now() - e.attemptedAt;
    if (e.failure) return since >= TTL_MS;
    if (e.scan || pending(e).length) return since >= CONTINUE_MS;
    return !e.scanDoneAt || now() - e.scanDoneAt >= TTL_MS;
  }

  /** Coherent snapshot of cached history; kicks off a deduplicated background refresh when due. */
  function history(m: Market | undefined, id: string, intervalSec: number) {
    const sup = checkSupport(m, id);
    if (!sup.ok) return { state: sup.state as HistoryState, error: sup.reason, candles: [] as Candle[], swaps: 0, lastSuccessAt: null, lastDataAt: null, completedAt: null };
    const e = entry(m!);
    e.lastUsed = now();
    const want = wantsWork(e);
    const cooling = deps.coolingDown();
    if (want && !cooling) e.inflight = refresh(e).finally(() => { e.inflight = null; });
    const blockedByCooldown = want && cooling;
    const b = builderFor(e);
    const candles = b.candles(intervalSec);
    const used = candles.reduce((n, c) => n + c.buys + c.sells, 0);
    let oldest: number | null = null, newest: number | null = null;
    for (const s of e.swaps.values()) { if (oldest == null || s.blockTime < oldest) oldest = s.blockTime; if (newest == null || s.blockTime > newest) newest = s.blockTime; }
    const pend = pending(e).length + (e.scan ? e.scan.rows.length : 0);
    const gaps = gapCount(e);
    const coverage: Coverage = !e.scanDoneAt || e.scan || pend ? "in_progress" : gaps || e.rejectedEvents ? "incomplete" : "complete";
    const retryAt = blockedByCooldown ? (deps.cooldownUntil?.() ?? null) : null;
    let state: HistoryState;
    let error: string | null = e.failure?.message ?? null;
    if (e.failure) state = e.failure.kind;
    else if (blockedByCooldown && coverage !== "complete") { state = "rate_limited"; error = "Solana RPC is cooling down after a rate limit; will retry"; }
    else if (!e.lastRpcAt) state = "loading";
    else if (coverage === "complete") state = used ? "ok" : "empty";
    else if (coverage === "incomplete" && !used && e.transportFailedTx > 0 && e.scanned === 0) { state = "unavailable"; error = e.lastTxError ? `Solana RPC transaction requests failed (${e.lastTxError.message})` : "Solana RPC transaction requests failed"; }
    else state = "partial";
    return {
      state, coverage, refreshing: !!e.inflight, candles, swaps: used,
      lastSuccessAt: e.lastRpcAt, lastDataAt: e.lastDataAt, completedAt: e.completedAt, error, failureAt: e.failure?.at ?? null, retryAt,
      scannedTransactions: e.scanned, pendingTransactions: pend,
      missingTransactions: e.missingTx, transportFailedTransactions: e.transportFailedTx, droppedTransactions: e.droppedTx,
      scanGaps: e.scanGaps, trimmedSwaps: e.trimmedSwaps, trimmedBeforeTs: e.trimmedBeforeTs,
      nonSwapTransactions: e.nonSwapTx, failedTransactions: e.failedTx, rejectedEvents: e.rejectedEvents,
      oldestTs: oldest, newestTs: newest,
      curveStatus: sup.curveStatus, windowSignatures: FIRST_WINDOW, ttlSec: TTL_MS / 1000,
    };
  }

  return { history, stats, _inflight: (id: string) => cache.get(id)?.inflight ?? null };
}

const service = createHistoryService({ rpc: defaultRpc, coolingDown: rpcCoolingDown, cooldownUntil: () => rpcStats.cooldownUntil });
export const history = service.history;
export const historyStats = service.stats;
