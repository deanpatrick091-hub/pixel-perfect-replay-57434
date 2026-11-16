import { test } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { PUMPSWAP_PROGRAM } from "../src/history/pumpSwapEvents.ts";
import { extractPumpSwapLogSwaps } from "../src/history/logEvents.ts";

const key = () => Keypair.generate().publicKey.toBase58();
const pool = { address: key(), mint: key(), baseVault: key(), quoteVault: key() };
const ROUTER = key(), TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function data(buy: boolean, o: { pool?: string; base?: bigint; quote?: bigint; len?: number } = {}) {
  const b = Buffer.alloc(o.len ?? 394);
  Buffer.from(buy ? [103, 244, 82, 31, 44, 245, 119, 119] : [62, 47, 55, 10, 165, 3, 220, 42]).copy(b);
  b.writeBigInt64LE(1_790_000_000n, 8); b.writeBigUInt64LE(o.base ?? 2_000_000n, 16);
  b.writeBigUInt64LE(99_000_000_000n, 24); // limit field, never volume
  b.writeBigUInt64LE(o.quote ?? 1_000_000_000n, 64);
  if (b.length >= 152) Buffer.from(bs58.decode(o.pool ?? pool.address)).copy(b, 120);
  return "Program data: " + b.toString("base64");
}
const wrap = (inner: string[], author = PUMPSWAP_PROGRAM) => [
  `Program ${ROUTER} invoke [1]`, `Program ${author} invoke [2]`, `Program ${TOKEN} invoke [3]`, `Program ${TOKEN} success`,
  ...inner, `Program ${author} invoke [3]`, `Program ${author} success`, `Program ${author} success`, `Program ${ROUTER} success`,
];

test("PumpSwap event logged by PumpSwap for the selected pool decodes side, gross quote, block timestamp", () => {
  const r = extractPumpSwapLogSwaps(wrap([data(false)]), null, "SIG", 5, pool)!;
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].side, r[0].baseQty, r[0].quoteQty, r[0].price, r[0].blockTime, r[0].id], ["sell", 2, 1, 0.5, 1_790_000_000, "SIG:log0"]);
  const two = extractPumpSwapLogSwaps(wrap([data(true), data(true)]), null, "S", 5, pool)!;
  assert.deepEqual(two.map((s) => s.id), ["S:log0", "S:log1"]); // identical bytes at two positions are two swaps
});

test("spoofed author, other pool, failed tx, truncation, broken stack and malformed data never chart", () => {
  assert.deepEqual(extractPumpSwapLogSwaps(wrap([data(true)], key()), null, "S", 5, pool), []); // another program printed look-alike bytes
  assert.deepEqual(extractPumpSwapLogSwaps(wrap([data(true, { pool: key() })]), null, "S", 5, pool), []);
  assert.equal(extractPumpSwapLogSwaps(wrap([data(true)]), { InstructionError: [0, "x"] }, "S", 5, pool), null);
  assert.equal(extractPumpSwapLogSwaps([...wrap([data(true)]), "Log truncated"], null, "S", 5, pool), null);
  assert.equal(extractPumpSwapLogSwaps(wrap([data(true)]).slice(0, -1), null, "S", 5, pool), null);
  assert.equal(extractPumpSwapLogSwaps(wrap([data(true, { len: 200 })]), null, "S", 5, pool), null);
  assert.equal(extractPumpSwapLogSwaps(wrap([data(true, { quote: 0n })]), null, "S", 5, pool), null);
  const failedInner = wrap([data(true)]); failedInner[7] = `Program ${PUMPSWAP_PROGRAM} failed: custom program error`;
  assert.equal(extractPumpSwapLogSwaps(failedInner, null, "S", 5, pool), null);
});
