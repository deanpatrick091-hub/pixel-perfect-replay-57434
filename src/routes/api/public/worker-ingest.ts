import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

// The market worker pushes executable market state, reference prices and its heartbeat here.
// Public prefix (the worker has no user session) — the shared secret below is the only gate.

const num = z.number().finite().nullable().optional();
const MarketSchema = z.object({
  id: z.string().min(5).max(140),
  chain: z.string().max(20),
  kind: z.enum(["curve", "amm"]),
  address: z.string().min(20).max(64),
  mint: z.string().min(20).max(64),
  venue: z.string().max(40),
  quote_ccy: z.string().max(10),
  name: z.string().max(120).nullable().optional(),
  symbol: z.string().max(40).nullable().optional(),
  image_uri: z.string().max(500).nullable().optional(),
  launched_at: z.string().nullable().optional(),
  status: z.enum(["active", "migrated", "retired"]),
  stage: z.enum(["new", "final_stretch", "migrated"]),
  curve_progress: num,
  reserve_quote: num,
  reserve_base: num,
  price_quote: num,
  total_supply: num,
  circulating_supply: num,
  liquidity_usd: num,
  trade_feed: z.enum(["live", "unavailable", "unverified"]),
  quote_model: z.string().max(40).nullable().optional(),
  state_source: z.string().max(60).nullable().optional(),
  state_updated_at: z.string().nullable().optional(),
  migrated_to: z.string().max(140).nullable().optional(),
  migrated_from: z.string().max(140).nullable().optional(),
});

const BodySchema = z.object({
  markets: z.array(MarketSchema).max(500).default([]),
  reference_prices: z
    .array(z.object({ pair: z.string().max(20), price: z.number().positive(), source: z.string().max(60), updated_at: z.string() }))
    .max(10)
    .default([]),
  heartbeat: z
    .object({
      id: z.string().max(60),
      public_url: z.string().url().max(300).nullable(),
      status: z.string().max(30),
      coverage: z.record(z.unknown()),
      stats: z.record(z.unknown()),
    })
    .optional(),
});

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export const Route = createFileRoute("/api/public/worker-ingest")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["WORKER_INGEST_SECRET"];
        if (!secret || secret.length < 24) {
          return Response.json({ error: "WORKER_INGEST_SECRET is not configured on the website" }, { status: 503 });
        }
        const auth = request.headers.get("authorization") ?? "";
        if (!timingSafeEqual(auth, `Bearer ${secret}`)) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        let body: z.infer<typeof BodySchema>;
        try {
          body = BodySchema.parse(await request.json());
        } catch (e) {
          return Response.json({ error: "invalid payload", detail: String(e).slice(0, 500) }, { status: 400 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const now = new Date().toISOString();
        const errors: string[] = [];

        if (body.markets.length) {
          const { error } = await supabaseAdmin
            .from("markets")
            .upsert(body.markets.map((m) => ({ ...m, updated_at: now })) as never, { onConflict: "id" });
          if (error) errors.push(`markets: ${error.message}`);
        }
        if (body.reference_prices.length) {
          const { error } = await supabaseAdmin.from("reference_prices").upsert(body.reference_prices, { onConflict: "pair" });
          if (error) errors.push(`reference_prices: ${error.message}`);
        }
        if (body.heartbeat) {
          const hb = body.heartbeat;
          const { error } = await supabaseAdmin.from("worker_status").upsert(
            {
              id: hb.id,
              public_url: hb.public_url,
              status: hb.status,
              coverage: hb.coverage as never,
              stats: hb.stats as never,
              last_heartbeat_at: now,
            },
            { onConflict: "id" },
          );
          if (error) errors.push(`heartbeat: ${error.message}`);
        }
        if (errors.length) {
          console.error("worker-ingest failed", errors);
          return Response.json({ ok: false, errors }, { status: 500 });
        }
        return Response.json({ ok: true, markets: body.markets.length });
      },
    },
  },
});
