-- Scheduled invocation of the room-janitor Edge Function without any secret leaving the database.
-- A random shared secret lives in private.janitor_config. pg_net sends it from inside Postgres in the
-- x-janitor-secret header; the function checks it through public.janitor_secret_ok (service_role only).
-- The schedule itself is created separately (see the status doc) after the first verified run.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create table if not exists private.janitor_config (
  id integer primary key default 1 check (id = 1),
  secret text not null default encode(extensions.gen_random_bytes(32), 'hex')
);
insert into private.janitor_config (id) values (1) on conflict do nothing;
alter table private.janitor_config enable row level security;
revoke all on private.janitor_config from public, anon, authenticated;

create or replace function public.janitor_secret_ok(p_secret text)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from private.janitor_config where secret = p_secret)
$$;
revoke execute on function public.janitor_secret_ok(text) from public, anon, authenticated;
grant execute on function public.janitor_secret_ok(text) to service_role;

create or replace function private.invoke_janitor()
returns bigint language plpgsql security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  select secret into v_secret from private.janitor_config where id = 1;
  return net.http_post(
    url := 'https://wuhkyjksiiqzoxvonfuy.supabase.co/functions/v1/room-janitor',
    headers := jsonb_build_object('content-type', 'application/json', 'x-janitor-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;
revoke execute on function private.invoke_janitor() from public, anon, authenticated;
