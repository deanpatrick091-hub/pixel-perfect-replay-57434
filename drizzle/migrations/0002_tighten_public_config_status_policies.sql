DROP POLICY IF EXISTS "config readable" ON public.app_config;
CREATE POLICY "config singleton readable" ON public.app_config FOR SELECT TO anon, authenticated USING (id = 1);

DROP POLICY IF EXISTS "worker status readable" ON public.worker_status;
CREATE POLICY "recent worker status readable" ON public.worker_status FOR SELECT TO anon, authenticated
  USING (last_heartbeat_at > now() - interval '1 day');