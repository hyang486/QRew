-- F1b (supervisor review): the join throttle counted failures per user only, and anonymous
-- users are free to mint, so the limit could be bypassed. This adds a shared gate with
-- per-user, per-source-IP and global (stress mode) budgets. No per-code lockout.
--
-- Source IP (verified live 2026-11-04 with forged headers through the Supabase API gateway):
--   cf-connecting-ip   set by Cloudflare; a client-supplied value is rejected (Cloudflare error 1000)
--   sb-forwarded-for   set by the gateway; a client-supplied value is overwritten
--   x-forwarded-for    client value is PREPENDED ("1.2.3.4,<real ip>"), so only the last hop is trusted
-- Only an HMAC of the IP (random server-side salt) is stored, and rows older than 24h are deleted.
--
-- Budgets (failed attempts only, 10-minute window):
--   code path:  10 per user, 30 per IP; stress mode (more than 200 code-path failures globally)
--               lowers these to 1 per user and 5 per IP.
--   token path: 20 per user, 60 per IP; no stress mode (a QR token has 144 bits).
-- A caller over budget can still preview/join a room it is already a member of.
-- GET /rpc/* runs read-only in PostgREST, where a failure row cannot be written; the gate
-- rejects read-only transactions up front (PT405) so GET cannot probe codes unrecorded.

alter table public.join_attempts
  add column kind text not null default 'code' check (kind in ('code', 'token')),
  add column ip_hash text;

create index join_attempts_ip_idx on public.join_attempts (ip_hash, attempted_at desc)
  where not succeeded and ip_hash is not null;
create index join_attempts_attempted_idx on public.join_attempts (attempted_at);

create table private.join_gate_secret (
  id int primary key default 1 check (id = 1),
  salt bytea not null default extensions.gen_random_bytes(32)
);
alter table private.join_gate_secret enable row level security;
revoke all on private.join_gate_secret from public, anon, authenticated;
insert into private.join_gate_secret default values;

create or replace function private.request_ip()
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_headers json := nullif(current_setting('request.headers', true), '')::json;
  v_ip text;
begin
  if v_headers is null then
    return null;
  end if;
  -- For list-valued headers take the LAST hop (the one our gateway appended).
  v_ip := coalesce(
    nullif(btrim(v_headers ->> 'cf-connecting-ip'), ''),
    nullif(btrim(reverse(split_part(reverse(coalesce(v_headers ->> 'sb-forwarded-for', '')), ',', 1))), ''),
    nullif(btrim(reverse(split_part(reverse(coalesce(v_headers ->> 'x-forwarded-for', '')), ',', 1))), ''));
  return v_ip;
end;
$$;

create or replace function private.join_gate(p_kind text, out ip_hash text, out blocked boolean)
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_ip text := private.request_ip();
  v_stress boolean := false;
  v_user_budget int;
  v_ip_budget int;
  v_user_fail int;
  v_ip_fail int := 0;
begin
  if v_uid is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  if current_setting('transaction_read_only') = 'on' then
    raise exception 'Use POST for this call.' using errcode = 'PT405';
  end if;
  if p_kind not in ('code', 'token') then
    raise exception 'Invalid kind' using errcode = '22023';
  end if;

  if v_ip is not null then
    ip_hash := encode(extensions.hmac(convert_to(v_ip, 'UTF8'),
                      (select s.salt from private.join_gate_secret s where s.id = 1), 'sha256'), 'hex');
  end if;

  -- Serialize per user, then per IP (fixed order: no lock cycle). Held until commit,
  -- so the failure row written by the caller is visible to the next waiter.
  perform pg_advisory_xact_lock(hashtextextended('join_gate:user:' || v_uid::text, 0));
  if ip_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('join_gate:ip:' || ip_hash, 0));
  end if;

  -- Data minimization: drop attempts older than 24h (bounded batch, skip rows in use).
  delete from public.join_attempts
  where id in (select a.id from public.join_attempts a
               where a.attempted_at < now() - interval '24 hours'
               limit 100 for update skip locked);

  if p_kind = 'code' then
    select count(*) > 200 into v_stress from (
      select 1 from public.join_attempts a
      where a.attempted_at > now() - interval '10 minutes' and not a.succeeded and a.kind = 'code'
      limit 201) s;
    v_user_budget := case when v_stress then 1 else 10 end;
    v_ip_budget := case when v_stress then 5 else 30 end;
  else
    v_user_budget := 20;
    v_ip_budget := 60;
  end if;

  select count(*) into v_user_fail from public.join_attempts a
  where a.user_id = v_uid and not a.succeeded and a.kind = p_kind
    and a.attempted_at > now() - interval '10 minutes';
  if ip_hash is not null then
    select count(*) into v_ip_fail from public.join_attempts a
    where a.ip_hash = join_gate.ip_hash and not a.succeeded and a.kind = p_kind
      and a.attempted_at > now() - interval '10 minutes';
  end if;

  blocked := v_user_fail >= v_user_budget or v_ip_fail >= v_ip_budget;
end;
$$;

revoke all on function private.request_ip() from public, anon, authenticated;
revoke all on function private.join_gate(text) from public, anon, authenticated;

create or replace function public.preview_room(p_code text default null, p_token text default null)
returns table (room_id uuid, name text, type text, expires_at timestamptz, member_count bigint, max_members int, already_member boolean)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_kind text := case when p_code is null and p_token is not null then 'token' else 'code' end;
  v_gate record;
  v_member boolean;
begin
  if auth.uid() is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  select * into v_gate from private.join_gate(v_kind);

  select * into v_room from public.rooms r
  where r.deleted_at is null and r.expires_at > now()
    and ((p_code is not null and r.code = p_code) or (p_token is not null and r.invite_token = p_token))
  limit 1;

  v_member := v_room.id is not null and exists (
    select 1 from public.room_members m where m.room_id = v_room.id and m.user_id = auth.uid());

  if v_gate.blocked and not v_member then
    raise exception 'Too many attempts. Try again in a few minutes.' using errcode = 'PT429';
  end if;

  if v_room.id is null then
    -- Do not raise after this insert: a raise would roll the failure row back.
    insert into public.join_attempts (user_id, succeeded, kind, ip_hash)
    values (auth.uid(), false, v_kind, v_gate.ip_hash);
    return;
  end if;

  return query
    select v_room.id, v_room.name, v_room.type, v_room.expires_at,
           (select count(*) from public.room_members m where m.room_id = v_room.id),
           v_room.max_members, v_member;
end;
$$;

create or replace function public.join_room(p_code text default null, p_token text default null)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_kind text := case when p_code is null and p_token is not null then 'token' else 'code' end;
  v_gate record;
  v_count int;
begin
  if auth.uid() is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  select * into v_gate from private.join_gate(v_kind);

  select * into v_room from public.rooms r
  where r.deleted_at is null and r.expires_at > now()
    and ((p_code is not null and r.code = p_code) or (p_token is not null and r.invite_token = p_token))
  limit 1
  for update;

  if v_room.id is not null
     and exists (select 1 from public.room_members where room_id = v_room.id and user_id = auth.uid()) then
    return v_room.id;
  end if;

  if v_gate.blocked then
    raise exception 'Too many attempts. Try again in a few minutes.' using errcode = 'PT429';
  end if;

  if v_room.id is null then
    -- Do not raise after this insert: a raise would roll the failure row back.
    insert into public.join_attempts (user_id, succeeded, kind, ip_hash)
    values (auth.uid(), false, v_kind, v_gate.ip_hash);
    return null;
  end if;

  select count(*) into v_count from public.room_members where room_id = v_room.id;
  if v_count >= v_room.max_members then
    raise exception 'This room is full.' using errcode = 'PT409';
  end if;

  insert into public.room_members (room_id, user_id, role) values (v_room.id, auth.uid(), 'member');
  insert into public.join_attempts (user_id, succeeded, kind, ip_hash)
  values (auth.uid(), true, v_kind, v_gate.ip_hash);
  insert into public.messages (room_id, sender_id, kind, body)
  values (v_room.id, auth.uid(), 'system',
          coalesce((select display_name from public.profiles where id = auth.uid()), 'Someone') || ' joined');
  return v_room.id;
end;
$$;
