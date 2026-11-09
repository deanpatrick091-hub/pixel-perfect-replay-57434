import { EventEmitter } from "node:events";
import { CandleBuilder, type SwapEvent } from "../../src/lib/market/candles.ts";
import { pumpCurveProgress, PUMP_CURVE } from "../../src/lib/market/quote.ts";
import { config } from "./config.ts";
import type { NormalisedLaunch, NormalisedMigration, NormalisedSwap } from "./adapters/types.ts";

export interface Market {
  id: string; chain: string; kind: "curve" | "amm"; address: string; mint: string; venue: string; quoteCcy: string;
  name: string | null; symbol: string | null; imageUri: string | null; launchedAt: number;
  status: "active" | "migrated" | "retired"; stage: "new" | "final_stretch" | "migrated";
  curveProgress: number | null; reserveQuote: number | null; reserveBase: number | null; priceQuote: number | null;
  totalSupply: number | null; circulatingSupply: number | null; liquidityUsd: number | null; liquidityAt: number | null;
  tradeFeed: "live" | "unavailable" | "unverified"; quoteModel: string | null; stateSource: string | null;
  stateUpdatedAt: number | null; migratedTo: string | null; migratedFrom: string | null; lastTradeAt: number | null;
  launchSignature: string | null;
}

export interface Trade {
  id: string; marketId: string; signature: string; eventIndex: number | null; side: "buy" | "sell";
  baseQty: number; quoteQty: number; baseDecimals: number; quoteCcy: string; priceQuote: number;
  sourceTs: number | null; receivedAt: number; trader: string | null;
}

const MAX_MARKETS = 3000;
const TAPE = 200;

export const marketId = (chain: string, kind: "curve" | "amm", addr: string) => `${chain}:${kind === "curve" ? "curve" : "pool"}:${addr}`;

export class Store extends EventEmitter {
  markets = new Map<string, Market>();
  byMint = new Map<string, string[]>();
  candles = new Map<string, CandleBuilder>();
  tapes = new Map<string, Trade[]>();
  dirty = new Set<string>();
  seq = 0;
  dupes = 0;

  private touch(id: string, kind: string, data: unknown) {
    this.dirty.add(id);
    this.seq++;
    this.emit("event", { seq: this.seq, type: kind, marketId: id, data });
  }

  upsertLaunch(l: NormalisedLaunch, tradeFeed: Market["tradeFeed"]) {
    const id = marketId(l.chain, l.marketKind, l.marketAddress);
    if (this.markets.has(id)) return this.markets.get(id)!;
    const price = l.reserveQuote && l.reserveBase ? l.reserveQuote / l.reserveBase : null;
    const m: Market = {
      id, chain: l.chain, kind: l.marketKind, address: l.marketAddress, mint: l.mint, venue: l.venue, quoteCcy: l.quoteCcy,
      name: l.name, symbol: l.symbol, imageUri: l.imageUri, launchedAt: l.receivedAt, status: "active",
      stage: this.stageFor(l.curveProgress), curveProgress: l.curveProgress, reserveQuote: l.reserveQuote,
      reserveBase: l.reserveBase, priceQuote: price, totalSupply: l.totalSupply, circulatingSupply: l.circulatingSupply,
      liquidityUsd: null, liquidityAt: null, tradeFeed, quoteModel: l.marketKind === "curve" ? "pump_curve_v1" : "cpmm_reserves",
      stateSource: "pumpportal:create", stateUpdatedAt: l.receivedAt, migratedTo: null, migratedFrom: null, lastTradeAt: null,
      launchSignature: l.signature,
    };
    this.markets.set(id, m);
    this.byMint.set(l.mint, [...(this.byMint.get(l.mint) ?? []), id]);
    this.evict();
    this.touch(id, "launch", m);
    return m;
  }

  addAmm(m: Market) {
    this.markets.set(m.id, m);
    this.byMint.set(m.mint, [...(this.byMint.get(m.mint) ?? []).filter((x) => x !== m.id), m.id]);
    this.touch(m.id, "market", m);
  }

  stageFor(p: number | null): Market["stage"] {
    return p != null && p >= config.finalStretch ? "final_stretch" : "new";
  }

  resolveMarket(s: NormalisedSwap): Market | null {
    if (s.marketAddress) {
      const m = this.markets.get(marketId(s.chain, "curve", s.marketAddress));
      if (m) return m;
    }
    const ids = this.byMint.get(s.mint) ?? [];
    // AMM swaps go to the active AMM market for the mint; never into the retired curve's history.
    for (const id of ids) {
      const m = this.markets.get(id)!;
      if (s.marketAddress ? m.kind === "curve" : m.kind === "amm" && m.status === "active") return m;
    }
    return null;
  }

  addSwap(s: NormalisedSwap): Trade | null {
    const m = this.resolveMarket(s);
    if (!m) return null;
    const id = `${s.signature}:${s.eventIndex ?? 0}:${m.id}`;
    const ev: SwapEvent = { id, ts: s.sourceTs ?? s.receivedAt, price: s.quoteQty / s.baseQty, baseQty: s.baseQty, quoteQty: s.quoteQty, side: s.side };
    let cb = this.candles.get(m.id);
    if (!cb) { cb = new CandleBuilder(); this.candles.set(m.id, cb); }
    if (!cb.add(ev)) { this.dupes++; return null; }
    const t: Trade = {
      id, marketId: m.id, signature: s.signature, eventIndex: s.eventIndex, side: s.side, baseQty: s.baseQty,
      quoteQty: s.quoteQty, baseDecimals: s.baseDecimals, quoteCcy: s.quoteCcy, priceQuote: ev.price, sourceTs: s.sourceTs,
      receivedAt: s.receivedAt, trader: s.trader,
    };
    const tape = this.tapes.get(m.id) ?? [];
    tape.unshift(t);
    if (tape.length > TAPE) tape.length = TAPE;
    this.tapes.set(m.id, tape);
    m.lastTradeAt = s.receivedAt;
    if (s.reserveQuoteAfter && s.reserveBaseAfter) {
      // Only accept state that is not older than what we hold (out-of-order safe).
      if (!m.stateUpdatedAt || s.receivedAt >= m.stateUpdatedAt) {
        m.reserveQuote = s.reserveQuoteAfter;
        m.reserveBase = s.reserveBaseAfter;
        m.priceQuote = s.reserveQuoteAfter / s.reserveBaseAfter;
        m.stateUpdatedAt = s.receivedAt;
        m.stateSource = "pumpportal:trade";
        if (m.kind === "curve") {
          m.curveProgress = pumpCurveProgress(s.reserveBaseAfter);
          if (m.status === "active") m.stage = this.stageFor(m.curveProgress);
        }
      }
    } else if (m.kind === "amm") {
      m.priceQuote = ev.price;
      if (m.tradeFeed === "unverified") m.tradeFeed = "live"; // first observed swap verifies coverage
    }
    this.touch(m.id, "trade", t);
    return t;
  }

  migrate(mg: NormalisedMigration): Market | null {
    const ids = this.byMint.get(mg.mint) ?? [];
    const curve = ids.map((i) => this.markets.get(i)!).find((m) => m.kind === "curve");
    if (!curve) return null;
    curve.status = "migrated";
    curve.stage = "migrated";
    curve.curveProgress = 1;
    curve.tradeFeed = "unavailable";
    this.touch(curve.id, "migration", { marketId: curve.id, signature: mg.signature, destinationHint: mg.destinationHint });
    return curve;
  }

  markDirty(id: string) { this.touch(id, "market", this.markets.get(id)); }

  stats(id: string) {
    const cb = this.candles.get(id);
    const now = Math.floor(Date.now() / 1000);
    if (!cb) return null;
    return { "5m": cb.stats(300, now), "1h": cb.stats(3600, now), "6h": cb.stats(21600, now), "24h": cb.stats(86400, now) };
  }

  private evict() {
    if (this.markets.size <= MAX_MARKETS) return;
    const victims = [...this.markets.values()].sort((a, b) => (a.lastTradeAt ?? a.launchedAt) - (b.lastTradeAt ?? b.launchedAt)).slice(0, this.markets.size - MAX_MARKETS);
    for (const v of victims) {
      this.markets.delete(v.id); this.candles.delete(v.id); this.tapes.delete(v.id); this.dirty.delete(v.id);
      const ids = (this.byMint.get(v.mint) ?? []).filter((x) => x !== v.id);
      if (ids.length) this.byMint.set(v.mint, ids); else this.byMint.delete(v.mint);
    }
  }
}

export const PUMP_SUPPLY = PUMP_CURVE.TOTAL_SUPPLY;
