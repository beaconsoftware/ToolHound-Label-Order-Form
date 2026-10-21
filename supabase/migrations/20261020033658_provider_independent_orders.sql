-- Our request UUID is the system-of-record identity. Integrations are optional.
create table public.order_documents (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null references public.order_requests(id),
 kind text not null check (kind in ('quote','signed_order','attachment')),
 version integer not null check (version > 0),
 name text not null,
 sha256 text not null,
 content_type text not null default 'application/pdf',
 data_base64 text not null check (length(data_base64) between 8 and 14000000),
 created_at timestamptz not null default now(),
 unique(request_id,kind,version)
);
create table public.order_integration_providers (
 provider text primary key,
 enabled boolean not null default false
);
insert into public.order_integration_providers values ('linear',true);
create table public.external_records (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null references public.order_requests(id),
 provider text not null references public.order_integration_providers(provider),
 external_id text not null default gen_random_uuid()::text,
 identifier text,
 url text,
 metadata jsonb not null default '{}',
 created_at timestamptz not null default now(),
 unique(request_id,provider), unique(provider,external_id)
);
create table public.integration_jobs (
 id uuid primary key default gen_random_uuid(),
 external_record_id uuid not null references public.external_records(id),
 event text not null check(event in ('request.created','order.submitted')),
 status text not null default 'pending' check(status in ('pending','processing','succeeded')),
 attempts integer not null default 0,
 available_at timestamptz not null default now(),
 lease_until timestamptz,
 claim_token uuid,
 last_error text,
 completed_at timestamptz,
 created_at timestamptz not null default now(),
 unique(external_record_id,event)
);
create index integration_jobs_pending_idx on public.integration_jobs(available_at) where status <> 'succeeded';
create index external_records_provider_idx on public.external_records(provider);

alter table public.order_documents enable row level security;
alter table public.order_integration_providers enable row level security;
alter table public.external_records enable row level security;
alter table public.integration_jobs enable row level security;
revoke all on public.order_documents,public.order_integration_providers,public.external_records,public.integration_jobs from public,anon,authenticated;
grant all on public.order_documents,public.order_integration_providers,public.external_records,public.integration_jobs to service_role;

insert into public.order_documents(request_id,kind,version,name,sha256,data_base64,created_at)
 select id,'quote',quote_version,quote_name,quote_sha256,quote_data,created_at from public.order_requests;
insert into public.external_records(request_id,provider,external_id,identifier,url,metadata,created_at)
 select id,'linear',linear_issue_id::text,linear_identifier,linear_url,
 jsonb_strip_nulls(jsonb_build_object('quote_asset_url',linear_asset_url)),created_at
 from public.order_requests where mode='live';
insert into public.integration_jobs(external_record_id,event,status,completed_at)
 select e.id,'request.created',case when r.ticket_state='ready' then 'succeeded' else 'pending' end,
 case when r.ticket_state='ready' then r.created_at end
 from public.external_records e join public.order_requests r on r.id=e.request_id;
insert into public.integration_jobs(external_record_id,event,status,completed_at)
 select e.id,'order.submitted',case when r.linear_sync_pending then 'pending' else 'succeeded' end,r.linear_synced_at
 from public.external_records e join public.order_requests r on r.id=e.request_id
 join public.label_orders o on o.order_request_id=r.id;

-- Rename domain state and remove provider-specific fields only after copying them.
alter table public.order_requests rename column salesforce_url to crm_url;
alter table public.order_requests rename column ticket_state to request_state;
alter table public.order_requests drop constraint order_requests_ticket_state_check;
update public.order_requests set request_state='ready';
alter table public.order_requests alter column request_state set default 'ready';
alter table public.order_requests add check(request_state in ('draft','ready'));
alter table public.order_requests
 drop column linear_issue_id, drop column linear_identifier, drop column linear_url,
 drop column linear_asset_url, drop column linear_sync_pending, drop column linear_synced_at,
 drop column quote_name, drop column quote_sha256, drop column quote_data;

-- One transaction saves the request, its private quote and durable integration jobs.
create function public.create_order_request(p_request jsonb, p_quote jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare r public.order_requests; inserted uuid;
begin
 r := jsonb_populate_record(null::public.order_requests,p_request);
 insert into public.order_requests(id,created_by,mode,company_name,contact_name,contact_email,crm_url,barcode_type,token_hash)
 values(r.id,r.created_by,r.mode,r.company_name,r.contact_name,r.contact_email,r.crm_url,r.barcode_type,r.token_hash)
 on conflict(id) do nothing returning id into inserted;
 if inserted is null then return r.id; end if;
 insert into public.order_documents(request_id,kind,version,name,sha256,data_base64)
 values(r.id,'quote',1,p_quote->>'name',p_quote->>'sha256',p_quote->>'data_base64');
 if r.mode='live' then
  insert into public.external_records(request_id,provider)
   select r.id,provider from public.order_integration_providers where enabled;
  insert into public.integration_jobs(external_record_id,event)
   select id,'request.created' from public.external_records where request_id=r.id;
 end if;
 return r.id;
end; $$;

-- A successful authorization and its outgoing update are inseparable.
create function public.queue_order_submission() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.order_request_id is null then return new; end if;
 insert into public.integration_jobs(external_record_id,event)
 select id,'order.submitted' from public.external_records where request_id=new.order_request_id
 on conflict(external_record_id,event) do nothing;
 return new;
end; $$;
create trigger queue_order_submission after insert on public.label_orders
 for each row execute function public.queue_order_submission();

-- Workers acquire a bounded lease; completion requires the same fencing token.
-- Submission cannot run until external creation has been confirmed.
create function public.claim_order_integration_job(p_request_id uuid)
returns setof public.integration_jobs language plpgsql security invoker set search_path='' as $$
declare picked uuid;
begin
 select j.id into picked from public.integration_jobs j
 join public.external_records e on e.id=j.external_record_id
 join public.order_integration_providers p on p.provider=e.provider and p.enabled
 where e.request_id=p_request_id and j.status<>'succeeded'
 and j.available_at<=now() and (j.lease_until is null or j.lease_until<now())
 and (j.event='request.created' or exists(select 1 from public.integration_jobs c
   where c.external_record_id=e.id and c.event='request.created' and c.status='succeeded'))
 order by j.created_at,j.id for update of j skip locked limit 1;
 if picked is null then return; end if;
 return query update public.integration_jobs set status='processing', attempts=attempts+1,
  lease_until=now()+interval '5 minutes',claim_token=gen_random_uuid()
  where id=picked returning *;
end; $$;
create function public.finish_order_integration_job(p_id uuid,p_claim_token uuid,p_error text default null)
returns void language plpgsql security invoker set search_path='' as $$
begin
 update public.integration_jobs set status=case when p_error is null then 'succeeded' else 'pending' end,
 last_error=left(p_error,1000),completed_at=case when p_error is null then now() end,
 available_at=case when p_error is null then now() else now()+interval '1 minute'*least(attempts,60) end,
 lease_until=null,claim_token=null
 where id=p_id and claim_token=p_claim_token;
end; $$;
create function public.retry_order_integrations(p_request_id uuid)
returns void language sql security invoker set search_path='' as $$
 update public.integration_jobs set available_at=now()
 where external_record_id in (select id from public.external_records where request_id=p_request_id)
 and status<>'succeeded' and (lease_until is null or lease_until<now());
$$;

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
    shadow_receipt = case when r.mode = 'shadow' then jsonb_build_object('submitted_at', now(), 'order_ref', receipt, 'mode', r.mode) else null end
  where id = r.id;
  return jsonb_build_object('submitted_at', now(), 'order_ref', receipt, 'mode', r.mode);
end;
$$;
revoke all on function public.submit_order_request(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.submit_order_request(uuid,text,jsonb) to service_role;

-- Serialize regeneration with submission. Expected version makes retried rotation idempotent.
create or replace function public.regenerate_order_request(p_id uuid, p_version integer, p_token_hash text)
returns void language plpgsql security invoker set search_path = '' as $$
declare r public.order_requests;
begin
  select * into r from public.order_requests where id = p_id for update;
  if not found or r.revoked_at is not null or r.request_state <> 'ready' then raise exception 'Invalid request'; end if;
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


revoke all on function public.create_order_request(jsonb,jsonb),public.queue_order_submission(),public.claim_order_integration_job(uuid),public.finish_order_integration_job(uuid,uuid,text),public.retry_order_integrations(uuid) from public,anon,authenticated;
grant execute on function public.create_order_request(jsonb,jsonb),public.queue_order_submission(),public.claim_order_integration_job(uuid),public.finish_order_integration_job(uuid,uuid,text),public.retry_order_integrations(uuid) to service_role;
