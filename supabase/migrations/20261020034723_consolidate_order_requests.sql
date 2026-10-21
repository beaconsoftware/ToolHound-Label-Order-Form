-- One quote and two bounded sync operations belong to the request itself.
-- Refuse to silently discard extra documents or another provider's history.
do $$ begin
 if exists(select 1 from public.order_requests r where
   (select count(*) from public.order_documents d where d.request_id=r.id) <> 1)
 or exists(select 1 from public.order_documents d join public.order_requests r on r.id=d.request_id
   where d.kind<>'quote' or d.version<>r.quote_version or d.content_type<>'application/pdf') then
   raise exception 'Resolve additional or missing request documents before consolidation';
 end if;
 if exists(select 1 from public.integration_jobs j join public.order_requests r on r.id=j.request_id
   where j.provider is distinct from r.external_provider) then
   raise exception 'Resolve historical provider jobs before consolidation';
 end if;
end $$;
alter table public.order_requests
 add column quote_name text,
 add column quote_sha256 text,
 add column quote_data text,
 add column external_sync jsonb not null default '{}' check(jsonb_typeof(external_sync)='object');
update public.order_requests r set quote_name=d.name,quote_sha256=d.sha256,quote_data=d.data_base64
 from public.order_documents d where d.request_id=r.id;
update public.order_requests r set external_sync=s.state
 from (select request_id,jsonb_object_agg(event,to_jsonb(j)-'id'-'request_id'-'event') state
       from public.integration_jobs j group by request_id) s where s.request_id=r.id;
alter table public.order_requests
 alter column quote_name set not null,alter column quote_sha256 set not null,alter column quote_data set not null,
 add check(length(quote_data) between 8 and 14000000);

-- Only trusted Edge Function code selects the provider. No browser grants.
drop function public.create_order_request(jsonb,jsonb);
create function public.create_order_request(p_request jsonb,p_quote jsonb,p_provider text default null)
returns uuid language plpgsql security invoker set search_path='' as $$
declare r public.order_requests; provider text;
begin
 r:=jsonb_populate_record(null::public.order_requests,p_request);
 provider:=case when r.mode='live' then p_provider end;
 insert into public.order_requests(id,created_by,mode,company_name,contact_name,contact_email,crm_url,barcode_type,token_hash,
 quote_name,quote_sha256,quote_data,external_provider,external_id,external_sync)
 values(r.id,r.created_by,r.mode,r.company_name,r.contact_name,r.contact_email,r.crm_url,r.barcode_type,r.token_hash,
 p_quote->>'name',p_quote->>'sha256',p_quote->>'data_base64',provider,
 case when provider is not null then gen_random_uuid()::text end,
 case when provider is not null then jsonb_build_object('request.created',jsonb_build_object(
   'provider',provider,'status','pending','attempts',0,'available_at',now(),'created_at',now())) else '{}'::jsonb end)
 on conflict(id) do nothing;
 return r.id;
end; $$;

create or replace function public.queue_order_submission() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.order_request_id is null then return new; end if;
 update public.order_requests set external_sync=external_sync||jsonb_build_object('order.submitted',jsonb_build_object(
   'provider',external_provider,'status','pending','attempts',0,'available_at',now(),'created_at',now()))
 where id=new.order_request_id and external_provider is not null and not external_sync ? 'order.submitted';
 return new;
end; $$;

-- A row lock and a claim token prevent overlapping work and stale completion.
create function public.claim_order_sync(p_request_id uuid,p_provider text)
returns table(id uuid,event text,provider text,claim_token uuid)
language plpgsql security invoker set search_path='' as $$
declare r public.order_requests; op text; state jsonb; claim uuid;
begin
 select * into r from public.order_requests where order_requests.id=p_request_id
   and mode='live' and external_provider=p_provider for update skip locked;
 if not found then return; end if;
 foreach op in array array['request.created','order.submitted'] loop
  state:=r.external_sync->op;
  if state is null or state->>'status'='succeeded' or state->>'provider' is distinct from r.external_provider then continue; end if;
  if (state->>'available_at')::timestamptz>now() or (state->>'lease_until')::timestamptz>now() then return; end if;
  if op='order.submitted' and (r.external_sync#>>'{request.created,status}') is distinct from 'succeeded' then return; end if;
  claim:=gen_random_uuid();
  state:=state||jsonb_build_object('status','processing','attempts',coalesce((state->>'attempts')::int,0)+1,
    'lease_until',now()+interval '5 minutes','claim_token',claim);
  update public.order_requests set external_sync=jsonb_set(external_sync,array[op],state) where order_requests.id=r.id;
  return query select r.id,op,r.external_provider,claim;
  return;
 end loop;
end; $$;
create function public.finish_order_sync(p_id uuid,p_event text,p_claim_token uuid,p_error text default null)
returns void language plpgsql security invoker set search_path='' as $$
declare r public.order_requests; state jsonb;
begin
 select * into r from public.order_requests where id=p_id for update;
 state:=r.external_sync->p_event;
 if state is null or state->>'claim_token' is distinct from p_claim_token::text
   or state->>'provider' is distinct from r.external_provider then return; end if;
 state:=state||jsonb_build_object('status',case when p_error is null then 'succeeded' else 'pending' end,
  'last_error',left(p_error,1000),'completed_at',case when p_error is null then now() end,
  'available_at',case when p_error is null then now() else now()+interval '1 minute'*least((state->>'attempts')::int,60) end,
  'lease_until',null,'claim_token',null);
 update public.order_requests set external_sync=jsonb_set(external_sync,array[p_event],state) where id=p_id;
end; $$;
drop function public.retry_order_integrations(uuid);
create function public.retry_order_integrations(p_request_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare r public.order_requests; op text; state jsonb;
begin
 select * into r from public.order_requests where id=p_request_id for update;
 if not found then return; end if;
 foreach op in array array['request.created','order.submitted'] loop
  state:=r.external_sync->op;
  if state is not null and state->>'status'<>'succeeded'
    and (state->>'lease_until' is null or (state->>'lease_until')::timestamptz<now()) then
   r.external_sync:=jsonb_set(r.external_sync,array[op],state||jsonb_build_object('available_at',now()));
  end if;
 end loop;
 update public.order_requests set external_sync=r.external_sync where id=p_request_id;
end; $$;
revoke all on function public.create_order_request(jsonb,jsonb,text),public.claim_order_sync(uuid,text),public.finish_order_sync(uuid,text,uuid,text),public.retry_order_integrations(uuid) from public,anon,authenticated;
grant execute on function public.create_order_request(jsonb,jsonb,text),public.claim_order_sync(uuid,text),public.finish_order_sync(uuid,text,uuid,text),public.retry_order_integrations(uuid) to service_role;

drop function public.claim_order_integration_job(uuid);
drop function public.finish_order_integration_job(uuid,uuid,text);
drop table public.integration_jobs;
drop table public.order_documents;
alter table public.order_requests drop constraint order_requests_external_provider_fkey;
drop table public.order_integration_providers;
