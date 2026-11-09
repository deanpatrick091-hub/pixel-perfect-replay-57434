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
- The worker pushes executable market state to `/api/public/worker-ingest` (shared-secret gated); the site discovers the worker's public URL from `worker_status` heartbeats, so the frontend has no feed config.
- All paper-trading money movement happens inside SQL functions (`place_market_order`, `reset_paper_account`) with a per-user row lock and idempotency keys; users can only read their tables (RLS).
- Quote math and candle aggregation live in `src/lib/market/`, shared by the UI and the worker; keep them dependency-free.
- Never render invented tokens, prices or candles; show an explicit unavailable/setup state instead.
