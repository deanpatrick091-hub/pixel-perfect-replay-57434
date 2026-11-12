import { CandleBuilder, type Candle } from "../../../src/lib/market/candles.ts";
import { log } from "../log.ts";
import { RpcBusy, RpcForbidden, RpcLimited, isBackoff, type Priority } from "./rpc.ts";
import { bondingCurvePda, extractSwaps, type VerifiedSwap } from "./pumpEvents.ts";
import { marketId, type Market } from "../store.ts";

// Read-only chart history for viewed Pump.fun curves, from public Solana RPC.
// Kept entirely separate from the Store: it never touches executable state, quotes or paper orders.
//
// Work order per market: live hints (logsSubscribe) > newest signatures > older backfill.
// Identity vs order: a swap's identity is `signature:instructionPosition`. Its chart order is
// slot -> position within the slot -> event position. Within a slot we use the RPC's `transactionIndex` when every
// retained swap in that slot has a valid one; otherwise the RPC's listing order (deterministic, not guaranteed
// to be true execution order). Live hints get provisional ranks; a later signature listing adds transactionIndex.
export const TTL_MS = 15_000;          // re-list newest signatures at most this often
const CONTINUE_MS = 1_500;             // continue in-progress work this soon
const FAIL_RETRY_MS = 5_000;           // retry after a non-rate-limit failure
const SIG_PAGE = 100;
const FIRST_WINDOW = 100;              // first view seeds from the newest N signatures, then backfills older ones
export const BACKFILL_MAX_SIGS = 1_000; // older history: at most this many signatures listed in total...
export const BACKFILL_MAX_AGE_SEC = 3_600; // ...and no older than this before the newest swap at first view
const BACKFILL_AHEAD = 100;            // don't list more older signatures than this ahead of decoding
const SIG_PAGES_PER_REFRESH = 3;
const TX_PER_REFRESH = 30;
export const MAX_TRIES = 8;            // null / transport error: retried with backoff (~3 min) before being reported
const RETRY_BASE_MS = 1_000, RETRY_MAX_MS = 60_000;
const MAX_PENDING = 600;
export const MAX_SCAN_ROWS = 600;
export const MAX_SWAPS = 5_000;
export const MAX_DONE_SIGS = 3_000;
const MAX_ENTRIES = 40;
export const VIEW_MS = 35_000;         // a market counts as viewed this long after its last history poll
const MAX_AGAIN = 4;

export type HistoryState = "ok" | "partial" | "empty" | "loading" | "rate_limited" | "unavailable" | "unsupported" | "unknown_market";
export type Coverage = "in_progress" | "complete" | "incomplete";
export type BackfillState = "waiting" | "in_progress" | "done_start" | "done_limit" | "done_age";

interface SigMeta {
  signature: string; slot: number; rank: number; txIndex: number | null; prio: Priority;
  tries: number; nextTryAt: number; lastErr: "transport" | "null" | null; done: boolean; busy: boolean; hintAt: number | null;
}
interface RankedSwap extends VerifiedSwap { rank: number; txIndex: number | null }
interface SigRow { signature: string; slot: number; err: unknown; blockTime: number | null; transactionIndex?: number | null }

interface Entry {
  marketId: string; curve: string; mint: string;
  sigs: Map<string, SigMeta>; open: Set<SigMeta>; swaps: Map<string, RankedSwap>;
  newestSig: string | null;
  scan: { until: string | null; before: string | null; rows: SigRow[] } | null;
  back: { state: BackfillState; before: string | null; listed: number; floorTs: number | null; oldestTs: number | null };
  highRank: number; lowRank: number; scanned: number; nonSwapTx: number; failedTx: number; rejectedEvents: number;
  missingTx: number; transportFailedTx: number; droppedTx: number; scanGaps: number; trimmedSwaps: number; trimmedBeforeTs: number | null;
  lastRpcAt: number | null; lastDataAt: number | null; scanDoneAt: number | null; completedAt: number | null; attemptedAt: number;
  failure: { kind: "rate_limited" | "unavailable"; message: string; at: number } | null;
  lastTxError: { message: string; at: number } | null;
  live: { hints: number; swaps: number; lastHintAt: number | null; hintToChartMs: number | null; chainToChartMs: number | null };
  inflight: Promise<void> | null; again: boolean; lastUsed: number; version: number; built: { version: number; builder: CandleBuilder } | null;
}

export interface LiveView { state: (curve: string) => string; stats: { reconnects: number; failedExcluded: number; lastError: string | null } }
export interface HistoryDeps {
  rpc: <T>(method: string, params: unknown[], prio?: Priority) => Promise<T>;
  coolingDown: () => boolean; cooldownUntil?: () => number; now?: () => number;
  /** Schedules follow-up work for viewed markets (tests pass a no-op). */
  later?: (fn: () => void, ms: number) => void;
  onChange?: (marketId: string) => void;
  live?: LiveView;
}

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

const retryDelay = (tries: number) => Math.min(RETRY_BASE_MS * 2 ** (tries - 1), RETRY_MAX_MS);

export function createHistoryService(deps: HistoryDeps) {
  const now = deps.now ?? Date.now;
  const later = deps.later ?? ((fn, ms) => { (setTimeout(fn, ms) as any).unref?.(); });
  const cache = new Map<string, Entry>();
  const byCurve = new Map<string, Entry>();
  const stats = { refreshes: 0, failures: 0, swapsDecoded: 0, liveHints: 0, liveSwaps: 0, entries: () => cache.size };

  function entry(m: Market): Entry {
    let e = cache.get(m.id);
    if (!e) {
      e = { marketId: m.id, curve: m.address, mint: m.mint, sigs: new Map(), open: new Set(), swaps: new Map(), newestSig: null, scan: null,
        back: { state: "waiting", before: null, listed: 0, floorTs: null, oldestTs: null },
        highRank: 0, lowRank: 0, scanned: 0, nonSwapTx: 0, failedTx: 0, rejectedEvents: 0, missingTx: 0, transportFailedTx: 0, droppedTx: 0, scanGaps: 0,
        trimmedSwaps: 0, trimmedBeforeTs: null, lastRpcAt: null, lastDataAt: null, scanDoneAt: null, completedAt: null, attemptedAt: 0,
        failure: null, lastTxError: null, live: { hints: 0, swaps: 0, lastHintAt: null, hintToChartMs: null, chainToChartMs: null },
        inflight: null, again: false, lastUsed: now(), version: 0, built: null };
      cache.set(m.id, e); byCurve.set(m.address, e);
      if (cache.size > MAX_ENTRIES) {
        const old = [...cache.values()].filter((x) => !x.inflight && x !== e).sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (old) { cache.delete(old.marketId); byCurve.delete(old.curve); }
      }
    }
    return e;
  }

  const addSig = (e: Entry, r: { signature: string; slot: number; transactionIndex?: unknown }, rank: number, prio: Priority, hintAt: number | null = null) => {
    const s: SigMeta = { signature: r.signature, slot: r.slot, rank, txIndex: validIdx(r.transactionIndex), prio, tries: 0, nextTryAt: 0, lastErr: null, done: false, busy: false, hintAt };
    e.sigs.set(s.signature, s); e.open.add(s);
    return s;
  };
  const finish = (e: Entry, s: SigMeta) => { s.done = true; e.open.delete(s); };

  function learnIndex(e: Entry, r: SigRow) {
    // A live-hinted signature learns its RPC transactionIndex once the listing returns it.
    const known = e.sigs.get(r.signature);
    const idx = validIdx(r.transactionIndex);
    if (!known || known.txIndex != null || idx == null) return;
    known.txIndex = idx;
    for (const w of e.swaps.values()) if (w.signature === r.signature) { w.txIndex = idx; e.version++; }
  }

  function closeScan(e: Entry, rows: SigRow[]) {
    const seen = new Set<string>();
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (seen.has(r.signature)) continue;
      seen.add(r.signature);
      if (e.sigs.has(r.signature)) { learnIndex(e, r); continue; }
      const rank = ++e.highRank;
      if (r.err != null) { e.failedTx++; continue; }
      addSig(e, r, rank, 1);
    }
    const first = !e.scanDoneAt;
    if (rows.length) e.newestSig = rows[0].signature;
    e.scan = null;
    e.scanDoneAt = now();
    if (first && e.back.state === "waiting") {
      // Seeded from the newest window; older history is fetched progressively within fixed bounds.
      const newestTs = rows.find((r) => r.blockTime)?.blockTime ?? Math.floor(now() / 1000);
      const oldest = rows[rows.length - 1];
      e.back.listed = seen.size;
      e.back.oldestTs = oldest?.blockTime ?? null;
      e.back.floorTs = newestTs - BACKFILL_MAX_AGE_SEC;
      if (rows.length < FIRST_WINDOW) e.back.state = "done_start";
      else if (e.back.listed >= BACKFILL_MAX_SIGS) e.back.state = "done_limit";
      else if (oldest?.blockTime != null && oldest.blockTime < e.back.floorTs) e.back.state = "done_age";
      else { e.back.state = "in_progress"; e.back.before = oldest.signature; }
    }
    const p = [...e.open];
    if (p.length > MAX_PENDING) for (const s of p.sort((a, b) => a.rank - b.rank).slice(0, p.length - MAX_PENDING)) { finish(e, s); e.droppedTx++; }
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
      const rows = await deps.rpc<SigRow[]>("getSignaturesForAddress", [e.curve, params], 1);
      e.lastRpcAt = now();
      scan.rows.push(...rows);
      if (rows.length) scan.before = rows[rows.length - 1].signature;
      const exhausted = rows.length < SIG_PAGE;
      const windowFull = !scan.until && scan.rows.length >= FIRST_WINDOW;
      if (exhausted || windowFull) return closeScan(e, scan.rows);
      if (scan.rows.length >= MAX_SCAN_ROWS) {
        e.scanGaps++;
        log("warn", "history scan gap", { market: e.marketId, rows: scan.rows.length });
        return closeScan(e, scan.rows.slice(0, MAX_SCAN_ROWS));
      }
    }
  }

  const backfillDue = (e: Entry) => e.back.state === "in_progress" && !e.scan &&
    [...e.open].filter((s) => s.prio < 2).length < 10 && [...e.open].filter((s) => s.prio === 2).length < BACKFILL_AHEAD;

  async function backfillPage(e: Entry) {
    const b = e.back;
    const rows = await deps.rpc<SigRow[]>("getSignaturesForAddress", [e.curve, { limit: SIG_PAGE, commitment: "confirmed", before: b.before }], 2);
    e.lastRpcAt = now();
    for (const r of rows) { // newest first: each older row gets a lower rank
      if (b.floorTs != null && r.blockTime != null && r.blockTime < b.floorTs) { b.state = "done_age"; break; }
      if (b.listed >= BACKFILL_MAX_SIGS) { b.state = "done_limit"; break; }
      b.before = r.signature;
      if (e.sigs.has(r.signature)) { learnIndex(e, r); continue; }
      b.listed++;
      if (r.blockTime != null) b.oldestTs = r.blockTime;
      const rank = --e.lowRank;
      if (r.err != null) { e.failedTx++; continue; }
      addSig(e, r, rank, 2);
    }
    if (b.state === "in_progress" && rows.length < SIG_PAGE) b.state = "done_start";
    if (b.state === "in_progress" && b.listed >= BACKFILL_MAX_SIGS) b.state = "done_limit";
  }

  function trimSwaps(e: Entry) {
    if (e.swaps.size <= MAX_SWAPS) return;
    const ordered = orderSwaps([...e.swaps.values()]);
    for (const s of ordered.slice(0, e.swaps.size - MAX_SWAPS)) { e.swaps.delete(s.id); e.trimmedSwaps++; }
    const first = ordered[ordered.length - MAX_SWAPS];
    e.trimmedBeforeTs = first ? first.blockTime : e.trimmedBeforeTs;
    e.version++;
  }

  function nextSig(e: Entry, maxPrio: Priority): SigMeta | null {
    const t = now();
    let best: SigMeta | null = null;
    for (const s of e.open) {
      if (s.busy || s.nextTryAt > t || s.prio > maxPrio) continue;
      if (!best || s.prio < best.prio || (s.prio === best.prio && s.rank > best.rank)) best = s;
    }
    return best;
  }

  function retryLater(e: Entry, s: SigMeta, kind: "transport" | "null") {
    s.lastErr = kind;
    s.tries++;
    if (s.tries >= MAX_TRIES) { finish(e, s); if (kind === "null") e.missingTx++; else e.transportFailedTx++; }
    else s.nextTryAt = now() + retryDelay(s.tries);
  }

  async function decodeTransactions(e: Entry, maxPrio: Priority, budget: number) {
    for (let i = 0; i < budget; i++) {
      const s = nextSig(e, maxPrio);
      if (!s) return;
      s.busy = true;
      let tx: any;
      try {
        tx = await deps.rpc<any>("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }], s.prio);
      } catch (err) {
        s.busy = false;
        if (isBackoff(err)) throw err;
        if (err instanceof RpcBusy) return; // shared queue full: try again next round, no try counted
        e.lastTxError = { message: String((err as Error)?.message ?? err), at: now() };
        retryLater(e, s, "transport");
        continue;
      }
      s.busy = false;
      e.lastRpcAt = now();
      // Not yet available on this node (common right after a live hint), or no block time yet: retry, never mark processed.
      if (tx == null || typeof tx.blockTime !== "number") { retryLater(e, s, "null"); continue; }
      finish(e, s);
      e.scanned++;
      const r = extractSwaps(tx, s.signature, e.curve, e.mint);
      e.rejectedEvents += r.rejectedEvents;
      if (r.reason === "failed_tx") e.failedTx++;
      else if (!r.swaps.length) e.nonSwapTx++;
      let added = 0;
      for (const w of r.swaps) {
        if (e.swaps.has(w.id)) continue;
        e.swaps.set(w.id, { ...w, rank: s.rank, txIndex: s.txIndex });
        added++;
      }
      if (added) {
        e.version++; e.lastDataAt = now(); stats.swapsDecoded += added;
        if (s.hintAt != null) {
          e.live.swaps += added; stats.liveSwaps += added;
          e.live.hintToChartMs = now() - s.hintAt;
          e.live.chainToChartMs = now() - r.swaps[0].blockTime * 1000;
        }
        trimSwaps(e);
        deps.onChange?.(e.marketId);
      }
    }
  }

  const gapCount = (e: Entry) => e.missingTx + e.transportFailedTx + e.droppedTx + e.scanGaps + e.trimmedSwaps;
  const scanDue = (e: Entry) => !!e.scan || !e.scanDoneAt || now() - e.scanDoneAt >= TTL_MS || !e.newestSig;
  const viewed = (e: Entry) => now() - e.lastUsed < VIEW_MS;

  async function refreshOnce(e: Entry) {
    stats.refreshes++;
    e.attemptedAt = now();
    try {
      await decodeTransactions(e, 0, 10);                 // live hints first
      if (scanDue(e)) await scanSignatures(e);            // newest signatures (gap-safe catch-up)
      await decodeTransactions(e, 2, TX_PER_REFRESH);     // live > recent > backfill
      if (backfillDue(e)) await backfillPage(e);          // progressively list older signatures
      e.failure = null;
      if (!e.scan && e.open.size === 0 && e.back.state !== "in_progress" && gapCount(e) === 0 && e.rejectedEvents === 0) e.completedAt = now();
    } catch (err) {
      stats.failures++;
      e.failure = err instanceof RpcLimited
        ? { kind: "rate_limited", message: `Solana RPC rate limited (HTTP ${err.status}); backing off`, at: now() }
        : err instanceof RpcForbidden
          ? { kind: "unavailable", message: "Solana RPC refused access (HTTP 403); backing off", at: now() }
          : { kind: "unavailable", message: `Solana RPC request failed: ${(err as Error)?.message ?? err}`, at: now() };
      log("warn", "history refresh failed", { market: e.marketId, err: String(err) });
    }
  }

  function moreWork(e: Entry) {
    return !!e.scan || backfillDue(e) || [...e.open].some((s) => !s.busy);
  }

  function kick(e: Entry) {
    if (e.inflight) { e.again = true; return; }
    if (deps.coolingDown()) return;
    e.inflight = (async () => {
      let n = 0;
      do { e.again = false; await refreshOnce(e); } while (e.again && !e.failure && !deps.coolingDown() && ++n < MAX_AGAIN);
    })().finally(() => {
      e.inflight = null;
      // Keep working while someone is viewing; polling also drives this, so a missed timer is harmless.
      if (viewed(e) && !e.failure && moreWork(e)) later(() => { if (!e.inflight && viewed(e)) kick(e); }, CONTINUE_MS);
    });
  }

  function wantsWork(e: Entry) {
    if (e.inflight) return false;
    const since = now() - e.attemptedAt;
    if (e.failure) return since >= FAIL_RETRY_MS; // kick() also waits out any global cooldown
    if (moreWork(e)) return since >= CONTINUE_MS;
    return scanDue(e);
  }

  /** A confirmed, non-failed transaction mentioned a viewed curve: fetch and validate it before anything else. */
  function hint(h: { curve: string; signature: string; slot: number; receivedAt: number }) {
    const e = byCurve.get(h.curve);
    if (!e) return;
    stats.liveHints++; e.live.hints++; e.live.lastHintAt = h.receivedAt;
    const known = e.sigs.get(h.signature);
    if (known) { if (!known.done) { known.prio = 0; known.nextTryAt = 0; known.hintAt ??= h.receivedAt; } }
    else if (e.open.size < MAX_PENDING) addSig(e, { signature: h.signature, slot: h.slot }, ++e.highRank, 0, h.receivedAt);
    else return; // backlog full: the next signature scan lists it (or discloses a gap)
    kick(e);
  }

  /** Live stream reconnected: events during the outage are caught up by an immediate signature scan. */
  function catchUp(curves: string[]) {
    for (const c of curves) { const e = byCurve.get(c); if (e) { e.scanDoneAt = 0; kick(e); } }
  }

  function viewedCurves() {
    return [...cache.values()].filter(viewed).sort((a, b) => b.lastUsed - a.lastUsed).map((e) => e.curve);
  }

  function builderFor(e: Entry) {
    if (e.built?.version === e.version) return e.built.builder;
    const b = new CandleBuilder(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    orderSwaps([...e.swaps.values()]).forEach((s, i) =>
      b.add({ id: String(i).padStart(10, "0"), ts: s.blockTime * 1000, price: s.price, baseQty: s.baseQty, quoteQty: s.quoteQty, side: s.side }));
    e.built = { version: e.version, builder: b };
    return b;
  }

  /** Coherent snapshot of cached history; kicks off a deduplicated background refresh when due. */
  function history(m: Market | undefined, id: string, intervalSec: number, opts: { retry?: boolean } = {}) {
    const sup = checkSupport(m, id);
    if (!sup.ok) return { state: sup.state as HistoryState, error: sup.reason, candles: [] as Candle[], swaps: 0, lastSuccessAt: null, lastDataAt: null, completedAt: null, version: 0 };
    const e = entry(m!);
    e.lastUsed = now();
    if (opts.retry && e.failure && !e.inflight) e.attemptedAt = 0;
    const want = wantsWork(e);
    const cooling = deps.coolingDown();
    if (want && !cooling) kick(e);
    const blockedByCooldown = want && cooling;
    const candles = builderFor(e).candles(intervalSec);
    const used = candles.reduce((n, c) => n + c.buys + c.sells, 0);
    let oldest: number | null = null, newest: number | null = null;
    for (const s of e.swaps.values()) { if (oldest == null || s.blockTime < oldest) oldest = s.blockTime; if (newest == null || s.blockTime > newest) newest = s.blockTime; }
    const pend = e.open.size + (e.scan ? e.scan.rows.length : 0);
    const gaps = gapCount(e);
    const coverage: Coverage = !e.scanDoneAt || e.scan || pend || e.back.state === "in_progress" ? "in_progress" : gaps || e.rejectedEvents ? "incomplete" : "complete";
    const retryAt = cooling && (blockedByCooldown || e.failure?.kind === "rate_limited") ? (deps.cooldownUntil?.() ?? null) : null;
    let state: HistoryState;
    let error: string | null = e.failure?.message ?? null;
    // A past rate limit whose cooldown has ended isn't the current state: report coverage, keep the time.
    const staleLimit = e.failure?.kind === "rate_limited" && !cooling;
    if (staleLimit) error = null;
    if (e.failure && !staleLimit) state = e.failure.kind;
    else if (blockedByCooldown && coverage !== "complete") { state = "rate_limited"; error = "Solana RPC is cooling down after a rate limit; will retry"; }
    else if (!e.lastRpcAt) state = "loading";
    else if (coverage === "complete") state = used ? "ok" : "empty";
    else if (coverage === "incomplete" && !used && e.transportFailedTx > 0 && e.scanned === 0) { state = "unavailable"; error = e.lastTxError ? `Solana RPC transaction requests failed (${e.lastTxError.message})` : "Solana RPC transaction requests failed"; }
    else state = "partial";
    const liveState = deps.live?.state(e.curve) ?? "off";
    return {
      state, coverage, refreshing: !!e.inflight, candles, swaps: used, version: e.version,
      lastRateLimitAt: e.failure?.kind === "rate_limited" ? e.failure.at : null, lastSuccessAt: e.lastRpcAt, lastDataAt: e.lastDataAt, completedAt: e.completedAt, error, failureAt: e.failure?.at ?? null, retryAt,
      scannedTransactions: e.scanned, pendingTransactions: pend,
      missingTransactions: e.missingTx, transportFailedTransactions: e.transportFailedTx, droppedTransactions: e.droppedTx,
      scanGaps: e.scanGaps, trimmedSwaps: e.trimmedSwaps, trimmedBeforeTs: e.trimmedBeforeTs,
      nonSwapTransactions: e.nonSwapTx, failedTransactions: e.failedTx, rejectedEvents: e.rejectedEvents,
      oldestTs: oldest, newestTs: newest,
      curveStatus: sup.curveStatus, windowSignatures: FIRST_WINDOW, ttlSec: TTL_MS / 1000,
      backfill: { state: e.back.state, listedSignatures: e.back.listed, oldestListedTs: e.back.oldestTs, maxSignatures: BACKFILL_MAX_SIGS, maxAgeSec: BACKFILL_MAX_AGE_SEC },
      live: {
        state: liveState, hints: e.live.hints, swaps: e.live.swaps, lastHintAt: e.live.lastHintAt,
        hintToChartMs: e.live.hintToChartMs, chainToChartMs: e.live.chainToChartMs,
        reconnects: deps.live?.stats.reconnects ?? 0, failedExcluded: deps.live?.stats.failedExcluded ?? 0, error: liveState === "streaming" ? null : deps.live?.stats.lastError ?? null,
      },
    };
  }

  return { history, hint, catchUp, viewedCurves, stats, _inflight: (id: string) => cache.get(id)?.inflight ?? null };
}
