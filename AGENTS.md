<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

## Architecture
- Upstream market feeds live only in `worker/` (always-on Node service, deployed separately); never connect to PumpPortal or other paid feeds from the browser or server functions — they need persistent sockets and keys stay server-side.
- The worker pushes executable market state to `/api/public/worker-ingest` (shared-secret gated); the site discovers the worker's public URL from `worker_status` heartbeats, so the frontend has no feed config. The browser reads only the latest heartbeat (time/status/URL) through the security-definer `worker_service_status()` RPC so a long-dead worker shows as offline, not never-connected; ingest rejects per-row chain+address conflicts instead of failing the batch.
- All paper-trading money movement happens inside SQL functions (`place_market_order`, `reset_paper_account`) with a per-user row lock and idempotency keys; users can only read their tables (RLS).
- Quote math and candle aggregation live in `src/lib/market/`, shared by the UI and the worker; keep them dependency-free.
- Never render invented tokens, prices or candles; show an explicit unavailable/setup state instead.
- Chart history for Pump.fun curves and exact verified SOL-quoted PumpSwap pools comes from free public Solana RPC (`worker/src/history/`), decoded only from validated Pump TradeEvent / PumpSwap BuyEvent and SellEvent self-CPIs; PumpSwap account owner, discriminator, pool PDA, base/quote mints and vaults are verified before scanning, then each buy/sell parent and event accounts plus transaction vault decimals must match. Chart prices/volume use gross pool quote notional excluding separately reported fees; it is read-only, worked only for viewed markets, cached per market, budgeted through one shared bounded priority queue (live hint > newest > backfill; 429/403 are global backoffs, never retried around), and must never feed quotes, executable state or paper orders. `logsSubscribe` notifications are hints only: a swap is charted after the same getTransaction validation, and polled signature scans remain the gap-safe catch-up. Swap identity (`signature:instructionPosition`) stays separate from chart order (slot, valid RPC `transactionIndex` else RPC listing rank, event position); incomplete coverage is never reported as empty/complete, backfill bounds and per-market memory caps are disclosed.
- Chart viewport rules (narrow fixed bar spacing, minimum visible bar slots, tail-only updates) live in `src/lib/chart/viewport.ts` and are unit-tested; the chart never auto-fits sparse data across the screen.
- Chart default is a compact traded-interval view (only real candles side by side, real timestamps, compressed quiet intervals counted and disclosed); an optional time-spaced mode expands gaps as bounded time-only whitespace. Never join opens to closes or invent bars. Price labels use data-adaptive significant digits (`priceDigits`) so ticks stay distinct. Buy/sell quote volume comes from verified event direction, independent of candle colour.
