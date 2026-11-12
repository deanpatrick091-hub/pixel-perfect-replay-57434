# Market worker

Always-on Node.js service that listens to live Solana launch / migration / swap feeds and
serves them to the website. It must run on a host with persistent processes and WebSockets
(Railway, Fly.io, Render). It does **not** run inside Lovable.

## What it does
- One upstream socket to PumpPortal (`wss://pumpportal.fun/api/data`): `subscribeNewToken`,
  `subscribeMigration` (free), and `subscribeTokenTrade` for up to `MAX_TRADE_SUBSCRIPTIONS`
  mints (requires a PumpPortal API key **funded with at least 0.02 SOL**; messages are metered).
- Builds candles and the trade tape only from swaps it observes (no generated history).
- Resolves post-migration pools via DEX Screener (`token-pairs/v1/solana/{mint}`), refreshes
  pool reserves via `latest/dex/pairs/solana/{pool}` with a shared cache.
- SOL/USD from CoinGecko simple price, falling back to the Raydium SOL/USDC pair on DEX Screener.
- Pushes executable market state + SOL/USD + heartbeat to the website's
  `/api/public/worker-ingest` every second, authenticated with `WORKER_INGEST_SECRET`.
- Serves the browser: `GET /api/snapshot`, `/api/search?q=`, `/api/markets/:id`,
  `/api/candles?market=&tf=` and `WS /ws` (`{"op":"sub","topics":["discovery"|"market:<id>"]}`).
- Ops: `GET /health`, `GET /status` (upstream, last event, lag, reconnects, active trade
  subscriptions, metered message count, ingest status, coverage map). Secrets are redacted in logs.

## Run locally
```bash
cd worker && npm install
cp .env.example .env   # fill in values
node --env-file=.env --import tsx src/index.ts
```

## Deploy on Railway (example)
1. New Project → Deploy from GitHub repo (this repository).
2. Settings → Build → Builder: Dockerfile, Dockerfile path `worker/Dockerfile`, root directory: repository root.
3. Variables: copy every key from `worker/.env.example`. `WORKER_INGEST_SECRET` must equal the
   value saved in Lovable. `PUBLIC_URL` = the Railway public domain (Settings → Networking → Generate Domain).
4. Deploy, then open `https://<your-domain>/status`. The website picks the worker up automatically
   from its heartbeat within ~10 seconds.

## Coverage (honest)
| Launchpad / venue | Launches | Migrations | Live swaps | Paper execution |
|---|---|---|---|---|
| pump.fun bonding curve | live | live | with funded PumpPortal key | yes, when state is fresh |
| PumpSwap (post-migration) | — | destination resolved via DEX Screener | unverified until first swap seen | only when feed verified + fresh |
| Raydium, Meteora, others | not covered | not covered | not covered | disabled |

Swap events from PumpPortal carry no block timestamp or instruction index; the worker records
receipt time and uses `signature + market` as event identity. Listing coverage and timing will
differ from Axiom, FOMO and DEX Screener.

## Chart history (free, read-only: live hints + polled catch-up)
Opened Pump.fun bonding-curve markets get candles from on-chain swaps via free public Solana JSON-RPC
(`getSignaturesForAddress` on the verified curve PDA + `getTransaction`, decoding official Pump `TradeEvent` self-CPIs).
- **Live hints:** for up to `SOLANA_WS_MAX_SUBS` curves someone is viewing (history polled in the last ~35s), the worker
  holds a free `logsSubscribe` (`mentions: [curve]`, `confirmed`) on `SOLANA_WS_URL`. Failed transactions in notifications
  are dropped; every other signature is fetched with `getTransaction` at top priority and charted only after the same
  TradeEvent validation. Viewers get a `charts` nudge over the worker socket and refetch their timeframe.
  Measured on a busy curve (Nov 2026, free endpoint): median ~1.7s notification→chart, ~2.8s block time→chart.
  Delivery of every swap isn't guaranteed; reconnects (backoff 1s→30s, ping watchdog) trigger an immediate catch-up scan.
- **Order of work:** live hints > newest signatures (re-listed every 15s, gap-safe paging) > older backfill.
  First view seeds from the newest 100 signatures, then pages older history at low priority until it reaches the curve's
  first transaction, 1,000 signatures, or 60 minutes before first view, whichever comes first; the chart says which.
- **RPC budget:** one shared queue (default 2 req/s, 2 concurrent, max 100 queued; full queue rejects instead of growing).
  Timeouts/network/5xx are retried once, then the transaction is retried with backoff (live: 1–5s; history: 1s→60s, 8 tries)
  before it's reported as failed. 429 → global cooldown 5s→2min and the budget slows (x1.5, down to 1/4); 403 → separate
  "refused" cooldown 1–10min. Queued work is released with the backoff error; nothing retries around a limit.
- Swap identity is `signature:instructionPosition`. Chart order is slot, then the RPC's `transactionIndex` when every swap in that slot has a valid one (live-hinted swaps learn it from the next listing), else RPC listing rank (deterministic, not guaranteed execution order), then event position.
- Coverage is `complete` only when nothing is pending, failed to load, missing, dropped, trimmed or rejected and backfill has stopped; otherwise the chart shows partial/unavailable with counts. Retained swaps (5,000), processed signatures (3,000) and open scan rows (600) are capped per market; trimming and scan gaps are disclosed.
- All timeframes (`1s`…`1D`) aggregate the same verified swaps. A candle's close/high/low/volume change with each swap; a new candle appears only when a swap lands in a new interval (quiet intervals have no candle).
- Migrated AMM pools are not charted; completed curves show their pre-migration swaps.
This data is never used for quotes or paper execution.
- `SOLANA_RPC_URL` (optional) — defaults to the free public `https://api.mainnet-beta.solana.com`.
- `SOLANA_RPC_MAX_RPS` (optional, default 2) · `SOLANA_RPC_TIMEOUT_MS` (default 15000).
- `SOLANA_WS_URL` (optional, default derived from `SOLANA_RPC_URL`: `wss://api.mainnet-beta.solana.com`) · `SOLANA_WS_ENABLED` (default true) · `SOLANA_WS_MAX_SUBS` (default 5).
Endpoint: `GET /api/history?market=<id>&tf=<1s|5s|15s|1m|5m|15m|1h|4h|1D>[&retry=1]`. `/status` → `chartHistory.rpc`, `chartHistory.liveLogs`. Tests: `cd worker && npm test`.
