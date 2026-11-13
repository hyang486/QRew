-- Minimal local stand-ins for the Supabase platform schemas (auth, storage, realtime, cron, net).
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema extensions;
create extension pgcrypto with schema extensions;
create schema auth; create schema storage; create schema realtime; create schema cron; create schema net;
grant usage on schema public, auth, storage, realtime, extensions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
grant all on schema public to anon, authenticated, service_role;

create table auth.users (
  instance_id uuid, id uuid primary key, aud text, role text, email text, is_anonymous boolean not null default false,
  raw_user_meta_data jsonb, raw_app_meta_data jsonb, created_at timestamptz, updated_at timestamptz, deleted_at timestamptz,
  banned_until timestamptz, email_confirmed_at timestamptz, last_sign_in_at timestamptz, phone text);
grant select on auth.users to service_role;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create function auth.role() returns text language sql stable as $$ select auth.jwt() ->> 'role' $$;
grant execute on all functions in schema auth to anon, authenticated, service_role;

create table storage.buckets (id text primary key, name text, owner uuid, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now(), updated_at timestamptz default now());
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text, owner uuid, owner_id text, metadata jsonb, user_metadata jsonb, version text,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  created_at timestamptz default now(), updated_at timestamptz default now(), last_accessed_at timestamptz default now(),
  unique (bucket_id, name));
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
create function storage.filename(name text) returns text language sql immutable as $$
  select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)] $$;
grant execute on all functions in schema storage to anon, authenticated, service_role;

create table realtime.messages (id uuid default gen_random_uuid(), topic text not null, extension text not null,
  payload jsonb, event text, private boolean default false, updated_at timestamptz default now(),
  inserted_at timestamptz default now(), primary key (id));
alter table realtime.messages enable row level security;
grant select, insert on realtime.messages to anon, authenticated, service_role;
create function realtime.topic() returns text language sql stable as $$ select nullif(current_setting('realtime.topic', true), '') $$;
create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
language sql security definer as $$
  insert into realtime.messages (payload, event, topic, private, extension) values (payload, event, topic, private, 'broadcast') $$;
grant execute on all functions in schema realtime to anon, authenticated, service_role;
create publication supabase_realtime;

create table cron.job (jobid bigserial primary key, schedule text, command text, jobname text unique, active boolean default true);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
create function cron.unschedule(job_name text) returns boolean language sql as $$
  with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d) $$;

create table net._http_response (id bigint, status_code integer, content_type text, headers jsonb, content text,
  timed_out boolean, error_msg text, created timestamptz default now());
create sequence net.req_seq;
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}',
  timeout_milliseconds integer default 5000) returns bigint language sql as $$ select nextval('net.req_seq') $$;
