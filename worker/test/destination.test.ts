import { test } from "node:test";
import assert from "node:assert/strict";
import { pickDestination } from "../src/destination.ts";

const curve = { mint: "MINT", address: "CURVE" };
const pair = (dexId: string, pairAddress: string, usd = 1) => ({ chainId: "solana", dexId, pairAddress, baseToken: { address: "MINT" }, quoteToken: { symbol: "SOL" }, liquidity: { usd } });

test("destination: the bonding curve's own pumpfun listing is never chosen as a pool", () => {
  assert.equal(pickDestination([pair("pumpfun", "CURVE", 999)], curve, () => false), undefined);
  assert.equal(pickDestination([pair("pumpswap", "CURVE")], curve, () => false), undefined);
});

test("destination: prefers the PumpSwap pool and skips addresses already tracked", () => {
  assert.equal(pickDestination([pair("raydium", "R", 50), pair("pumpswap", "P", 1)], curve, () => false)?.pairAddress, "P");
  assert.equal(pickDestination([pair("pumpswap", "P")], curve, (a) => a === "P"), undefined);
});
