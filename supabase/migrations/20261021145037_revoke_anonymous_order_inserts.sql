-- Disable the legacy direct submission path. Older forms will fail.
-- Applied with explicit approval to disable the old deployed form.
revoke insert on table public.label_orders from anon;
drop policy if exists "anon can submit orders" on public.label_orders;

-- service_role keeps its existing INSERT grant for submit_order_request.
