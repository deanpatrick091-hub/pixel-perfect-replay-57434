CREATE OR REPLACE FUNCTION public.paper_orders_amount_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.amount := COALESCE(NEW.amount, 0);
  RETURN NEW;
END $$;
CREATE TRIGGER paper_orders_amount_guard BEFORE INSERT ON public.paper_orders
FOR EACH ROW EXECUTE FUNCTION public.paper_orders_amount_guard();