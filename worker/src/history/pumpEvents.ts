import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";

// Decodes official Pump TradeEvent (emit_cpi self-invocation) per the public IDL:
// https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PROGRAM_PK = new PublicKey(PUMP_PROGRAM);
export const EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PROGRAM_PK)[0].toBase58();
const EVENT_IX_TAG = Buffer.from("e445a52e51cb9a1d", "hex"); // anchor emit_cpi tag
const TRADE_EVENT = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const WSOL = "So11111111111111111111111111111111111111112";
const DEFAULT_PK = "11111111111111111111111111111111";

export function bondingCurvePda(mint: string) {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], PROGRAM_PK)[0].toBase58();
}

export interface DecodedTrade {
  mint: string; solLamports: bigint; tokenRaw: bigint; isBuy: boolean; user: string; timestamp: number;
  virtualSol: bigint; virtualToken: bigint; quoteMint: string | null;
}

class R {
  o = 0; constructor(public b: Buffer) {}
  need(n: number) { if (this.o + n > this.b.length) throw new Error("short"); }
  pk() { this.need(32); const v = bs58.encode(this.b.subarray(this.o, this.o + 32)); this.o += 32; return v; }
  u64() { this.need(8); const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  i64() { this.need(8); const v = this.b.readBigInt64LE(this.o); this.o += 8; return v; }
  u16() { this.need(2); const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { this.need(4); const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  bool() { this.need(1); const v = this.b[this.o]; this.o += 1; if (v > 1) throw new Error("bool"); return v === 1; }
  str() { const n = this.u32(); this.need(n); this.o += n; }
}

export function decodeTradeEvent(data: Buffer): DecodedTrade | null {
  if (data.length < 16 || !data.subarray(0, 8).equals(EVENT_IX_TAG) || !data.subarray(8, 16).equals(TRADE_EVENT)) return null;
  const r = new R(data.subarray(16));
  try {
    const mint = r.pk(), solLamports = r.u64(), tokenRaw = r.u64(), isBuy = r.bool(), user = r.pk(), timestamp = Number(r.i64());
    const virtualSol = r.u64(), virtualToken = r.u64();
    r.u64(); r.u64(); // real reserves
    // Newer layouts append quote_mint after variable fields; older (SOL-only) layouts end earlier.
    let quoteMint: string | null = null;
    try {
      r.pk(); r.u64(); r.u64(); r.pk(); r.u64(); r.u64(); r.bool(); r.u64(); r.u64(); r.u64(); r.i64(); r.str(); r.bool();
      r.u64(); r.u64(); r.u64(); r.u64();
      const n = r.u32(); if (n > 64) throw new Error("vec");
      for (let i = 0; i < n; i++) { r.pk(); r.u16(); }
      quoteMint = r.pk();
    } catch { quoteMint = null; }
    return { mint, solLamports, tokenRaw, isBuy, user, timestamp, virtualSol, virtualToken, quoteMint };
  } catch { return null; }
}

export interface VerifiedSwap {
  id: string; signature: string; eventIndex: number; slot: number; blockTime: number; side: "buy" | "sell";
  baseQty: number; quoteQty: number; price: number; trader: string; orderKey: string;
}

/** Extract only validated Pump TradeEvents for (curve, mint) from a getTransaction(json, v0) result. */
export function extractSwaps(tx: any, signature: string, curve: string, mint: string, txIndex: number | null = null): VerifiedSwap[] {
  if (!tx || !tx.meta || tx.meta.err != null || typeof tx.blockTime !== "number") return [];
  const msg = tx.transaction?.message;
  const keys: string[] = [...(msg?.accountKeys ?? []), ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  if (!keys.includes(curve)) return [];
  // Token decimals from the transaction's own token balances (Pump mints use 6).
  const bal = [...(tx.meta.postTokenBalances ?? []), ...(tx.meta.preTokenBalances ?? [])].find((b: any) => b.mint === mint);
  const decimals = bal?.uiTokenAmount?.decimals;
  if (decimals !== 6) return [];
  const out: VerifiedSwap[] = [];
  let idx = 0;
  for (const group of tx.meta.innerInstructions ?? []) {
    const top = msg.instructions?.[group.index];
    const list: any[] = group.instructions ?? [];
    list.forEach((ix, i) => {
      if (keys[ix.programIdIndex] !== PUMP_PROGRAM) return;
      const data = Buffer.from(bs58.decode(ix.data));
      const ev = decodeTradeEvent(data);
      if (!ev) return;
      const h = ix.stackHeight ?? null;
      if (h == null || h < 2) return;
      const accs: string[] = (ix.accounts ?? []).map((a: number) => keys[a]);
      if (accs.length !== 1 || accs[0] !== EVENT_AUTHORITY) return;
      // Parent invocation (one level up) must be the Pump program acting on this curve.
      let parent: any = null;
      if (h === 2) parent = top;
      else for (let j = i - 1; j >= 0; j--) if ((list[j].stackHeight ?? 0) === h - 1) { parent = list[j]; break; }
      if (!parent || keys[parent.programIdIndex] !== PUMP_PROGRAM) return;
      if (!(parent.accounts ?? []).map((a: number) => keys[a]).includes(curve)) return;
      if (ev.mint !== mint) return;
      if (ev.quoteMint && ev.quoteMint !== DEFAULT_PK && ev.quoteMint !== WSOL) return;
      if (ev.solLamports <= 0n || ev.tokenRaw <= 0n) return;
      const quoteQty = Number(ev.solLamports) / 1e9, baseQty = Number(ev.tokenRaw) / 10 ** decimals;
      out.push({ id: `${signature}:${idx}`, signature, eventIndex: idx, slot: tx.slot, blockTime: tx.blockTime, side: ev.isBuy ? "buy" : "sell", baseQty, quoteQty, price: quoteQty / baseQty, trader: ev.user,
        orderKey: `${String(tx.slot).padStart(12, "0")}:${String(txIndex ?? 99999).padStart(5, "0")}:${String(idx).padStart(3, "0")}` });
      idx++;
    });
  }
  return out;
}
