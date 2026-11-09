// Candle aggregation from real swaps. Deduplicates by event id and tolerates out-of-order arrival:
// a bucket's open is the earliest-timestamped trade and its close the latest, regardless of arrival order.

export interface SwapEvent {
  id: string; // event identity (signature + index)
  ts: number; // ms, source timestamp if available else receipt
  price: number; // quote per token (or USD — caller chooses one denomination)
  baseQty: number;
  quoteQty: number;
  side: "buy" | "sell";
}

export interface Candle {
  t: number; // bucket start, seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // quote volume
  buys: number;
  sells: number;
}

interface Bucket extends Candle {
  oTs: number;
  oId: string;
  cTs: number;
  cId: string;
}

export const INTERVALS: Record<string, number> = {
  "1s": 1,
  "5s": 5,
  "15s": 15,
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1D": 86400,
};

export class CandleBuilder {
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private buckets = new Map<number, Bucket>();
  constructor(
    private maxSeen = 50_000,
    private maxBuckets = 86_400,
  ) {}

  /** Returns false when the event was a duplicate. */
  add(e: SwapEvent): boolean {
    if (this.seen.has(e.id)) return false;
    if (!(e.price > 0) || !Number.isFinite(e.price)) return false;
    this.seen.add(e.id);
    this.seenOrder.push(e.id);
    if (this.seenOrder.length > this.maxSeen) this.seen.delete(this.seenOrder.shift()!);

    const t = Math.floor(e.ts / 1000);
    const b = this.buckets.get(t);
    if (!b) {
      this.buckets.set(t, {
        t, o: e.price, h: e.price, l: e.price, c: e.price, v: e.quoteQty,
        buys: e.side === "buy" ? 1 : 0, sells: e.side === "sell" ? 1 : 0,
        oTs: e.ts, oId: e.id, cTs: e.ts, cId: e.id,
      });
      if (this.buckets.size > this.maxBuckets) {
        const oldest = Math.min(...this.buckets.keys());
        this.buckets.delete(oldest);
      }
      return true;
    }
    b.h = Math.max(b.h, e.price);
    b.l = Math.min(b.l, e.price);
    b.v += e.quoteQty;
    if (e.side === "buy") b.buys++;
    else b.sells++;
    if (e.ts < b.oTs || (e.ts === b.oTs && e.id < b.oId)) {
      b.o = e.price; b.oTs = e.ts; b.oId = e.id;
    }
    if (e.ts > b.cTs || (e.ts === b.cTs && e.id > b.cId)) {
      b.c = e.price; b.cTs = e.ts; b.cId = e.id;
    }
    return true;
  }

  candles(intervalSec: number, sinceSec = 0): Candle[] {
    const keys = [...this.buckets.keys()].filter((k) => k >= sinceSec).sort((a, b) => a - b);
    const out: Candle[] = [];
    let cur: Candle | null = null;
    for (const k of keys) {
      const b = this.buckets.get(k)!;
      const t = Math.floor(k / intervalSec) * intervalSec;
      if (!cur || cur.t !== t) {
        cur = { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, buys: b.buys, sells: b.sells };
        out.push(cur);
      } else {
        cur.h = Math.max(cur.h, b.h);
        cur.l = Math.min(cur.l, b.l);
        cur.c = b.c;
        cur.v += b.v;
        cur.buys += b.buys;
        cur.sells += b.sells;
      }
    }
    return out;
  }

  /** Rolling stats over the last windowSec seconds, ending at nowSec. */
  stats(windowSec: number, nowSec: number) {
    let v = 0, buys = 0, sells = 0, first: Bucket | null = null, last: Bucket | null = null;
    for (const [k, b] of this.buckets) {
      if (k < nowSec - windowSec || k > nowSec) continue;
      v += b.v; buys += b.buys; sells += b.sells;
      if (!first || k < first.t) first = b;
      if (!last || k > last.t) last = b;
    }
    const change = first && last ? (last.c / first.o - 1) * 100 : null;
    return { volumeQuote: v, buys, sells, changePct: change };
  }
}
