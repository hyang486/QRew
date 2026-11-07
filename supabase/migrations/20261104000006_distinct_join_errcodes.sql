-- Supervisor note N4: the join throttle and "room is full" both used errcode 54000.
-- PostgREST maps SQLSTATE PTxxx to HTTP status xxx, so the client can tell them apart:
--   PT429 = too many failed attempts (HTTP 429), PT409 = room is full (HTTP 409).
-- Function bodies are otherwise unchanged; create or replace keeps the existing grants.

create or replace function public.preview_room(p_code text default null, p_token text default null)
returns table (room_id uuid, name text, type text, expires_at timestamptz, member_count bigint, max_members int, already_member boolean)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_recent int;
begin
  if auth.uid() is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  select count(*) into v_recent from public.join_attempts
  where user_id = auth.uid() and not succeeded and attempted_at > now() - interval '10 minutes';
  if v_recent >= 10 then
    raise exception 'Too many attempts. Try again in a few minutes.' using errcode = 'PT429';
  end if;

  select * into v_room from public.rooms r
  where r.deleted_at is null and r.expires_at > now()
    and ((p_code is not null and r.code = p_code) or (p_token is not null and r.invite_token = p_token))
  limit 1;

  if v_room.id is null then
    insert into public.join_attempts (user_id, succeeded) values (auth.uid(), false);
    return;
  end if;

  return query
    select v_room.id, v_room.name, v_room.type, v_room.expires_at,
           (select count(*) from public.room_members m where m.room_id = v_room.id),
           v_room.max_members,
           exists (select 1 from public.room_members m where m.room_id = v_room.id and m.user_id = auth.uid());
end;
$$;

create or replace function public.join_room(p_code text default null, p_token text default null)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_recent int;
  v_count int;
begin
  if auth.uid() is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  select count(*) into v_recent from public.join_attempts
  where user_id = auth.uid() and not succeeded and attempted_at > now() - interval '10 minutes';
  if v_recent >= 10 then
    raise exception 'Too many attempts. Try again in a few minutes.' using errcode = 'PT429';
  end if;

  select * into v_room from public.rooms r
  where r.deleted_at is null and r.expires_at > now()
    and ((p_code is not null and r.code = p_code) or (p_token is not null and r.invite_token = p_token))
  limit 1
  for update;

  if v_room.id is null then
    -- Do not raise here: a raise would roll back this row and disable the throttle.
    insert into public.join_attempts (user_id, succeeded) values (auth.uid(), false);
    return null;
  end if;

  if exists (select 1 from public.room_members where room_id = v_room.id and user_id = auth.uid()) then
    return v_room.id;
  end if;

  select count(*) into v_count from public.room_members where room_id = v_room.id;
  if v_count >= v_room.max_members then
    raise exception 'This room is full.' using errcode = 'PT409';
  end if;

  insert into public.room_members (room_id, user_id, role) values (v_room.id, auth.uid(), 'member');
  insert into public.join_attempts (user_id, succeeded) values (auth.uid(), true);
  insert into public.messages (room_id, sender_id, kind, body)
  values (v_room.id, auth.uid(), 'system',
          coalesce((select display_name from public.profiles where id = auth.uid()), 'Someone') || ' joined');
  return v_room.id;
end;
$$;
