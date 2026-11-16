CREATE OR REPLACE FUNCTION public.worker_service_status()
RETURNS TABLE(id text, public_url text, status text, last_heartbeat_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT w.id::text, w.public_url::text, w.status::text, w.last_heartbeat_at
  FROM public.worker_status w ORDER BY w.last_heartbeat_at DESC NULLS LAST LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.worker_service_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.worker_service_status() TO anon, authenticated, service_role;