import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import type { ExtractResult, VerifiedSwap } from "./pumpEvents.ts";

// Stable prefixes from the official IDL (append-only event extensions are not price inputs):
// https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json
export const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const WSOL = "So11111111111111111111111111111111111111112";
const program = new PublicKey(PUMPSWAP_PROGRAM);
export const SWAP_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], program)[0].toBase58();
const EMIT = Buffer.from("e445a52e51cb9a1d", "hex");
const BUY = Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]);
const SELL = Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]);
const BUY_IX = [Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]), Buffer.from([198, 46, 21, 82, 180, 217, 232, 112])];
const SELL_IX = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
const BUY_V2 = [Buffer.from([184, 23, 238, 97, 103, 197, 211, 61]), Buffer.from([194, 171, 28, 70, 104, 77, 91, 47])];
const SELL_V2 = Buffer.from([93, 246, 130, 60, 231, 233, 64, 178]);
export interface VerifiedPool { address: string; mint: string; baseVault: string; quoteVault: string }
export class PoolInvalid extends Error {}

export function verifyPoolAccount(address: string, mint: string, account: any): VerifiedPool {
  try {
    if (!account || account.owner !== PUMPSWAP_PROGRAM || account.executable || account.data?.[1] !== "base64") throw new Error("owner/data");
    const b = Buffer.from(account.data[0], "base64");
    if (b.length < 211 || !b.subarray(0, 8).equals(Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]))) throw new Error("layout");
    const pk = (o: number) => new PublicKey(b.subarray(o, o + 32));
    const creator = pk(11), base = pk(43), quote = pk(75);
    const [pda, bump] = PublicKey.findProgramAddressSync([Buffer.from("pool"), b.subarray(9, 11), creator.toBuffer(), base.toBuffer(), quote.toBuffer()], program);
    if (base.toBase58() !== mint || quote.toBase58() !== WSOL || pda.toBase58() !== address || bump !== b[8]) throw new Error("mint/quote/PDA");
    return { address, mint, baseVault: pk(139).toBase58(), quoteVault: pk(171).toBase58() };
  } catch { throw new PoolInvalid("Pool verification failed: expected the exact PumpSwap-owned pool PDA, selected base mint and Wrapped SOL quote."); }
}

/** Never decode log text or infer side from price: require a buy/sell parent and its validated self-CPI. */
export function extractPumpSwapSwaps(tx: any, signature: string, pool: VerifiedPool): ExtractResult {
  const none = (reason: ExtractResult["reason"]): ExtractResult => ({ swaps: [], rejectedEvents: 0, reason });
  if (!tx?.meta || tx.meta.err != null || !Number.isFinite(tx.blockTime) || !Number.isInteger(tx.slot)) return none("failed_tx");
  const msg = tx.transaction?.message;
  const keys: string[] = [...(msg?.accountKeys ?? []), ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  if (!keys.includes(pool.address)) return none("no_curve");
  const balances = [...(tx.meta.postTokenBalances ?? []), ...(tx.meta.preTokenBalances ?? [])];
  const hasBalance = (address: string, mint: string, decimals: number) => balances.some((b: any) => keys[b.accountIndex] === address && b.mint === mint && b.uiTokenAmount?.decimals === decimals);
  const swaps: VerifiedSwap[] = [];
  let rejectedEvents = 0, pos = 0;
  for (const group of tx.meta.innerInstructions ?? []) {
    const list = group.instructions ?? [];
    for (let i = 0; i < list.length; i++) {
      const ix = list[i], eventIndex = pos++;
      if (keys[ix.programIdIndex] !== PUMPSWAP_PROGRAM) continue;
      let b: Buffer;
      try { b = Buffer.from(bs58.decode(ix.data)); } catch { continue; }
      if (!b.subarray(0, 8).equals(EMIT)) continue;
      const buy = b.subarray(8, 16).equals(BUY), sell = b.subarray(8, 16).equals(SELL);
      if (!buy && !sell) continue;
      // A routed transaction can contain valid swaps in other pools. Those aren't
      // failures of coverage for the selected pool (but malformed selected events are).
      if (b.length >= 160 && bs58.encode(b.subarray(128, 160)) !== pool.address) continue;
      try {
        if (b.length < 402 || !Number.isInteger(ix.stackHeight) || ix.stackHeight < 2) throw new Error("short/stack");
        let parent = ix.stackHeight === 2 ? msg.instructions?.[group.index] : null;
        if (ix.stackHeight > 2) for (let j = i - 1; j >= 0; j--) {
          if (list[j].stackHeight < ix.stackHeight) { if (list[j].stackHeight === ix.stackHeight - 1) parent = list[j]; break; }
        }
        const acc = (parent?.accounts ?? []).map((a: number) => keys[a]);
        const eventAcc = (ix.accounts ?? []).map((a: number) => keys[a]);
        const pk = (o: number) => bs58.encode(b.subarray(o, o + 32));
        if (!parent || keys[parent.programIdIndex] !== PUMPSWAP_PROGRAM || eventAcc.length !== 1 || eventAcc[0] !== SWAP_AUTHORITY) throw new Error("invocation");
        const d = Buffer.from(bs58.decode(parent.data)).subarray(0, 8);
        const v2 = buy ? BUY_V2.some((tag) => tag.equals(d)) : SELL_V2.equals(d);
        if (!v2 && (buy ? !BUY_IX.some((tag) => tag.equals(d)) : !SELL_IX.equals(d))) throw new Error("direction");
        if (acc[0] !== pool.address || acc[3] !== pool.mint || acc[4] !== WSOL || acc[7] !== pool.baseVault || acc[8] !== pool.quoteVault || acc[15] !== SWAP_AUTHORITY || acc[16] !== PUMPSWAP_PROGRAM) throw new Error("pool/mints/vaults");
        if (pk(128) !== pool.address || pk(160) !== acc[1] || pk(192) !== acc[5] || pk(224) !== acc[6] || (!v2 && (pk(256) !== acc[9] || pk(288) !== acc[10]))) throw new Error("event accounts");
        if (!hasBalance(pool.baseVault, pool.mint, 6) || !hasBalance(pool.quoteVault, WSOL, 9)) throw new Error("decimals");
        const baseRaw = b.readBigUInt64LE(24), quoteRaw = b.readBigUInt64LE(72);
        if (baseRaw <= 0n || quoteRaw <= 0n) throw new Error("amounts");
        // Gross pool swap notional (quote_amount_in/out), excluding separately reported fees;
        // never max/min quote limits or total user debit/credit. Both directions use the same denomination.
        const baseQty = Number(baseRaw) / 1e6, quoteQty = Number(quoteRaw) / 1e9, price = quoteQty / baseQty;
        if (!Number.isFinite(price) || price <= 0) throw new Error("price");
        swaps.push({ id: `${signature}:${group.index}.${i}`, signature, eventIndex, slot: tx.slot, blockTime: tx.blockTime, side: buy ? "buy" : "sell", baseQty, quoteQty, price, trader: acc[1] });
      } catch { rejectedEvents++; }
    }
  }
  return { swaps, rejectedEvents, reason: swaps.length ? "ok" : "no_events" };
}