import { config, runtime, tradeSubsEnabled } from "./config.ts";
import { log } from "./log.ts";
import { PumpPortalAdapter } from "./adapters/pumpportal.ts";
import { Store, marketId, type Market } from "./store.ts";
import { startServer } from "./server.ts";
import { startSolUsd, solUsd, solUsdFresh } from "./solusd.ts";
import { pair, tokenPairs, dexStats } from "./dexscreener.ts";
import { push, ingestStats } from "./ingest.ts";
import { historyStats } from "./history/service.ts";

const store = new Store();
const pump = new PumpPortalAdapter();
const subscribed: string[] = []; // mints, oldest first
let viewing = new Set<string>();
let upstreamConnected = false;
const startedAt = Date.now();

function subscribe(mint: string) {
  if (!tradeSubsEnabled() || subscribed.includes(mint)) return;
  while (subscribed.length >= config.maxTradeSubs) {
    // Drop the oldest subscription that nobody is viewing.
    const idx = subscribed.findIndex((x) => !(store.byMint.get(x) ?? []).some((id) => viewing.has(id)));
    if (idx < 0) break;
    const [gone] = subscribed.splice(idx, 1);
    pump.unsubscribeTrades([gone]);
    for (const id of store.byMint.get(gone) ?? []) {
      const m = store.markets.get(id);
      if (m && m.status === "active") { m.tradeFeed = "unavailable"; store.markDirty(id); }
    }
  }
  if (subscribed.length >= config.maxTradeSubs) return;
  subscribed.push(mint);
  pump.subscribeTrades([mint]);
}

function coverage() {
  const trades = runtime.tradesRejected ? `rejected by PumpPortal: ${runtime.tradesRejected}` : tradeSubsEnabled()
    ? `live for up to ${config.maxTradeSubs} subscribed mints (metered)`
    : "unavailable — set PUMPPORTAL_API_KEY to enable";
  return {
    "solana/pumpfun/bonding-curve": { launches: upstreamConnected ? "live" : "reconnecting", migrations: upstreamConnected ? "live" : "reconnecting", trades, quoteModel: "pump_curve_v1 (constant product on virtual reserves)", chartHistory: "polled candles (all timeframes) from Pump TradeEvents via Solana RPC for viewed curves; recent window only; read-only, not used for execution", paperExecution: tradeSubsEnabled() ? "enabled on subscribed curves with fresh state" : "disabled (no live trade source)" },
    "solana/pumpswap/amm": { destinationPools: "resolved via DEX Screener after verified migration event", trades: tradeSubsEnabled() ? "unverified until first swap observed per pool" : "unavailable", quoteModel: "cpmm_reserves from DEX Screener liquidity (refreshed ~15s)" },
    "solana/raydium,meteora,other": { trades: "not covered yet", paperExecution: "disabled" },
  };
}

function status() {
  return {
    workerId: config.workerId, uptimeSec: Math.round((Date.now() - startedAt) / 1000), seq: store.seq,
    feed: { upstream: upstreamConnected ? "connected" : "reconnecting", ...pump.stats() },
    trackedMarkets: store.markets.size, duplicateSwaps: store.dupes, viewers: server.clientCount(),
    solUsd: { price: solUsd.price, source: solUsd.source, updatedAt: solUsd.updatedAt, fresh: solUsdFresh() },
    dexscreener: dexStats, chartHistory: { ...historyStats, entries: historyStats.entries(), rpcUrl: config.solanaRpcUrl.replace(/([?&](api[-_]?key|token)=)[^&]+/i, "$1***") }, ingest: { ...ingestStats, configured: !!(config.ingestUrl && config.ingestSecret) },
    coverage: coverage(),
  };
}

// Token metadata URIs point to JSON; resolve the image field (best effort, bounded).
let metaInFlight = 0;
async function resolveImage(m: Market) {
  const uri = m.imageUri;
  if (!uri || !/^https?:\/\//.test(uri) || metaInFlight > 8) { if (uri && !/^https?:/.test(uri)) m.imageUri = null; return; }
  metaInFlight++;
  try {
    const ctl = AbortSignal.timeout(4000);
    const r = await fetch(uri, { signal: ctl });
    const ct = r.headers.get("content-type") ?? "";
    if (ct.startsWith("image/")) return;
    const j: any = await r.json();
    m.imageUri = typeof j?.image === "string" && /^https?:\/\//.test(j.image) ? j.image : null;
  } catch { m.imageUri = null; } finally { metaInFlight--; store.markDirty(m.id); }
}

async function resolveDestination(curve: Market, attempt = 0) {
  const delays = [5_000, 20_000, 60_000, 180_000, 600_000];
  const pairs = await tokenPairs(curve.mint);
  const p = pairs.filter((x) => x.chainId === "solana" && x.baseToken?.address === curve.mint && x.quoteToken?.symbol?.toUpperCase().includes("SOL"))
    .sort((a, b) => (a.dexId === "pumpswap" ? -1 : 0) - (b.dexId === "pumpswap" ? -1 : 0) || (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  if (!p) {
    if (attempt < delays.length) setTimeout(() => resolveDestination(curve, attempt + 1), delays[attempt]);
    else log("warn", "destination pool not found", { mint: curve.mint });
    return;
  }
  const id = marketId("solana", "amm", p.pairAddress);
  const now = Date.now();
  const amm: Market = {
    id, chain: "solana", kind: "amm", address: p.pairAddress, mint: curve.mint, venue: p.dexId, quoteCcy: "SOL",
    name: curve.name ?? p.baseToken.name, symbol: curve.symbol ?? p.baseToken.symbol, imageUri: curve.imageUri ?? p.info?.imageUrl ?? null,
    launchedAt: p.pairCreatedAt ?? now, status: "active", stage: "migrated", curveProgress: null,
    reserveQuote: p.liquidity?.quote ?? null, reserveBase: p.liquidity?.base ?? null, priceQuote: Number(p.priceNative) || null,
    totalSupply: curve.totalSupply, circulatingSupply: curve.circulatingSupply, liquidityUsd: p.liquidity?.usd ?? null, liquidityAt: now,
    tradeFeed: pump.isSubscribed(curve.mint) ? "unverified" : "unavailable", quoteModel: "cpmm_reserves", stateSource: "dexscreener",
    stateUpdatedAt: now, migratedTo: null, migratedFrom: curve.id, lastTradeAt: null, launchSignature: null,
  };
  curve.migratedTo = id;
  store.markDirty(curve.id);
  store.addAmm(amm);
  log("info", "destination pool verified", { mint: curve.mint, pool: p.pairAddress, dex: p.dexId });
}

pump.start({
  onLaunch(l) {
    const m = store.upsertLaunch(l, tradeSubsEnabled() ? "live" : "unavailable");
    subscribe(m.mint);
    resolveImage(m);
    if (!pump.isSubscribed(m.mint) && m.tradeFeed === "live") { m.tradeFeed = "unavailable"; store.markDirty(m.id); }
  },
  onSwap(s) { store.addSwap(s); },
  onMigration(mg) {
    const curve = store.migrate(mg);
    if (curve) resolveDestination(curve);
    else log("info", "migration for untracked mint", { mint: mg.mint });
  },
  onStatus(s) {
    upstreamConnected = s.connected;
    if (s.reason === "trades_rejected") {
      for (const m of store.markets.values()) if (m.status === "active" && m.tradeFeed !== "unavailable") { m.tradeFeed = "unavailable"; store.markDirty(m.id); }
    }
  },
});
startSolUsd();
const server = startServer(store, status, (v) => {
  viewing = v;
  for (const id of v) { const m = store.markets.get(id); if (m) subscribe(m.mint); }
});

// Subscribed curves: no swap while subscribed ⇒ curve state unchanged, so state stays fresh while upstream is connected.
setInterval(() => {
  if (!upstreamConnected) return;
  const now = Date.now();
  for (const mint of subscribed) for (const id of store.byMint.get(mint) ?? []) {
    const m = store.markets.get(id);
    if (m && m.kind === "curve" && m.status === "active" && m.tradeFeed === "live") { m.stateUpdatedAt = now; m.stateSource = "pumpportal:subscribed"; store.dirty.add(id); }
  }
}, 10_000).unref();

// AMM pools: refresh reserves/liquidity from DEX Screener (shared cache).
setInterval(async () => {
  const amms = [...store.markets.values()].filter((m) => m.kind === "amm" && m.status === "active").slice(0, 60);
  for (const m of amms) {
    const p = await pair(m.address);
    if (!p || p.baseToken?.address !== m.mint) continue;
    const now = Date.now();
    m.reserveQuote = p.liquidity?.quote ?? m.reserveQuote;
    m.reserveBase = p.liquidity?.base ?? m.reserveBase;
    m.priceQuote = Number(p.priceNative) || m.priceQuote;
    m.liquidityUsd = p.liquidity?.usd ?? m.liquidityUsd;
    m.liquidityAt = now;
    m.stateUpdatedAt = now;
    m.stateSource = "dexscreener";
    store.markDirty(m.id);
  }
}, 15_000).unref();

setInterval(() => push(store), 1000).unref();
setInterval(() => push(store, {
  id: config.workerId, public_url: config.publicUrl, status: upstreamConnected ? "live" : "reconnecting",
  coverage: coverage(), stats: status(),
}), 10_000).unref();

log("info", "worker started", { tradeSubs: tradeSubsEnabled(), ingest: !!config.ingestUrl, publicUrl: config.publicUrl });
