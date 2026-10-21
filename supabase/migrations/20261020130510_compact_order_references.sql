-- Restore the original readable format for new submissions only.
create or replace function public.submit_order_request(p_id uuid, p_token_hash text, p_row jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  r public.order_requests;
  o public.label_orders;
  receipt text;
  stamp bigint;
  stamp_text text := '';
  entropy bytea;
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  i integer;
begin
  select * into r from public.order_requests where id = p_id and token_hash = p_token_hash for update;
  if not found or r.revoked_at is not null or r.request_state <> 'ready' then raise exception 'Invalid link'; end if;
  select * into o from public.label_orders where order_request_id = r.id;
  if found then
    return jsonb_build_object('submitted_at', o.submitted_at, 'order_ref', o.order_ref, 'already_submitted', true, 'mode', r.mode);
  end if;
  if r.shadow_receipt is not null then return r.shadow_receipt || jsonb_build_object('already_submitted', true); end if;
  if r.expires_at < now() then raise exception 'Expired link'; end if;
  -- Existing submissions return above; retries keep the originally issued reference.
  stamp := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  while stamp > 0 loop
    stamp_text := substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', (stamp % 36)::int + 1, 1) || stamp_text;
    stamp := stamp / 36;
  end loop;
  entropy := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  receipt := 'THL-' || stamp_text || '-';
  for i in 0..5 loop
    receipt := receipt || substr(alphabet, get_byte(entropy, i) % length(alphabet) + 1, 1);
  end loop;
  -- Ignore client-supplied IDs, status, quote, internal fields and symbology.
  o := jsonb_populate_record(null::public.label_orders, p_row);
  if r.mode = 'live' then
    insert into public.label_orders (
      order_request_id, order_ref, barcode_type, company_name, contact_name, contact_email,
      address, city, state_province, postal_code, country,
      logo_choice, logo_file_name, logo_file_data, text_lines, full_color,
      quantity, seq_start, label_type, label_width_in, label_height_in,
      ship_to_phone, attention_name, instructions, authorized_name, approval_date, signature_data
    ) values (
      r.id, receipt, r.barcode_type, o.company_name, o.contact_name, o.contact_email,
      o.address, o.city, o.state_province, o.postal_code, o.country,
      o.logo_choice, o.logo_file_name, o.logo_file_data, o.text_lines, o.full_color,
      o.quantity, o.seq_start, o.label_type, o.label_width_in, o.label_height_in,
      o.ship_to_phone, o.attention_name, o.instructions, o.authorized_name, o.approval_date, o.signature_data
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
