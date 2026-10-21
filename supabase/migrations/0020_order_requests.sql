-- Invitations are distinct from signed orders: an unsigned request must never
-- appear in the manufacturing queue. All writes go through the edge function.
create table public.order_requests (
  id uuid primary key,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  mode text not null check (mode in ('shadow', 'live')),
  company_name text not null check (length(company_name) between 1 and 200),
  contact_name text not null check (length(contact_name) between 1 and 200),
  contact_email text not null check (contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  salesforce_url text,
  barcode_type text not null check (barcode_type in ('linear', 'qr')),
  quote_version integer not null default 1,
  quote_name text not null,
  quote_sha256 text not null,
  quote_data text not null, -- private PDF; never returned in the customer projection
  linear_asset_url text,
  linear_issue_id uuid not null default gen_random_uuid() unique,
  linear_identifier text,
  linear_url text,
  ticket_state text not null default 'pending' check (ticket_state in ('pending','creating','ready')),
  token_hash text not null unique,
  revoked_at timestamptz,
  expires_at timestamptz not null default now() + interval '90 days',
  sent_at timestamptz,
  sent_recorded_at timestamptz,
  sent_by uuid references auth.users(id),
  sent_recipient text,
  shadow_receipt jsonb, -- test receipt only, never a copy of the submitted form
  token_version integer not null default 1 check (token_version > 0),
  regenerated_at timestamptz,
  linear_sync_pending boolean not null default false,
  linear_synced_at timestamptz,
  check (length(quote_data) between 8 and 14000000)
);
alter table public.order_requests enable row level security;
revoke all on public.order_requests from anon, authenticated;
grant all on public.order_requests to service_role;

alter table public.label_orders add column order_request_id uuid unique references public.order_requests(id);
grant select, insert on public.label_orders to service_role;
create index order_requests_created_at_idx on public.order_requests(created_at desc);

-- Row lock makes retries and concurrent submissions return the original
-- receipt. The mapping and signed order commit together or neither commits.
create function public.submit_order_request(p_id uuid, p_token_hash text, p_row jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  r public.order_requests;
  o public.label_orders;
  receipt text;
begin
  select * into r from public.order_requests where id = p_id and token_hash = p_token_hash for update;
  if not found or r.revoked_at is not null or r.ticket_state <> 'ready' then raise exception 'Invalid link'; end if;
  select * into o from public.label_orders where order_request_id = r.id;
  if found then
    return jsonb_build_object('submitted_at', o.submitted_at, 'order_ref', o.order_ref, 'already_submitted', true, 'mode', r.mode);
  end if;
  if r.shadow_receipt is not null then return r.shadow_receipt || jsonb_build_object('already_submitted', true); end if;
  if r.expires_at < now() then raise exception 'Expired link'; end if;
  receipt := 'THL-' || upper(replace(r.id::text, '-', ''));
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
    shadow_receipt = case when r.mode = 'shadow' then jsonb_build_object('submitted_at', now(), 'order_ref', receipt, 'mode', r.mode) else null end,
    linear_sync_pending = (r.mode = 'live')
  where id = r.id;
  return jsonb_build_object('submitted_at', now(), 'order_ref', receipt, 'mode', r.mode);
end;
$$;
revoke all on function public.submit_order_request(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.submit_order_request(uuid,text,jsonb) to service_role;

-- Serialize regeneration with submission. Expected version makes retried rotation idempotent.
create function public.regenerate_order_request(p_id uuid, p_version integer, p_token_hash text)
returns void language plpgsql security invoker set search_path = '' as $$
declare r public.order_requests;
begin
  select * into r from public.order_requests where id = p_id for update;
  if not found or r.revoked_at is not null or r.ticket_state <> 'ready' then raise exception 'Invalid request'; end if;
  if r.shadow_receipt is not null or exists(select 1 from public.label_orders where order_request_id = p_id) then raise exception 'Already submitted'; end if;
  if r.token_version = p_version + 1 and r.token_hash = p_token_hash then return; end if;
  if r.token_version <> p_version then raise exception 'Link changed. Refresh the request history.'; end if;
  if r.expires_at > now() then raise exception 'Link is still active. Resend the existing link.'; end if;
  update public.order_requests set token_version = p_version + 1, token_hash = p_token_hash,
    expires_at = now() + interval '90 days', regenerated_at = now() where id = p_id;
end;
$$;
revoke all on function public.regenerate_order_request(uuid,integer,text) from public, anon, authenticated;
grant execute on function public.regenerate_order_request(uuid,integer,text) to service_role;

-- Revocation must acquire the same lock as submission and regeneration.
create function public.revoke_order_request(p_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare r public.order_requests;
begin
  select * into r from public.order_requests where id = p_id for update;
  if not found then raise exception 'Invalid request'; end if;
  if r.shadow_receipt is not null or exists(select 1 from public.label_orders where order_request_id = p_id) then raise exception 'Already submitted'; end if;
  update public.order_requests set revoked_at = now() where id = p_id;
end;
$$;
revoke all on function public.revoke_order_request(uuid) from public, anon, authenticated;
grant execute on function public.revoke_order_request(uuid) to service_role;

-- Preserve the immutable receipt: linked authorizations can be cancelled, not deleted.
create function public.protect_requested_order() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if old.order_request_id is not null then raise exception 'Cancel this linked order instead of deleting its authorization.'; end if;
  return old;
end;
$$;
create trigger protect_requested_order before delete on public.label_orders
for each row execute function public.protect_requested_order();

-- Public legacy inserts must not claim an invitation without validating its token.
alter policy "anon can submit orders" on public.label_orders with check (order_request_id is null);
