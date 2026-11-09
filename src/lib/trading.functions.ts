import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const OrderInput = z.object({
  marketId: z.string().min(5).max(140),
  side: z.enum(["buy", "sell"]),
  amount: z.number().positive().finite(),
  slippageBps: z.number().int().min(1).max(5000),
  expectedPriceUsd: z.number().positive().finite(),
  idempotencyKey: z.string().min(8).max(100),
});

export type OrderResult = {
  order_id: string; status: "filled" | "rejected"; reason?: string | null; qty?: number; price_usd?: number;
  fee_usd?: number; price_impact_bps?: number; realized_pnl_usd?: number | null; duplicate?: boolean;
};

export const placeMarketOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: z.infer<typeof OrderInput>) => OrderInput.parse(i))
  .handler(async ({ data, context }) => {
    const { data: res, error } = await context.supabase.rpc("place_market_order", {
      p_market_id: data.marketId,
      p_side: data.side,
      p_amount: data.amount,
      p_slippage_bps: data.slippageBps,
      p_expected_price_usd: data.expectedPriceUsd,
      p_idempotency_key: data.idempotencyKey,
    });
    if (error) throw new Error(error.message);
    return res as unknown as OrderResult;
  });

export const resetPaperAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.rpc("reset_paper_account");
    if (error) throw new Error(error.message);
    return data as { cash_usd: number };
  });
