import { test } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PUMPSWAP_PROGRAM, WSOL, SWAP_AUTHORITY, verifyPoolAccount, extractPumpSwapSwaps } from "../src/history/pumpSwapEvents.ts";
import { createHistoryService, checkSupport } from "../src/history/service.ts";
import { RpcLimited } from "../src/history/rpc.ts";
import { market } from "./helpers.ts";
import { marketId } from "../src/store.ts";

const key = () => Keypair.generate().publicKey.toBase58();
const mint = key(), creator = key(), baseVault = key(), quoteVault = key(), user = key();
const [address, bump] = PublicKey.findProgramAddressSync([Buffer.from("pool"), Buffer.alloc(2), new PublicKey(creator).toBuffer(), new PublicKey(mint).toBuffer(), new PublicKey(WSOL).toBuffer()], new PublicKey(PUMPSWAP_PROGRAM));
const poolData = Buffer.alloc(243);
Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(poolData); poolData[8] = bump;
for (const [o, pk] of [[11, creator], [43, mint], [75, WSOL], [107, key()], [139, baseVault], [171, quoteVault]] as const) Buffer.from(bs58.decode(pk)).copy(poolData, o);
const account = { owner: PUMPSWAP_PROGRAM, executable: false, data: [poolData.toString("base64"), "base64"] };
const pool = verifyPoolAccount(address.toBase58(), mint, account);
const m = market({ id: marketId("solana", "amm", pool.address), kind: "amm", address: pool.address, mint, venue: "pumpswap", stage: "migrated" });

function swapTx(buy: boolean, time = 1_700_000_000, quote = 2_000_000_000n, nested = false) {
  const acc = [pool.address, user, key(), mint, WSOL, key(), key(), baseVault, quoteVault, key(), key(), key(), key(), key(), key(), SWAP_AUTHORITY, PUMPSWAP_PROGRAM];
  const data = Buffer.alloc(402);
  Buffer.from("e445a52e51cb9a1d", "hex").copy(data);
  Buffer.from(buy ? [103, 244, 82, 31, 44, 245, 119, 119] : [62, 47, 55, 10, 165, 3, 220, 42]).copy(data, 8);
  data.writeBigInt64LE(BigInt(time), 16); data.writeBigUInt64LE(1_000_000n, 24);
  data.writeBigUInt64LE(99_000_000_000n, 32); // max/min limit is NOT executed volume
  data.writeBigUInt64LE(quote, 72);
  data.writeBigUInt64LE(77_000_000_000n, 120); // user debit/credit including fees is NOT gross swap notional
  for (const [o, idx] of [[128, 0], [160, 1], [192, 5], [224, 6], [256, 9], [288, 10], [320, 1]] as const) Buffer.from(bs58.decode(acc[idx])).copy(data, o);
  const parent = { programIdIndex: 16, accounts: acc.map((_, i) => i), data: bs58.encode(Buffer.from(buy ? [102, 6, 61, 18, 1, 218, 235, 234] : [51, 230, 133, 164, 1, 127, 131, 173])), stackHeight: 2 };
  const event = { programIdIndex: 16, accounts: [15], data: bs58.encode(data), stackHeight: nested ? 3 : 2 };
  return { slot: time, blockTime: time, transaction: { message: { accountKeys: acc, instructions: [nested ? { ...parent, programIdIndex: 2 } : parent] } }, meta: { err: null as unknown, preTokenBalances: [], postTokenBalances: [{ accountIndex: 7, mint, uiTokenAmount: { decimals: 6 } }, { accountIndex: 8, mint: WSOL, uiTokenAmount: { decimals: 9 } }], innerInstructions: [{ index: 0, instructions: nested ? [parent, event] : [event] }] } };
}

test("PumpSwap exact pool owner, discriminator, mint, quote, PDA and bump are required", () => {
  assert.equal(checkSupport(m, m.id).ok, true);
  assert.deepEqual(verifyPoolAccount(pool.address, mint, account), pool);
  for (const bad of [{ ...account, owner: key() }, { ...account, data: [Buffer.alloc(243).toString("base64"), "base64"] }]) assert.throws(() => verifyPoolAccount(pool.address, mint, bad));
  assert.throws(() => verifyPoolAccount(key(), mint, account));
  assert.throws(() => verifyPoolAccount(pool.address, key(), account));
  const quote = Buffer.from(poolData); Buffer.from(bs58.decode(key())).copy(quote, 75);
  assert.throws(() => verifyPoolAccount(pool.address, mint, { ...account, data: [quote.toString("base64"), "base64"] }));
  assert.equal(checkSupport({ ...m, venue: "raydium" }, m.id).ok, false);
});

test("PumpSwap buy/sell verified direction and executed gross quote, nested invocation, identical positions", () => {
  for (const buy of [true, false]) {
    const tx = swapTx(buy, undefined, undefined, true);
    const r = extractPumpSwapSwaps(tx, "S", pool);
    assert.equal(r.swaps.length, 1); assert.equal(r.swaps[0].side, buy ? "buy" : "sell");
    assert.equal(r.swaps[0].baseQty, 1); assert.equal(r.swaps[0].quoteQty, 2); assert.equal(r.swaps[0].price, 2);
  }
  const tx = swapTx(true); const ix = tx.meta.innerInstructions[0].instructions[0];
  tx.meta.innerInstructions[0].instructions.push({ ...ix });
  const r = extractPumpSwapSwaps(tx, "S", pool);
  assert.equal(r.swaps.length, 2); assert.notEqual(r.swaps[0].id, r.swaps[1].id);
});

test("current v2 buys/sells validate changed fee accounts; unrelated routed pools are not coverage failures", () => {
  for (const [buy, tag] of [[true, [184, 23, 238, 97, 103, 197, 211, 61]], [true, [194, 171, 28, 70, 104, 77, 91, 47]], [false, [93, 246, 130, 60, 231, 233, 64, 178]]] as const) {
    const t = swapTx(buy);
    t.transaction.message.instructions[0].data = bs58.encode(Buffer.from(tag));
    t.transaction.message.accountKeys[9] = key(); t.transaction.message.accountKeys[10] = key();
    const r = extractPumpSwapSwaps(t, "V2", pool);
    assert.equal(r.swaps.length, 1); assert.equal(r.swaps[0].side, buy ? "buy" : "sell");
    const unrelated = { ...t.meta.innerInstructions[0].instructions[0] };
    const b = Buffer.from(bs58.decode(unrelated.data)); Buffer.from(bs58.decode(key())).copy(b, 128); unrelated.data = bs58.encode(b);
    t.meta.innerInstructions[0].instructions.push(unrelated);
    const routed = extractPumpSwapSwaps(t, "V2", pool);
    assert.equal(routed.swaps.length, 1); assert.equal(routed.rejectedEvents, 0);
  }
});

test("PumpSwap rejects failed, wrong mint/pool, malformed, wrong side/stack/authority, transfers and vault decimals", () => {
  const mutations = [
    (t: ReturnType<typeof swapTx>) => { t.meta.err = { InstructionError: [0, "failed"] }; },
    (t: ReturnType<typeof swapTx>) => { t.transaction.message.accountKeys[3] = key(); },
    (t: ReturnType<typeof swapTx>) => { t.transaction.message.accountKeys[0] = key(); },
    (t: ReturnType<typeof swapTx>) => { t.meta.postTokenBalances[0].uiTokenAmount.decimals = 9; },
    (t: ReturnType<typeof swapTx>) => { t.meta.innerInstructions[0].instructions[0].stackHeight = 1; },
    (t: ReturnType<typeof swapTx>) => { t.meta.innerInstructions[0].instructions[0].accounts = [1]; },
    (t: ReturnType<typeof swapTx>) => { t.transaction.message.instructions[0].data = swapTx(false).transaction.message.instructions[0].data; },
    (t: ReturnType<typeof swapTx>) => { const ix = t.meta.innerInstructions[0].instructions[0]; ix.data = bs58.encode(Buffer.from(bs58.decode(ix.data)).subarray(0, 40)); },
    (t: ReturnType<typeof swapTx>) => { const ix = t.meta.innerInstructions[0].instructions[0]; const b = Buffer.from(bs58.decode(ix.data)); b.writeBigUInt64LE(0n, 24); ix.data = bs58.encode(b); },
    (t: ReturnType<typeof swapTx>) => { t.meta.innerInstructions[0].instructions[0].data = bs58.encode(Buffer.from("transfer")); },
  ];
  for (const mutate of mutations) { const t = swapTx(true); mutate(t); assert.equal(extractPumpSwapSwaps(t, "S", pool).swaps.length, 0); }
});

test("PumpSwap history/live dedup, all timeframes OHLCV, cooldown coherence and no executable state changes", async () => {
  let t = 1_000_000, scan = 0, cooling = false, fail = false;
  const original = structuredClone(m), calls: string[] = [], changed: string[] = [];
  const svc = createHistoryService({ now: () => t, later: () => {}, coolingDown: () => cooling, cooldownUntil: () => t + 5000, onChange: (id) => changed.push(id), rpc: async <T,>(method: string, params: unknown[]): Promise<T> => {
    calls.push(method);
    if (fail) { cooling = true; throw new RpcLimited(429); }
    if (method === "getAccountInfo") return { value: account } as T;
    if (method === "getSignaturesForAddress") return (scan++ === 0 ? [{ signature: "B", slot: 2, err: null, blockTime: 1_700_000_070 }, { signature: "A", slot: 1, err: null, blockTime: 1_700_000_000 }] : []) as T;
    return (params[0] === "A" ? swapTx(true) : swapTx(false, 1_700_000_070, 1_000_000_000n)) as T;
  } });
  svc.history(m, m.id, 60); await svc._inflight(m.id);
  const first = svc.history(m, m.id, 60);
  assert.equal(first.poolVerified, true); assert.equal(first.swaps, 2); assert.equal(first.candles.length, 2);
  assert.equal(calls[0], "getAccountInfo"); assert.ok(changed.length);
  svc.hint({ curve: pool.address, signature: "A", slot: 1, receivedAt: t }); await svc._inflight(m.id);
  assert.equal(calls.filter((c) => c === "getTransaction").length, 2);
  for (const sec of [1, 5, 15, 60, 300, 900, 3600, 14400, 86400]) {
    const h = svc.history(m, m.id, sec); assert.equal(h.swaps, 2); assert.equal(h.candles.reduce((n, c) => n + c.v, 0), 3);
  }
  const c = svc.history(m, m.id, 86400).candles[0];
  assert.deepEqual([c.o, c.h, c.l, c.c, c.buys, c.sells], [2, 2, 1, 1, 1, 1]);
  t += 16000; fail = true; svc.history(m, m.id, 60); await svc._inflight(m.id);
  const limited = svc.history(m, m.id, 60); assert.equal(limited.state, "rate_limited"); assert.deepEqual(limited.candles, first.candles); assert.equal(limited.lastDataAt, first.lastDataAt);
  assert.deepEqual(m, original, "chart history never mutates executable market state");
});

test("unverified PumpSwap pool never scans or subscribes; transport failure remains retryable", async () => {
  let good = false; const calls: string[] = [];
  const svc = createHistoryService({ coolingDown: () => false, later: () => {}, rpc: async <T,>(method: string): Promise<T> => { calls.push(method); if (!good) throw new Error("timeout"); return (method === "getAccountInfo" ? { value: account } : []) as T; } });
  svc.history(m, m.id, 60); await svc._inflight(m.id);
  assert.deepEqual(svc.viewedCurves(), []); assert.deepEqual(calls, ["getAccountInfo"]);
  good = true; svc.history(m, m.id, 60, { retry: true }); await svc._inflight(m.id);
  assert.equal(svc.history(m, m.id, 60).state, "empty"); assert.deepEqual(svc.viewedCurves(), [pool.address]);
  const wrong = { ...m, mint: key() };
  svc.history(wrong, wrong.id, 60); await svc._inflight(wrong.id);
  assert.equal(svc.history(wrong, wrong.id, 60).state, "unsupported", "changed mint must not reuse a verified cached pool");
  const invalid = createHistoryService({ coolingDown: () => false, later: () => {}, rpc: async <T,>(): Promise<T> => ({ value: account }) as T });
  invalid.history(wrong, wrong.id, 60); await invalid._inflight(wrong.id);
  assert.equal(invalid.history(wrong, wrong.id, 60).state, "unsupported"); assert.deepEqual(invalid.viewedCurves(), []);
});