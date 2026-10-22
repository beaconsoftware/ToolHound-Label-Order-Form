-- Optional staff-only reference; it is not a customer authorization.
alter table public.order_requests
 add column previous_order_name text,
 add column previous_order_data text,
 add constraint previous_order_pdf_pair check (
  (previous_order_name is null and previous_order_data is null) or
  (previous_order_name is not null and previous_order_data is not null
   and length(previous_order_name) between 1 and 200
   and length(previous_order_data) between 8 and 14000000));

create or replace function public.create_order_request(p_request jsonb,p_quote jsonb,p_provider text default null)
returns uuid language plpgsql security invoker set search_path='' as $$
declare r public.order_requests; provider text;
begin
 r:=jsonb_populate_record(null::public.order_requests,p_request);
 provider:=case when r.mode='live' then p_provider end;
 insert into public.order_requests(id,created_by,mode,company_name,contact_name,contact_email,crm_url,barcode_type,token_hash,app_origin,previous_order_name,previous_order_data,
 quote_name,quote_sha256,quote_data,external_provider,external_id,external_sync)
 values(r.id,r.created_by,r.mode,r.company_name,r.contact_name,r.contact_email,r.crm_url,r.barcode_type,r.token_hash,r.app_origin,r.previous_order_name,r.previous_order_data,
 p_quote->>'name',p_quote->>'sha256',p_quote->>'data_base64',provider,
 case when provider is not null then gen_random_uuid()::text end,
 case when provider is not null then jsonb_build_object('request.created',jsonb_build_object(
   'provider',provider,'status','pending','attempts',0,'available_at',now(),'created_at',now())) else '{}'::jsonb end)
 on conflict(id) do nothing;
 return r.id;
end; $$;
