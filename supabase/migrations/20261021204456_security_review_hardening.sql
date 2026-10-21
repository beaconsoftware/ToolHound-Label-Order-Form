-- One authorization rule for RLS and the Edge Function. The private helper
-- reads the current verified account, not editable metadata or stale JWT email.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;
create or replace function private.is_label_order_staff()
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare claims jsonb; caller uuid;
begin
  begin
    claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    if claims->>'role' is distinct from 'authenticated' then return false; end if;
    caller := (claims->>'sub')::uuid;
  exception when others then return false;
  end;
  return exists (
    select 1 from auth.users u where u.id = caller
      and u.email_confirmed_at is not null and u.deleted_at is null
      and not coalesce(u.is_anonymous, false)
      and (u.banned_until is null or u.banned_until <= now())
      and (lower(split_part(u.email, '@', 2)) = 'beaconsoftware.com'
           or lower(u.email) = 'graham.cooper@toolhound.com')
  );
end;
$$;
revoke all on function private.is_label_order_staff() from public, anon;
grant execute on function private.is_label_order_staff() to authenticated, service_role;
create or replace function public.is_label_order_staff()
returns boolean language sql stable security invoker set search_path = '' as $$
  select private.is_label_order_staff();
$$;
revoke all on function public.is_label_order_staff() from public, anon;
grant execute on function public.is_label_order_staff() to authenticated, service_role;
comment on function public.is_label_order_staff() is
  'Current confirmed Beacon account or Graham Cooper. Shared by RLS and the staff Edge Function; client metadata never grants access.';
-- This is a trigger, not a public API. Existing trigger invocation is unaffected.
revoke all on function public.enforce_staff_oauth_domain() from public, anon, authenticated;
