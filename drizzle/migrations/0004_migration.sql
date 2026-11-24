DROP POLICY IF EXISTS "markets readable" ON public.markets;
CREATE POLICY "solana markets readable" ON public.markets FOR SELECT TO anon, authenticated USING (chain = 'solana');
DROP POLICY IF EXISTS "ref prices readable" ON public.reference_prices;
CREATE POLICY "sol usd reference readable" ON public.reference_prices FOR SELECT TO anon, authenticated USING (pair = 'SOL/USD');