# Meme-coin paper-trading terminal — phased plan

Real markets, simulated trades. The brief is large, so it ships in phases. Each phase ends with a working, tested slice. Phase 1 proves the core loop first: a real launch appears, real swaps move its chart, and you can paper buy and sell.

## What needs you (one-time)
- **Lovable Cloud**: I turn this on. It handles sign-in, watchlists and the paper-trading ledger.
- **Always-on worker host** (Railway, Fly.io or Render): Lovable can't run a WebSocket listener around the clock. I write the worker and its deploy files. You click deploy and paste the variables I list.
- **PumpPortal API key** (optional at first): live trade feeds are paid. Launches and migrations work without a key.
- **CoinGecko on-chain key** (optional): for older chart history.

Until the worker is live and verified, the terminal shows an honest setup state with no invented tokens or prices.

## Phase 1 — Core loop
1. Design system: a dense, dark terminal with original branding and monospace numbers, plus a slim nav bar and a balance chip with a "Paper Trading" badge.
2. Database: profiles/accounts (configurable $10,000 start), markets, tokens, orders, fills, positions, ledger, watchlist. Row-level security limits users to their own rows. Transactional SQL functions (`place_market_order`, `reset_account`) take idempotency keys and row locks.
3. Worker (`/worker`, TypeScript Node): one PumpPortal socket (new token + migration, plus capped, metered trade subscriptions), a pump.fun bonding-curve quote model, DEX Screener enrichment cache, SOL/USD reference, candle builder from real swaps (deduplicated, handles out-of-order events), REST snapshots plus browser WebSocket with sequence numbers, and `/health` and `/status` endpoints. Writes markets and marks to the database for order validation.
4. Frontend: Discovery's three columns (New Pairs / Final Stretch / Migrated) with filters and sorting, the token terminal (lightweight-charts candles + volume, 1s–1D, live tape, copy-address and Solscan links), and an order ticket (market buy/sell, presets, 25–100%, slippage, quote preview with fee and price impact).
5. Portfolio: cash, positions, average entry, realised/unrealised P&L, fills, history, and reset with confirmation.
6. Tests: ledger math, quote model, candle aggregation and dedup, idempotency.

## Phase 2
Limit orders (reservations, safe cancel-vs-fill, stale-feed pause), migration handling (holdings carry over; the retired market's orders get explicit statuses), Explore search, Bubbles view, watchlist and settings.

## Phase 3
CoinGecko history with marked gaps, reconnect gap recovery, an adapter for more launchpads and DEXs, mobile tab/drawer polish, and a full verification run (two-account isolation, concurrency, comparison against an on-chain signature).

## Technical notes
- Market ID = chain + pool address, or the curve address before migration. Token ID = chain + mint.
- Every price stores its quote denomination and timestamp. USD shows as stale when SOL/USD is stale.
- Paper execution is disabled wherever there is no live trade source ("Live swaps unavailable").
- Deliverables: `.env.example`, `worker/README` with the exact deploy steps, and a final handoff report.
