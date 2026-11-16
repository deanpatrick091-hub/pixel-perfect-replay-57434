import bs58 from "bs58";
import { PUMPSWAP_PROGRAM, type VerifiedPool } from "./pumpSwapEvents.ts";

// Fast path for live PumpSwap swaps, decoded from the logs carried by a free `logsSubscribe` notification.
// Anchor `emit!` writes "Program data: <base64(discriminator ++ event)>" through sol_log_data. The runtime
// attributes each log line to the program currently executing, and "Program X invoke [n]" / "success" lines
// let us rebuild that invocation stack. Only an event logged while PumpSwap itself is on top of the stack is
// accepted, and only if the event's own `pool` field is the selected verified pool PDA (whose base mint and
// WSOL quote were verified on-chain). Anything ambiguous — truncated logs, inconsistent stack, failed tx,
// short/malformed data — returns null so the caller keeps the normal getTransaction verification.
// Swaps from this path are provisional: the same transaction is still fetched and validated, and its
// verified events replace these (identity `signature:log<n>` is never mixed with verified ids).
const BUY = Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]);
const SELL = Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]);
const INVOKE = /^Program (\w+) invoke \[(\d+)\]$/;
const END = /^Program (\w+) (success|failed.*)$/;

export interface LogSwap { id: string; signature: string; eventIndex: number; slot: number; blockTime: number; side: "buy" | "sell"; baseQty: number; quoteQty: number; price: number; trader: string }

export function extractPumpSwapLogSwaps(logs: unknown, err: unknown, signature: string, slot: number, pool: VerifiedPool): LogSwap[] | null {
  if (err != null || !Array.isArray(logs) || !logs.length || !Number.isInteger(slot) || slot <= 0) return null;
  const stack: string[] = [];
  const out: LogSwap[] = [];
  let n = 0;
  for (const raw of logs) {
    if (typeof raw !== "string") return null;
    if (raw.startsWith("Log truncated")) return null;
    let m = INVOKE.exec(raw);
    if (m) { if (Number(m[2]) !== stack.length + 1) return null; stack.push(m[1]); continue; }
    m = END.exec(raw);
    if (m) { if (stack.pop() !== m[1] || m[2] !== "success") return null; continue; }
    if (!raw.startsWith("Program data: ")) continue;
    if (stack[stack.length - 1] !== PUMPSWAP_PROGRAM) continue; // only PumpSwap may author a PumpSwap event
    let b: Buffer;
    try { b = Buffer.from(raw.slice(14), "base64"); } catch { return null; }
    const buy = b.subarray(0, 8).equals(BUY), sell = b.subarray(0, 8).equals(SELL);
    if (!buy && !sell) continue;
    if (b.length < 152) return null;
    if (bs58.encode(b.subarray(120, 152)) !== pool.address) continue; // a routed swap in another pool
    if (b.length < 394) return null;
    const ts = Number(b.readBigInt64LE(8)), baseRaw = b.readBigUInt64LE(16), quoteRaw = b.readBigUInt64LE(64);
    if (!Number.isFinite(ts) || ts <= 1_600_000_000 || baseRaw <= 0n || quoteRaw <= 0n) return null;
    const baseQty = Number(baseRaw) / 1e6, quoteQty = Number(quoteRaw) / 1e9, price = quoteQty / baseQty;
    if (!Number.isFinite(price) || price <= 0) return null;
    out.push({ id: `${signature}:log${n}`, signature, eventIndex: n++, slot, blockTime: ts, side: buy ? "buy" : "sell", baseQty, quoteQty, price, trader: bs58.encode(b.subarray(152, 184)) });
  }
  if (stack.length) return null; // logs ended mid-invocation: treat as truncated
  return out;
}
