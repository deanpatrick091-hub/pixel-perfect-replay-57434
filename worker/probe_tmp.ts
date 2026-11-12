import { createHistoryService } from "./src/history/service.ts";
import { createLiveLogs } from "./src/history/liveLogs.ts";
import { rpc, rpcCoolingDown, rpcCooldownUntil, rpcStats } from "./src/history/rpc.ts";
import { marketId, type Market } from "./src/store.ts";
const [mint, curve] = process.argv.slice(2);
const m = { id: marketId("solana", "curve", curve), chain: "solana", kind: "curve", address: curve, mint, venue: "pumpfun", quoteCcy: "SOL", status: "active" } as unknown as Market;
let svc: any;
const live = createLiveLogs({ url: "wss://api.mainnet-beta.solana.com", maxSubs: 5, onHint: (h) => { svc.hint(h); }, onReconnect: (c) => svc.catchUp(c) });
const changes: number[] = [];
svc = createHistoryService({ rpc, coolingDown: rpcCoolingDown, cooldownUntil: rpcCooldownUntil, live, onChange: () => changes.push(Date.now()) });
const t0 = Date.now();
const lat: number[] = [], chain: number[] = [];
let lastLiveSwaps = 0;
const tick = setInterval(() => {
  const h = svc.history(m, m.id, 60);
  live.setWanted(svc.viewedCurves());
  if (h.live.swaps > lastLiveSwaps) { lastLiveSwaps = h.live.swaps; lat.push(h.live.hintToChartMs); chain.push(h.live.chainToChartMs); }
  const s = Math.round((Date.now() - t0) / 1000);
  if (s % 10 === 0) console.log(`${s}s state=${h.state} swaps=${h.swaps} c1m=${h.candles.length} pending=${h.pendingTransactions} backfill=${h.backfill.state}/${h.backfill.listedSignatures} oldest=${h.oldestTs ? new Date(h.oldestTs*1000).toISOString().slice(11,19) : "-"} newest=${h.newestTs ? new Date(h.newestTs*1000).toISOString().slice(11,19) : "-"} live=${h.live.state} hints=${h.live.hints} liveSwaps=${h.live.swaps} rpc=${rpcStats.requests}/${rpcStats.ok} to=${rpcStats.timeouts} lim=${rpcStats.limited} 403=${rpcStats.forbidden} q=${rpcStats.queued} lat=${rpcStats.latencyMs}`);
}, 1000);
setTimeout(() => {
  clearInterval(tick);
  const h = svc.history(m, m.id, 60);
  const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
  const med = (a: number[]) => a.length ? sorted(a)[Math.floor(a.length / 2)] : null;
  console.log("hint->chart ms median", med(lat), "max", Math.max(...lat), "n", lat.length, "| blockTime->chart ms median", med(chain), "max", Math.max(...chain));
  console.log("live stats", JSON.stringify(live.stats));
  console.log("candles 1m (t,o,h,l,c,buys,sells):", JSON.stringify(h.candles.slice(-6).map((c: any) => [new Date(c.t*1000).toISOString().slice(11,16), c.o.toExponential(4), c.h.toExponential(4), c.l.toExponential(4), c.c.toExponential(4), c.buys, c.sells])));
  console.log("total 1m candles", h.candles.length, "1s candles", svc.history(m, m.id, 1).candles.length, "5m", svc.history(m, m.id, 300).candles.length);
  live.stop(); process.exit(0);
}, Number(process.argv[4] ?? 170) * 1000);
