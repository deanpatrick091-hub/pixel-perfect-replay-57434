import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptFallback, consensusSolUsd } from "../src/solusd.ts";

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const pairOf = (priceUsd: string, liq: number, base = WSOL, quote = USDC) =>
  ({ chainId: "solana", dexId: "x", pairAddress: Math.random().toString(), baseToken: { address: base, symbol: "SOL", name: "SOL" }, quoteToken: { address: quote, symbol: "USDC" }, priceUsd, liquidity: { usd: liq } }) as any;

test("SOL/USD fallback: median of deep agreeing SOL/stable pairs; shallow or non-SOL pairs ignored", () => {
  const v = consensusSolUsd([pairOf("71.11", 16e6), pairOf("71.03", 15e6), pairOf("71.09", 5e6), pairOf("52.63", 50_000), pairOf("3.5", 9e6, "MOON")]);
  assert.equal(v, 71.09);
});

test("SOL/USD fallback: disagreeing pairs give no value", () => {
  assert.equal(consensusSolUsd([pairOf("71.0", 16e6), pairOf("52.63", 15e6)]), null);
  assert.equal(consensusSolUsd([pairOf("71.0", 16e6)]), null);
});

test("SOL/USD fallback never replaces a fresh primary, and is rejected when it jumps from the recent primary", () => {
  const now = 1_000_000_000;
  const primary = { price: 71.19, at: now - 30_000 };
  // The live alternation observed on Render: CoinGecko 71.19, fallback 52.63.
  assert.equal(acceptFallback(52.63, primary, { price: 71.19, updatedAt: now - 30_000, source: "coingecko" }, now).ok, false);
  assert.equal(acceptFallback(52.63, primary, { price: 71.19, updatedAt: now - 200_000, source: "coingecko" }, now).ok, false);
  assert.equal(acceptFallback(71.05, primary, { price: 71.19, updatedAt: now - 200_000, source: "coingecko" }, now).ok, true);
  // With no recent primary, an agreeing fallback is accepted.
  assert.equal(acceptFallback(52.63, null, { price: null, updatedAt: 0, source: "" }, now).ok, true);
});
