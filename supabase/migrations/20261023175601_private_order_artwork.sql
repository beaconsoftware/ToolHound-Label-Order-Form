-- Private original artwork; no public or browser write access.
alter table public.label_orders add column logo_storage_path text;
alter table public.label_orders add constraint label_orders_storage_path_valid check (
  logo_storage_path is null or (
    order_request_id is not null and logo_choice = 'custom_logo' and logo_file_data is null
    and logo_storage_path ~ ('^' || order_request_id::text || '/[0-9a-f]{64}\.(png|jpg|svg|pdf)$')
  )
);
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('order-artwork','order-artwork',false,4194304,array['image/png','image/jpeg','image/svg+xml','application/pdf']);
create policy order_artwork_staff_read on storage.objects for select to authenticated using (
  bucket_id = 'order-artwork' and public.is_label_order_staff()
  and exists (select 1 from public.label_orders o where o.logo_storage_path = name)
);
-- No INSERT/UPDATE/DELETE policies: uploads go through the authenticated
-- customer-link handler using its server-only service role.

-- Preserve whichever submission validation is deployed; extend only the
-- explicit INSERT column/value lists. Abort if the expected shape has changed.
do $$
declare
  definition text := pg_get_functiondef('public.submit_order_request(uuid,text,jsonb)'::regprocedure);
  amended text;
begin
  if strpos(definition, 'logo_file_name, logo_file_data, text_lines') = 0
    or strpos(definition, 'o.logo_file_name, o.logo_file_data, o.text_lines') = 0 then
    raise exception 'Unexpected submit_order_request definition; review before applying storage migration';
  end if;
  amended := replace(definition, 'logo_file_name, logo_file_data, text_lines',
    'logo_file_name, logo_file_data, logo_storage_path, text_lines');
  amended := replace(amended, 'o.logo_file_name, o.logo_file_data, o.text_lines',
    'o.logo_file_name, o.logo_file_data, o.logo_storage_path, o.text_lines');
  execute amended;
end;
$$;
