# Roadmap
- [x] Phase 1: design, database + order engine, worker (launches/migrations/swaps/candles), Discover, token terminal, market order ticket, portfolio, sign-in, coverage page
- [ ] Deploy worker to an always-on host (waits on user)
- [ ] Funded PumpPortal API key for live swaps (waits on user)
- [x] Free on-chain chart history for viewed Pump.fun curves, all timeframes, gap-safe paging
- [x] Chart reliability: RPC budget/retries, free live trade hints, bounded backfill, narrow candles, mobile chart (worker redeploy needed)
- [ ] Worker ingest rejects some market batches (duplicate chain+address) — investigate separately
- [ ] Phase 2: limit orders, migration order handling, Explore, Bubbles, watchlist, settings
- [ ] Phase 3: CoinGecko history, gap recovery, more adapters, full verification run
