// Manual benchmark (not a test): measures first-candle and swap-count timings for one real market over free RPC.
import { createRpc } from "./src/history/rpc.ts";
import { createHistoryService } from "./src/history/service.ts";
const log: string[] = []; const T = Date.now();
const pool = process.argv[2], mint = process.argv[3], secs = Number(process.argv[4] ?? 40);
const client = createRpc({ url: "https://api.mainnet-beta.solana.com", maxRps: Number(process.env.RPS ?? 2), maxQueue: 100, fetch: (async (u: any, init: any) => { const r = await fetch(u, init); const m = JSON.parse(init.body).method; log.push(`${((Date.now() - T) / 1000).toFixed(1)} ${m} ${r.status} rem=${r.headers.get("x-ratelimit-method-remaining")}`); return r; }) as any });
const svc = createHistoryService({ rpc: client.rpc, coolingDown: client.coolingDown, cooldownUntil: client.cooldownUntil });
const m: any = { id: `solana:pool:${pool}`, chain: "solana", kind: "amm", venue: "pumpswap", quoteCcy: "SOL", address: pool, mint, status: "active" };
const t0 = Date.now(); let first: number | null = null; const marks: Record<number, number> = {};
while (Date.now() - t0 < secs * 1000) {
  const h: any = svc.history(m, m.id, 60);
  if (h.candles.length && first == null) first = Date.now() - t0;
  for (const n of [10, 25, 40]) if (h.swaps >= n && marks[n] == null) marks[n] = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 200));
}
const h: any = svc.history(m, m.id, 60);
console.log(JSON.stringify({ firstCandleMs: first, swapsAtMs: marks, swaps: h.swaps, scanned: h.scannedTransactions, pending: h.pendingTransactions, requests: client.stats.requests, limited: client.stats.limited, state: h.state, error: h.error }));
if (process.env.TRACE) console.log(log.join("\n"));
process.exit(0);
