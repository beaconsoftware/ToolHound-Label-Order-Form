-- One optional external system per request. Refuse ambiguous backfills.
do $$ begin
 if exists(select 1 from public.external_records group by request_id having count(*)>1) then
 raise exception 'Multiple external mappings must be resolved before migration'; end if;
end $$;
create unique index one_enabled_order_provider on public.order_integration_providers(enabled) where enabled;
alter table public.order_requests
 add column external_provider text references public.order_integration_providers(provider),
 add column external_id text,
 add column external_identifier text,
 add column external_url text,
 add column external_metadata jsonb not null default '{}',
 add constraint request_external_identity unique(external_provider,external_id),
 add constraint request_external_pair check((external_provider is null) = (external_id is null));
update public.order_requests r set external_provider=e.provider,external_id=e.external_id,
 external_identifier=e.identifier,external_url=e.url,external_metadata=e.metadata
 from public.external_records e where e.request_id=r.id;
alter table public.integration_jobs
 add column request_id uuid references public.order_requests(id),
 add column provider text references public.order_integration_providers(provider);
update public.integration_jobs j set request_id=e.request_id,provider=e.provider
 from public.external_records e where e.id=j.external_record_id;
alter table public.integration_jobs alter column request_id set not null,alter column provider set not null;
-- Replace the SQL function dependency before dropping the old mapping column.
drop function public.retry_order_integrations(uuid);
alter table public.integration_jobs drop column external_record_id;
alter table public.integration_jobs add unique(request_id,provider,event);
create index integration_jobs_provider_idx on public.integration_jobs(provider);
create or replace function public.create_order_request(p_request jsonb, p_quote jsonb)
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
  update public.order_requests set external_provider=p.provider,external_id=gen_random_uuid()::text
   from public.order_integration_providers p where id=r.id and p.enabled;
  insert into public.integration_jobs(request_id,provider,event)
   select id,external_provider,'request.created' from public.order_requests where id=r.id and external_provider is not null;
 end if;
 return r.id;
end; $$;

create or replace function public.queue_order_submission() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.order_request_id is null then return new; end if;
 insert into public.integration_jobs(request_id,provider,event)
 select id,external_provider,'order.submitted' from public.order_requests
 where id=new.order_request_id and external_provider is not null
 on conflict(request_id,provider,event) do nothing;
 return new;
end; $$;
create or replace function public.claim_order_integration_job(p_request_id uuid)
returns setof public.integration_jobs language plpgsql security invoker set search_path='' as $$
declare picked uuid;
begin
 select j.id into picked from public.integration_jobs j
 join public.order_requests e on e.id=j.request_id and e.external_provider=j.provider
 join public.order_integration_providers p on p.provider=e.external_provider and p.enabled
 where e.id=p_request_id and j.status<>'succeeded'
 and j.available_at<=now() and (j.lease_until is null or j.lease_until<now())
 and (j.event='request.created' or exists(select 1 from public.integration_jobs c
   where c.request_id=e.id and c.provider=j.provider and c.event='request.created' and c.status='succeeded'))
 order by j.created_at,j.id for update of j skip locked limit 1;
 if picked is null then return; end if;
 return query update public.integration_jobs set status='processing', attempts=attempts+1,
  lease_until=now()+interval '5 minutes',claim_token=gen_random_uuid()
  where id=picked returning *;
end; $$;
create function public.retry_order_integrations(p_request_id uuid)
returns void language sql security invoker set search_path='' as $$
 update public.integration_jobs set available_at=now()
 where request_id=p_request_id
 and status<>'succeeded' and (lease_until is null or lease_until<now());
$$;
revoke all on function public.retry_order_integrations(uuid) from public,anon,authenticated;
grant execute on function public.retry_order_integrations(uuid) to service_role;
drop table public.external_records;
