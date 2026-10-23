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

-- New submissions only; existing signed orders retain their original artwork.
create or replace function public.submit_order_request(p_id uuid, p_token_hash text, p_row jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  r public.order_requests;
  o public.label_orders;
  receipt text;
begin
  select * into r from public.order_requests where id = p_id and token_hash = p_token_hash for update;
  if not found or r.revoked_at is not null or r.request_state <> 'ready' then raise exception 'Invalid link'; end if;
  select * into o from public.label_orders where order_request_id = r.id;
  if found then
    return jsonb_build_object('submitted_at', o.submitted_at, 'order_ref', o.order_ref, 'already_submitted', true, 'mode', r.mode);
  end if;
  if r.shadow_receipt is not null then return r.shadow_receipt || jsonb_build_object('already_submitted', true); end if;
  if r.expires_at < now() then raise exception 'Expired link'; end if;
  -- Artwork rules use the invitation's code type, never a client override.
  if r.barcode_type = 'linear' and coalesce(p_row->>'logo_choice','') not in ('custom_text','serial_only') then
    raise exception 'Linear labels allow custom text or serial number only; logos are not supported';
  end if;
  if r.barcode_type = 'qr' and coalesce(p_row->>'logo_choice','') not in ('custom_text','custom_logo','toolhound_logo','serial_only') then
    raise exception 'QR labels require a logo, custom text, or serial number only';
  end if;
  if p_row->>'logo_choice' = 'custom_text' then
    if jsonb_typeof(p_row->'text_lines') is distinct from 'array' then raise exception 'Enter label text'; end if;
    if jsonb_array_length(p_row->'text_lines') not between 1 and (case when r.barcode_type='linear' then 1 else 3 end)
      or exists(select 1 from jsonb_array_elements(p_row->'text_lines') v
        where jsonb_typeof(v) <> 'string' or length(btrim(v#>>'{}')) = 0
        or length(v#>>'{}') > (case when r.barcode_type='linear' then 18 else 10 end)) then
      raise exception 'Linear text allows one line of 18 characters; QR text allows three lines of 10 characters';
    end if;
    if nullif(p_row->>'logo_file_name','') is not null or nullif(p_row->>'logo_file_data','') is not null or nullif(p_row->>'logo_storage_path','') is not null then
      raise exception 'Text labels cannot include logo artwork';
    end if;
  end if;
  -- Existing submissions return above; retries keep the originally issued reference.
  receipt := nextval('public.label_order_number_seq'::regclass)::text;
  if r.mode = 'shadow' then receipt := 'TEST-' || receipt; end if;
  if p_row->>'customer_po' is not null and length(btrim(p_row->>'customer_po')) > 64 then
    raise exception 'Customer PO number must be 64 characters or fewer';
  end if;
  -- Ignore client-supplied IDs, status, quote, internal fields and symbology.
  o := jsonb_populate_record(null::public.label_orders, p_row);
  if r.mode = 'live' then
    insert into public.label_orders (
      order_request_id, order_ref, barcode_type, company_name, contact_name, contact_email,
      address, city, state_province, postal_code, country,
      logo_choice, logo_file_name, logo_file_data, logo_storage_path, text_lines, full_color,
      quantity, seq_start, label_type, label_width_in, label_height_in,
      ship_to_phone, attention_name, customer_po, instructions, authorized_name, approval_date, signature_data
    ) values (
      r.id, receipt, r.barcode_type, o.company_name, o.contact_name, o.contact_email,
      o.address, o.city, o.state_province, o.postal_code, o.country,
      o.logo_choice, o.logo_file_name, o.logo_file_data, o.logo_storage_path, o.text_lines, o.full_color,
      o.quantity, o.seq_start, o.label_type, o.label_width_in, o.label_height_in,
      o.ship_to_phone, o.attention_name, nullif(btrim(o.customer_po), ''), o.instructions, o.authorized_name, o.approval_date, o.signature_data
    );
  end if;
  update public.order_requests set
    shadow_receipt = case when r.mode = 'shadow' then jsonb_build_object('submitted_at', now(), 'order_ref', receipt, 'mode', r.mode) else null end
  where id = r.id;
  return jsonb_build_object('submitted_at', now(), 'order_ref', receipt, 'mode', r.mode);
end;
$$;
revoke all on function public.submit_order_request(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.submit_order_request(uuid,text,jsonb) to service_role;
