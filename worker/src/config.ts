const env = process.env;
const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const config = {
  port: Number(env.PORT ?? 8787),
  publicUrl: env.PUBLIC_URL || null,
  allowedOrigins: list(env.ALLOWED_ORIGINS),
  ingestUrl: env.INGEST_URL || null,
  ingestSecret: env.WORKER_INGEST_SECRET || null,
  pumpPortalKey: env.PUMPPORTAL_API_KEY || null,
  maxTradeSubs: Number(env.MAX_TRADE_SUBSCRIPTIONS ?? 40),
  // Metered trade subscriptions stay off unless explicitly enabled, even when a key is present.
  enableTradeSubs: env.ENABLE_TRADE_SUBSCRIPTIONS === "true",
  finalStretch: Number(env.FINAL_STRETCH_THRESHOLD ?? 0.7),
  // Free public mainnet RPC by default (https://solana.com/docs/references/clusters); override server-side.
  solanaRpcUrl: env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  rpcMaxRps: Number(env.SOLANA_RPC_MAX_RPS ?? 2),
  rpcTimeoutMs: Number(env.SOLANA_RPC_TIMEOUT_MS ?? 15_000),
  // Free public mainnet WebSocket (logsSubscribe) for curves someone is viewing; set SOLANA_WS_ENABLED=false to poll only.
  solanaWsUrl: env.SOLANA_WS_URL || (env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com").replace(/^http/, "ws"),
  wsEnabled: env.SOLANA_WS_ENABLED !== "false",
  wsMaxSubs: Number(env.SOLANA_WS_MAX_SUBS ?? 5),
  workerId: env.WORKER_ID ?? "primary",
};

export const runtime = { tradesRejected: null as string | null };
export const tradeSubsEnabled = () => config.enableTradeSubs && !runtime.tradesRejected;
