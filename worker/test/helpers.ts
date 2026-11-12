import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { PUMP_PROGRAM, EVENT_AUTHORITY, bondingCurvePda } from "../src/history/pumpEvents.ts";
import { createHistoryService } from "../src/history/service.ts";
import { marketId, type Market } from "../src/store.ts";

export const mint = Keypair.generate().publicKey.toBase58();
export const curve = bondingCurvePda(mint);
export const user = Keypair.generate().publicKey.toBase58();

export function eventData(opts: { mint?: string; sol: bigint; tok: bigint; buy: boolean }) {
  const b = Buffer.alloc(16 + 32 + 8 + 8 + 1 + 32 + 8 + 32);
  Buffer.from("e445a52e51cb9a1d", "hex").copy(b, 0);
  Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]).copy(b, 8);
  let o = 16;
  Buffer.from(bs58.decode(opts.mint ?? mint)).copy(b, o); o += 32;
  b.writeBigUInt64LE(opts.sol, o); o += 8; b.writeBigUInt64LE(opts.tok, o); o += 8;
  b[o] = opts.buy ? 1 : 0; o += 1;
  Buffer.from(bs58.decode(user)).copy(b, o); o += 32;
  b.writeBigInt64LE(0n, o); // rest (virtual/real reserves) zero
  return bs58.encode(b);
}

/** Pump buy/sell instruction (top level) emitting its TradeEvent via self-CPI at stack height 2. */
export function tx(slot: number, blockTime: number, events: string[], o: { err?: unknown; decimals?: number; authority?: string; parentCurve?: boolean; stack?: number } = {}) {
  const keys = [user, PUMP_PROGRAM, curve, o.authority ?? EVENT_AUTHORITY, mint];
  return {
    slot, blockTime,
    transaction: { message: { accountKeys: keys, instructions: [{ programIdIndex: 1, accounts: o.parentCurve === false ? [0, 4] : [0, 2, 4], data: "" }] } },
    meta: { err: o.err ?? null, postTokenBalances: [{ mint, uiTokenAmount: { decimals: o.decimals ?? 6 } }], preTokenBalances: [],
      innerInstructions: [{ index: 0, instructions: events.map((d) => ({ programIdIndex: 1, accounts: [3], data: d, stackHeight: o.stack ?? 2 })) }] },
  };
}

export const market = (over: Partial<Market> = {}): Market => ({
  id: marketId("solana", "curve", curve), chain: "solana", kind: "curve", address: curve, mint, venue: "pumpfun", quoteCcy: "SOL",
  name: null, symbol: null, imageUri: null, launchedAt: 0, status: "active", stage: "new", curveProgress: null, reserveQuote: null, reserveBase: null,
  priceQuote: null, totalSupply: null, circulatingSupply: null, liquidityUsd: null, liquidityAt: null, tradeFeed: "unavailable", quoteModel: null,
  stateSource: null, stateUpdatedAt: null, migratedTo: null, migratedFrom: null, lastTradeAt: null, launchSignature: null, ...over,
});

type Script = { sigs: any[][]; older?: any[][]; txs: Record<string, any>; fail?: (method: string, params: unknown[]) => Error | null; cooling?: () => boolean };
export function harness(script: Script) {
  let t = 1_000_000;
  const calls: string[] = [];
  const prios: [string, number | undefined][] = [];
  const svc = createHistoryService({
    now: () => t, coolingDown: script.cooling ?? (() => false), cooldownUntil: () => t + 5_000, later: () => {},
    rpc: async <T,>(method: string, params: unknown[], prio?: number): Promise<T> => {
      calls.push(method); prios.push([method === "getTransaction" ? (params[0] as string) : method, prio]);
      const f = script.fail?.(method, params); if (f) throw f;
      if (method === "getSignaturesForAddress") {
        const o = params[1] as { until?: string; before?: string };
        if (o.before && !o.until && script.older) return (script.older.shift() ?? []) as T; // backfill page
        return (script.sigs.shift() ?? []) as T;
      }
      return (script.txs[params[0] as string] ?? null) as T;
    },
  });
  const m = market();
  const run = async (sec = 60) => { const s = svc.history(m, m.id, sec); await svc._inflight(m.id); return s; };
  const snap = (sec = 60) => svc.history(m, m.id, sec);
  return { svc, m, calls, prios, sigs: script.sigs, run, snap, advance: (ms: number) => { t += ms; }, now: () => t };
}
export const sig = (s: string, slot: number) => ({ signature: s, slot, err: null, blockTime: 1_700_000_000 });

