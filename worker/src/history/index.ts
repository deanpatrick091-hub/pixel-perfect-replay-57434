import { config } from "../config.ts";
import { createLiveLogs } from "./liveLogs.ts";
import { createHistoryService } from "./service.ts";
import { rpc, rpcCoolingDown, rpcCooldownUntil, rpcStats } from "./rpc.ts";

// Wiring: one shared RPC budget, one live-hint socket for viewed curves, one history cache.
type ChangeFn = (marketId: string) => void;
const changeListeners = new Set<ChangeFn>();
let svc: ReturnType<typeof createHistoryService>;

const live = createLiveLogs({
  url: config.solanaWsUrl, maxSubs: config.wsMaxSubs,
  onHint: (h) => svc.hint(h),
  onReconnect: (curves) => svc.catchUp(curves),
});

svc = createHistoryService({
  rpc, coolingDown: rpcCoolingDown, cooldownUntil: rpcCooldownUntil,
  onChange: (id) => changeListeners.forEach((f) => f(id)),
  live: config.wsEnabled ? live : undefined,
});

if (config.wsEnabled) setInterval(() => live.setWanted(svc.viewedCurves()), 3_000).unref();

export const history = svc.history;
export const onHistoryChange = (f: ChangeFn) => { changeListeners.add(f); return () => changeListeners.delete(f); };
export const historyStats = () => ({
  ...svc.stats, entries: svc.stats.entries(), rpc: rpcStats,
  liveLogs: config.wsEnabled ? { enabled: true, ...live.stats, url: config.solanaWsUrl.replace(/([?&](api[-_]?key|token)=)[^&]+/i, "$1***") } : { enabled: false },
});
