
-- ===== Config (public read) =====
CREATE TABLE public.app_config (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  starting_balance_usd numeric NOT NULL DEFAULT 10000,
  fee_bps int NOT NULL DEFAULT 100,
  quote_stale_seconds int NOT NULL DEFAULT 30,
  final_stretch_threshold numeric NOT NULL DEFAULT 0.7,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.app_config TO anon, authenticated;
GRANT ALL ON public.app_config TO service_role;
ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "config readable" ON public.app_config FOR SELECT TO anon, authenticated USING (true);
INSERT INTO public.app_config (id) VALUES (1);

-- ===== Worker status (public read, written via server ingest) =====
CREATE TABLE public.worker_status (
  id text PRIMARY KEY,
  public_url text,
  status text NOT NULL DEFAULT 'unknown',
  coverage jsonb NOT NULL DEFAULT '{}'::jsonb,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_heartbeat_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.worker_status TO anon, authenticated;
GRANT ALL ON public.worker_status TO service_role;
ALTER TABLE public.worker_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY "worker status readable" ON public.worker_status FOR SELECT TO anon, authenticated USING (true);

-- ===== Reference prices =====
CREATE TABLE public.reference_prices (
  pair text PRIMARY KEY,
  price numeric NOT NULL,
  source text NOT NULL,
  updated_at timestamptz NOT NULL
);
GRANT SELECT ON public.reference_prices TO anon, authenticated;
GRANT ALL ON public.reference_prices TO service_role;
ALTER TABLE public.reference_prices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ref prices readable" ON public.reference_prices FOR SELECT TO anon, authenticated USING (true);

-- ===== Markets (latest executable state, written by worker ingest) =====
CREATE TABLE public.markets (
  id text PRIMARY KEY,                 -- e.g. solana:curve:<address> or solana:pool:<address>
  chain text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('curve','amm')),
  address text NOT NULL,
  mint text NOT NULL,
  venue text NOT NULL,
  quote_ccy text NOT NULL,
  name text,
  symbol text,
  image_uri text,
  launched_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','migrated','retired')),
  stage text NOT NULL DEFAULT 'new' CHECK (stage IN ('new','final_stretch','migrated')),
  curve_progress numeric,
  reserve_quote numeric,               -- quote units (e.g. SOL), virtual for curves
  reserve_base numeric,                -- token units (human, decimals applied)
  price_quote numeric,                 -- quote per token
  total_supply numeric,
  circulating_supply numeric,
  liquidity_usd numeric,
  trade_feed text NOT NULL DEFAULT 'unavailable' CHECK (trade_feed IN ('live','unavailable','unverified')),
  quote_model text,                    -- e.g. pump_curve_v1, cpmm_reserves
  state_source text,
  state_updated_at timestamptz,
  migrated_to text,
  migrated_from text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, address)
);
CREATE INDEX markets_mint_idx ON public.markets (chain, mint);
GRANT SELECT ON public.markets TO anon, authenticated;
GRANT ALL ON public.markets TO service_role;
ALTER TABLE public.markets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "markets readable" ON public.markets FOR SELECT TO anon, authenticated USING (true);

-- ===== Paper accounts =====
CREATE TABLE public.paper_accounts (
  user_id uuid PRIMARY KEY,
  cash_usd numeric NOT NULL DEFAULT 0 CHECK (cash_usd >= 0),
  reserved_cash_usd numeric NOT NULL DEFAULT 0 CHECK (reserved_cash_usd >= 0),
  starting_balance_usd numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  reset_at timestamptz
);
GRANT SELECT ON public.paper_accounts TO authenticated;
GRANT ALL ON public.paper_accounts TO service_role;
ALTER TABLE public.paper_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own account" ON public.paper_accounts FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.paper_positions (
  user_id uuid NOT NULL,
  chain text NOT NULL,
  mint text NOT NULL,
  symbol text,
  qty numeric NOT NULL DEFAULT 0 CHECK (qty >= 0),
  reserved_qty numeric NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  cost_basis_usd numeric NOT NULL DEFAULT 0,
  realized_pnl_usd numeric NOT NULL DEFAULT 0,
  fees_usd numeric NOT NULL DEFAULT 0,
  last_market_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, chain, mint)
);
GRANT SELECT ON public.paper_positions TO authenticated;
GRANT ALL ON public.paper_positions TO service_role;
ALTER TABLE public.paper_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own positions" ON public.paper_positions FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.paper_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  market_id text NOT NULL,
  chain text NOT NULL,
  mint text NOT NULL,
  symbol text,
  side text NOT NULL CHECK (side IN ('buy','sell')),
  order_type text NOT NULL CHECK (order_type IN ('market','limit')),
  status text NOT NULL CHECK (status IN ('pending','open','filled','rejected','cancelled')),
  amount numeric NOT NULL,             -- buy: USD to spend; sell: tokens
  limit_price_usd numeric,
  expected_price_usd numeric,
  slippage_bps int NOT NULL,
  reject_reason text,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX paper_orders_user_idx ON public.paper_orders (user_id, created_at DESC);
GRANT SELECT ON public.paper_orders TO authenticated;
GRANT ALL ON public.paper_orders TO service_role;
ALTER TABLE public.paper_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own orders" ON public.paper_orders FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.paper_fills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.paper_orders(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  market_id text NOT NULL,
  mint text NOT NULL,
  symbol text,
  side text NOT NULL,
  qty numeric NOT NULL,
  price_usd numeric NOT NULL,
  price_quote numeric NOT NULL,
  quote_ccy text NOT NULL,
  quote_usd_rate numeric NOT NULL,
  notional_usd numeric NOT NULL,
  fee_usd numeric NOT NULL,
  price_impact_bps numeric NOT NULL,
  realized_pnl_usd numeric,
  market_state_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX paper_fills_user_idx ON public.paper_fills (user_id, created_at DESC);
GRANT SELECT ON public.paper_fills TO authenticated;
GRANT ALL ON public.paper_fills TO service_role;
ALTER TABLE public.paper_fills ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own fills" ON public.paper_fills FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.paper_ledger (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  order_id uuid,
  kind text NOT NULL,
  cash_delta_usd numeric NOT NULL DEFAULT 0,
  mint text,
  qty_delta numeric NOT NULL DEFAULT 0,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX paper_ledger_user_idx ON public.paper_ledger (user_id, created_at DESC);
GRANT SELECT ON public.paper_ledger TO authenticated;
GRANT ALL ON public.paper_ledger TO service_role;
ALTER TABLE public.paper_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own ledger" ON public.paper_ledger FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.watchlist (
  user_id uuid NOT NULL,
  market_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, market_id)
);
GRANT SELECT, INSERT, DELETE ON public.watchlist TO authenticated;
GRANT ALL ON public.watchlist TO service_role;
ALTER TABLE public.watchlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own watchlist read" ON public.watchlist FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own watchlist add" ON public.watchlist FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own watchlist remove" ON public.watchlist FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.user_settings (
  user_id uuid PRIMARY KEY,
  buy_presets_usd numeric[] NOT NULL DEFAULT ARRAY[25,50,100,250]::numeric[],
  default_slippage_bps int NOT NULL DEFAULT 500 CHECK (default_slippage_bps BETWEEN 1 AND 5000),
  prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.user_settings TO authenticated;
GRANT ALL ON public.user_settings TO service_role;
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own settings read" ON public.user_settings FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own settings insert" ON public.user_settings FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own settings update" ON public.user_settings FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ===== Account bootstrap =====
CREATE OR REPLACE FUNCTION public.ensure_paper_account(_uid uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_start numeric;
BEGIN
  SELECT starting_balance_usd INTO v_start FROM app_config WHERE id = 1;
  INSERT INTO paper_accounts (user_id, cash_usd, starting_balance_usd)
  VALUES (_uid, v_start, v_start) ON CONFLICT (user_id) DO NOTHING;
  IF FOUND THEN
    INSERT INTO paper_ledger (user_id, kind, cash_delta_usd, note) VALUES (_uid, 'open', v_start, 'Paper account opened');
  END IF;
  INSERT INTO user_settings (user_id) VALUES (_uid) ON CONFLICT (user_id) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION public.ensure_paper_account(uuid) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.handle_new_user_paper()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.ensure_paper_account(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER on_auth_user_created_paper AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_paper();

CREATE OR REPLACE FUNCTION public.my_paper_account()
RETURNS SETOF public.paper_accounts LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not signed in'; END IF;
  PERFORM ensure_paper_account(auth.uid());
  RETURN QUERY SELECT * FROM paper_accounts WHERE user_id = auth.uid();
END $$;
REVOKE ALL ON FUNCTION public.my_paper_account() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.my_paper_account() TO authenticated;

-- ===== Market order execution (atomic) =====
CREATE OR REPLACE FUNCTION public.place_market_order(
  p_market_id text, p_side text, p_amount numeric, p_slippage_bps int,
  p_expected_price_usd numeric, p_idempotency_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_existing paper_orders%ROWTYPE;
  v_acct paper_accounts%ROWTYPE;
  v_mkt markets%ROWTYPE;
  v_pos paper_positions%ROWTYPE;
  v_cfg app_config%ROWTYPE;
  v_sol numeric; v_sol_at timestamptz;
  v_order_id uuid;
  v_reason text;
  v_fee numeric; v_in numeric; v_out numeric; v_k numeric;
  v_qty numeric; v_gross numeric; v_net numeric;
  v_exec numeric; v_spot numeric; v_impact numeric;
  v_avg numeric; v_realized numeric := null;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not signed in'; END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 8 OR length(p_idempotency_key) > 100 THEN
    RAISE EXCEPTION 'invalid idempotency key';
  END IF;
  IF p_side NOT IN ('buy','sell') THEN RAISE EXCEPTION 'invalid side'; END IF;
  IF p_slippage_bps IS NULL OR p_slippage_bps < 1 OR p_slippage_bps > 5000 THEN RAISE EXCEPTION 'slippage must be 0.01%%–50%%'; END IF;

  PERFORM ensure_paper_account(v_uid);
  -- Serialise all of this user's financial actions.
  SELECT * INTO v_acct FROM paper_accounts WHERE user_id = v_uid FOR UPDATE;

  SELECT * INTO v_existing FROM paper_orders WHERE user_id = v_uid AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object('order_id', v_existing.id, 'status', v_existing.status, 'reason', v_existing.reject_reason, 'duplicate', true);
  END IF;

  SELECT * INTO v_cfg FROM app_config WHERE id = 1;
  SELECT * INTO v_mkt FROM markets WHERE id = p_market_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown market'; END IF;

  SELECT price, updated_at INTO v_sol, v_sol_at FROM reference_prices WHERE pair = v_mkt.quote_ccy || '/USD';

  -- Validation → readable rejection
  IF p_amount IS NULL OR p_amount <= 0 THEN v_reason := 'Order size must be greater than zero.';
  ELSIF v_mkt.status <> 'active' THEN v_reason := 'This market has migrated or is retired. Open the destination market.';
  ELSIF v_mkt.trade_feed <> 'live' THEN v_reason := 'Live swaps unavailable for this market, so paper execution is disabled.';
  ELSIF v_mkt.reserve_quote IS NULL OR v_mkt.reserve_base IS NULL OR v_mkt.reserve_quote <= 0 OR v_mkt.reserve_base <= 0 THEN v_reason := 'Pool state unavailable; cannot quote.';
  ELSIF v_mkt.state_updated_at IS NULL OR v_mkt.state_updated_at < now() - make_interval(secs => v_cfg.quote_stale_seconds) THEN v_reason := 'Quote is stale: no fresh market state in the last ' || v_cfg.quote_stale_seconds || 's.';
  ELSIF v_sol IS NULL OR v_sol_at < now() - interval '5 minutes' THEN v_reason := v_mkt.quote_ccy || '/USD reference price is unavailable or stale.';
  ELSIF p_expected_price_usd IS NULL OR p_expected_price_usd <= 0 THEN v_reason := 'Missing quote preview price.';
  END IF;

  IF v_reason IS NULL THEN
    v_k := v_mkt.reserve_quote * v_mkt.reserve_base;
    v_spot := (v_mkt.reserve_quote / v_mkt.reserve_base) * v_sol;
    IF p_side = 'buy' THEN
      IF p_amount > v_acct.cash_usd - v_acct.reserved_cash_usd THEN
        v_reason := 'Insufficient virtual cash.';
      ELSE
        v_fee := round(p_amount * v_cfg.fee_bps / 10000.0, 10);
        v_in := (p_amount - v_fee) / v_sol;
        v_qty := v_mkt.reserve_base - v_k / (v_mkt.reserve_quote + v_in);
        IF v_qty <= 0 THEN v_reason := 'Order too small to receive tokens.';
        ELSE
          v_exec := (p_amount - v_fee) / v_qty;
          IF v_exec > p_expected_price_usd * (1 + p_slippage_bps / 10000.0) THEN
            v_reason := 'Price moved beyond your slippage limit.';
          END IF;
        END IF;
      END IF;
    ELSE
      SELECT * INTO v_pos FROM paper_positions WHERE user_id = v_uid AND chain = v_mkt.chain AND mint = v_mkt.mint FOR UPDATE;
      IF NOT FOUND OR p_amount > v_pos.qty - v_pos.reserved_qty THEN
        v_reason := 'Insufficient token holdings.';
      ELSE
        v_out := v_mkt.reserve_quote - v_k / (v_mkt.reserve_base + p_amount);
        v_gross := v_out * v_sol;
        v_fee := round(v_gross * v_cfg.fee_bps / 10000.0, 10);
        v_net := v_gross - v_fee;
        v_exec := v_gross / p_amount;
        v_qty := p_amount;
        IF v_exec < p_expected_price_usd * (1 - p_slippage_bps / 10000.0) THEN
          v_reason := 'Price moved beyond your slippage limit.';
        END IF;
      END IF;
    END IF;
  END IF;

  INSERT INTO paper_orders (user_id, market_id, chain, mint, symbol, side, order_type, status, amount,
    expected_price_usd, slippage_bps, reject_reason, idempotency_key)
  VALUES (v_uid, v_mkt.id, v_mkt.chain, v_mkt.mint, v_mkt.symbol, p_side, 'market',
    CASE WHEN v_reason IS NULL THEN 'filled' ELSE 'rejected' END, p_amount,
    p_expected_price_usd, p_slippage_bps, v_reason, p_idempotency_key)
  RETURNING id INTO v_order_id;

  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('order_id', v_order_id, 'status', 'rejected', 'reason', v_reason);
  END IF;

  v_impact := (v_exec / v_spot - 1) * 10000;

  IF p_side = 'buy' THEN
    UPDATE paper_accounts SET cash_usd = cash_usd - p_amount WHERE user_id = v_uid;
    INSERT INTO paper_positions (user_id, chain, mint, symbol, qty, cost_basis_usd, fees_usd, last_market_id)
    VALUES (v_uid, v_mkt.chain, v_mkt.mint, v_mkt.symbol, v_qty, p_amount - v_fee, v_fee, v_mkt.id)
    ON CONFLICT (user_id, chain, mint) DO UPDATE SET
      qty = paper_positions.qty + EXCLUDED.qty,
      cost_basis_usd = paper_positions.cost_basis_usd + EXCLUDED.cost_basis_usd,
      fees_usd = paper_positions.fees_usd + EXCLUDED.fees_usd,
      last_market_id = EXCLUDED.last_market_id, updated_at = now();
    INSERT INTO paper_ledger (user_id, order_id, kind, cash_delta_usd, mint, qty_delta, note) VALUES
      (v_uid, v_order_id, 'trade', -(p_amount - v_fee), v_mkt.mint, v_qty, 'Paper buy'),
      (v_uid, v_order_id, 'fee', -v_fee, v_mkt.mint, 0, 'Simulated fee');
    INSERT INTO paper_fills (order_id, user_id, market_id, mint, symbol, side, qty, price_usd, price_quote, quote_ccy,
      quote_usd_rate, notional_usd, fee_usd, price_impact_bps, market_state_at)
    VALUES (v_order_id, v_uid, v_mkt.id, v_mkt.mint, v_mkt.symbol, 'buy', v_qty, v_exec, v_exec / v_sol, v_mkt.quote_ccy,
      v_sol, p_amount - v_fee, v_fee, v_impact, v_mkt.state_updated_at);
  ELSE
    v_avg := CASE WHEN v_pos.qty > 0 THEN v_pos.cost_basis_usd / v_pos.qty ELSE 0 END;
    v_realized := v_net - v_avg * v_qty;
    UPDATE paper_accounts SET cash_usd = cash_usd + v_net WHERE user_id = v_uid;
    UPDATE paper_positions SET
      qty = qty - v_qty,
      cost_basis_usd = CASE WHEN qty - v_qty <= 0 THEN 0 ELSE cost_basis_usd - v_avg * v_qty END,
      realized_pnl_usd = realized_pnl_usd + v_realized,
      fees_usd = fees_usd + v_fee, last_market_id = v_mkt.id, updated_at = now()
    WHERE user_id = v_uid AND chain = v_mkt.chain AND mint = v_mkt.mint;
    INSERT INTO paper_ledger (user_id, order_id, kind, cash_delta_usd, mint, qty_delta, note) VALUES
      (v_uid, v_order_id, 'trade', v_gross, v_mkt.mint, -v_qty, 'Paper sell'),
      (v_uid, v_order_id, 'fee', -v_fee, v_mkt.mint, 0, 'Simulated fee');
    INSERT INTO paper_fills (order_id, user_id, market_id, mint, symbol, side, qty, price_usd, price_quote, quote_ccy,
      quote_usd_rate, notional_usd, fee_usd, price_impact_bps, realized_pnl_usd, market_state_at)
    VALUES (v_order_id, v_uid, v_mkt.id, v_mkt.mint, v_mkt.symbol, 'sell', v_qty, v_exec, v_exec / v_sol, v_mkt.quote_ccy,
      v_sol, v_gross, v_fee, v_impact, v_realized, v_mkt.state_updated_at);
  END IF;

  RETURN jsonb_build_object('order_id', v_order_id, 'status', 'filled', 'qty', v_qty, 'price_usd', v_exec,
    'fee_usd', v_fee, 'price_impact_bps', v_impact, 'realized_pnl_usd', v_realized);
END $$;
REVOKE ALL ON FUNCTION public.place_market_order(text,text,numeric,int,numeric,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.place_market_order(text,text,numeric,int,numeric,text) TO authenticated;

-- ===== Reset =====
CREATE OR REPLACE FUNCTION public.reset_paper_account()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_start numeric; v_acct paper_accounts%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not signed in'; END IF;
  PERFORM ensure_paper_account(v_uid);
  SELECT * INTO v_acct FROM paper_accounts WHERE user_id = v_uid FOR UPDATE;
  SELECT starting_balance_usd INTO v_start FROM app_config WHERE id = 1;
  UPDATE paper_orders SET status = 'cancelled', reject_reason = 'Cancelled by account reset', updated_at = now()
    WHERE user_id = v_uid AND status IN ('open','pending');
  DELETE FROM paper_positions WHERE user_id = v_uid;
  UPDATE paper_accounts SET cash_usd = v_start, reserved_cash_usd = 0, starting_balance_usd = v_start, reset_at = now()
    WHERE user_id = v_uid;
  INSERT INTO paper_ledger (user_id, kind, cash_delta_usd, note)
    VALUES (v_uid, 'reset', v_start - v_acct.cash_usd, 'Account reset to starting balance');
  RETURN jsonb_build_object('cash_usd', v_start);
END $$;
REVOKE ALL ON FUNCTION public.reset_paper_account() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reset_paper_account() TO authenticated;
