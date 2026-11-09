import { log } from "./log.ts";
import { pair } from "./dexscreener.ts";

// SOL/USD reference. Primary: CoinGecko simple price. Fallback: DEX Screener SOL/USDC (Raydium) pair.
const SOL_USDC_POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
export const solUsd = { price: null as number | null, updatedAt: 0, source: "" };

async function refresh() {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    if (r.ok) {
      const j: any = await r.json();
      const p = Number(j?.solana?.usd);
      if (p > 0) { Object.assign(solUsd, { price: p, updatedAt: Date.now(), source: "coingecko" }); return; }
    }
  } catch {}
  const p = await pair(SOL_USDC_POOL);
  const v = Number(p?.priceUsd);
  if (v > 0) Object.assign(solUsd, { price: v, updatedAt: Date.now(), source: "dexscreener:raydium-sol-usdc" });
  else log("warn", "SOL/USD unavailable");
}

export function startSolUsd() {
  refresh();
  setInterval(refresh, 30_000).unref();
}
export const solUsdFresh = () => solUsd.price != null && Date.now() - solUsd.updatedAt < 120_000;
