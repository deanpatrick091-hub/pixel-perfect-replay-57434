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
  tradeSubsWithoutKey: env.TRADE_SUBS_WITHOUT_KEY === "true",
  finalStretch: Number(env.FINAL_STRETCH_THRESHOLD ?? 0.7),
  workerId: env.WORKER_ID ?? "primary",
};

export const tradeSubsEnabled = () => Boolean(config.pumpPortalKey) || config.tradeSubsWithoutKey;
