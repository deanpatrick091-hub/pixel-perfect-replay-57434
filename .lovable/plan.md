# Connect the Railway worker to the preview (secret provisioning)

## Findings (verified now)
- Site secrets present: `WORKER_INGEST_SECRET` (set earlier via secure form), plus managed `LOVABLE_API_KEY`, `LOVABLE_CRON_SECRET`. Values not read.
- Ingest endpoint still rejects a wrong bearer with 401 — authentication intact.
- Worker at Railway is live: upstream PumpPortal connected, 309 launches and 24 migrations seen, 0 trade messages, 0 active trade subscriptions (metered feed off as requested).
- Worker reports `ingest.configured: false`, `pushes: 0` — it is missing `INGEST_URL` and/or `WORKER_INGEST_SECRET` in its Railway variables, so nothing reaches the site yet.

## Can my tools provision it without you?
No, not end to end:
- `generate_secret` creates a value nobody can ever read, so it can't be copied into Railway.
- `set_secret` / `generate_secret` only create new names; `WORKER_INGEST_SECRET` already exists and can't be overwritten by me.
- I have no access to your Railway project.
A shared secret must therefore be held by you once. Weakening auth (skipping the check, logging the value) is not an option.

## Minimal secure next action (you, ~2 minutes)
1. Make one strong value: `openssl rand -hex 32` (or a password manager).
2. Lovable: Project Settings → Secrets → update `WORKER_INGEST_SECRET` with it. (Skip if you still have the exact value you saved earlier.)
3. Railway → market-worker → Variables: set `WORKER_INGEST_SECRET` to the same value; confirm `INGEST_URL=https://id-preview--05c8e19c-2db3-4f33-896c-0f9126c1b9fe.lovable.app/api/public/worker-ingest`, `PUBLIC_URL=https://market-worker-production-eee0.up.railway.app`, `ALLOWED_ORIGINS` includes the preview URL, `ENABLE_TRADE_SUBSCRIPTIONS=false`. Redeploy.

## What I do after approval
- Poll worker `/status` until `ingest.configured: true` and `pushes` rising with `lastError: null`.
- Confirm a heartbeat row with the Railway `public_url` and fresh market rows in the database.
- Open the preview in a browser, confirm Coverage shows the worker online and New Pairs lists live launches; report one verified mint and one migration from the feed.
- No code or design changes expected; fix only if verification uncovers a bug.
