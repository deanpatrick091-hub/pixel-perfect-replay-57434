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
