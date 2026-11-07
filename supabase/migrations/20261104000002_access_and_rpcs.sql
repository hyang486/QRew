-- Access helpers, RLS policies and RPCs.
-- Helpers and trigger functions live in schema `private`, which the Data API does not expose,
-- so they cannot be called as RPCs. RLS policies still call them as the `authenticated` role.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- Arrivals are deduplicated per activity (supervisor note P2). `activity_seq` is 0 until the
-- host first starts an activity, so rooms without an activity still get one arrival per member.
alter table public.rooms add column activity_seq integer not null default 0;
alter table public.arrivals add column activity_seq integer not null default 0;
alter table public.arrivals drop constraint arrivals_pkey;
alter table public.arrivals add primary key (room_id, user_id, activity_seq);

create or replace function private.is_host_account()
returns boolean language sql stable
set search_path = ''
as $$
  select auth.uid() is not null
     and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
$$;

create or replace function private.room_is_open(p_room_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.rooms r
    where r.id = p_room_id and r.deleted_at is null and r.expires_at > now()
  )
$$;

create or replace function private.is_room_member(p_room_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.room_members m
    join public.rooms r on r.id = m.room_id
    where m.room_id = p_room_id and m.user_id = auth.uid()
      and r.deleted_at is null and r.expires_at > now()
  )
$$;

create or replace function private.is_room_host(p_room_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.rooms r
    where r.id = p_room_id and r.host_id = auth.uid()
      and r.deleted_at is null and r.expires_at > now()
  )
$$;

-- Users who share at least one open room with the caller (for profile visibility).
create or replace function private.shares_open_room(p_user_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.room_members a
    join public.room_members b on b.room_id = a.room_id
    join public.rooms r on r.id = a.room_id
    where a.user_id = auth.uid() and b.user_id = p_user_id
      and r.deleted_at is null and r.expires_at > now()
  )
$$;

-- RLS -----------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.media enable row level security;
alter table public.messages enable row level security;
alter table public.status_definitions enable row level security;
alter table public.member_status enable row level security;
alter table public.arrivals enable row level security;
alter table public.live_presence enable row level security;
alter table public.emergency_events enable row level security;
alter table public.emergency_acks enable row level security;
alter table public.push_tokens enable row level security;
alter table public.expiry_reminders enable row level security;
alter table public.face_enrollments enable row level security;
alter table public.face_matches enable row level security;
alter table public.face_jobs enable row level security;
alter table public.cleanup_jobs enable row level security;
alter table public.join_attempts enable row level security;

create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or private.shares_open_room(id));
create policy profiles_insert on public.profiles for insert to authenticated
  with check (id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy rooms_select on public.rooms for select to authenticated
  using (private.is_room_member(id));

create policy members_select on public.room_members for select to authenticated
  using (private.is_room_member(room_id));

create policy media_select on public.media for select to authenticated
  using (private.is_room_member(room_id));
create policy media_insert on public.media for insert to authenticated
  with check (uploader_id = auth.uid() and private.is_room_member(room_id)
              and original_path like room_id::text || '/%');
create policy media_update_own on public.media for update to authenticated
  using (uploader_id = auth.uid() and private.is_room_member(room_id))
  with check (uploader_id = auth.uid() and private.is_room_member(room_id)
              and original_path like room_id::text || '/%');

create policy messages_select on public.messages for select to authenticated
  using (private.is_room_member(room_id));
create policy messages_insert on public.messages for insert to authenticated
  with check (sender_id = auth.uid() and kind in ('text', 'media')
              and private.is_room_member(room_id)
              and (media_id is null or exists (
                select 1 from public.media m
                where m.id = media_id and m.room_id = messages.room_id and m.uploader_id = auth.uid())));

create policy status_defs_select on public.status_definitions for select to authenticated
  using (private.is_room_member(room_id));

create policy member_status_select on public.member_status for select to authenticated
  using (private.is_room_member(room_id));

create policy arrivals_select on public.arrivals for select to authenticated
  using (private.is_room_member(room_id));

create policy presence_select on public.live_presence for select to authenticated
  using (private.is_room_member(room_id));

create policy emergency_select on public.emergency_events for select to authenticated
  using (private.is_room_member(room_id));
create policy emergency_acks_select on public.emergency_acks for select to authenticated
  using (exists (select 1 from public.emergency_events e
                 where e.id = event_id and private.is_room_member(e.room_id)));

create policy push_tokens_own on public.push_tokens for select to authenticated
  using (user_id = auth.uid());

create policy face_enrollments_own on public.face_enrollments for select to authenticated
  using (user_id = auth.uid() and private.is_room_member(room_id));
create policy face_matches_own on public.face_matches for select to authenticated
  using (exists (select 1 from public.face_enrollments e
                 where e.id = enrollment_id and e.user_id = auth.uid()
                   and private.is_room_member(e.room_id)));
create policy face_matches_exclude on public.face_matches for update to authenticated
  using (exists (select 1 from public.face_enrollments e
                 where e.id = enrollment_id and e.user_id = auth.uid()
                   and private.is_room_member(e.room_id)));
create policy face_jobs_own on public.face_jobs for select to authenticated
  using (exists (select 1 from public.face_enrollments e
                 where e.id = enrollment_id and e.user_id = auth.uid()));
-- cleanup_jobs, expiry_reminders, join_attempts: no client policies (service role only).

-- Only the `excluded` flag of a match may be changed by its owner.
revoke update on public.face_matches from authenticated;
grant update (excluded) on public.face_matches to authenticated;

-- Profiles are created on sign-up -------------------------------------------

create or replace function private.handle_new_user()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), 'Guest'))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Cleanup queueing ----------------------------------------------------------

create or replace function private.enqueue_cleanup(p_bucket text, p_prefix text, p_reason text)
returns void language sql security definer
set search_path = ''
as $$
  insert into public.cleanup_jobs (bucket, prefix, reason)
  values (p_bucket, p_prefix, p_reason)
  on conflict (bucket, prefix) do update
    set verified_empty_at = null, attempts = 0, last_error = null, reason = excluded.reason
$$;

-- Removing a face enrollment always queues removal of the reference object prefix.
create or replace function private.on_face_enrollment_deleted()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  perform private.enqueue_cleanup('face-refs', old.room_id::text || '/' || old.user_id::text || '/', 'face_enrollment_deleted');
  return old;
end;
$$;
create trigger face_enrollment_deleted after delete on public.face_enrollments
  for each row execute function private.on_face_enrollment_deleted();

create or replace function private.on_room_deleted()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  perform private.enqueue_cleanup('room-media', old.id::text || '/', 'room_deleted');
  perform private.enqueue_cleanup('face-refs', old.id::text || '/', 'room_deleted');
  return old;
end;
$$;
create trigger room_deleted after delete on public.rooms
  for each row execute function private.on_room_deleted();

-- A member who leaves loses location, status and face data for that room.
create or replace function private.on_member_removed()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  delete from public.live_presence where room_id = old.room_id and user_id = old.user_id;
  delete from public.member_status where room_id = old.room_id and user_id = old.user_id;
  -- face_enrollments cascades through its FK to room_members.
  return old;
end;
$$;
create trigger member_removed after delete on public.room_members
  for each row execute function private.on_member_removed();

-- RPCs ----------------------------------------------------------------------

create or replace function private.generate_room_code()
returns text language plpgsql
set search_path = ''
as $$
declare
  v_code text;
begin
  for i in 1..50 loop
    v_code := lpad((floor(random() * 100000))::int::text, 5, '0');
    if not exists (select 1 from public.rooms where code = v_code) then
      return v_code;
    end if;
  end loop;
  raise exception 'Could not allocate a room code';
end;
$$;

create or replace function public.create_room(
  p_name text,
  p_type text,
  p_expires_at timestamptz,
  p_location_allowed boolean,
  p_statuses text[] default array[]::text[]
) returns public.rooms
language plpgsql security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_label text;
  v_sort int := 1;
begin
  if not private.is_host_account() then
    raise exception 'Host account required' using errcode = '42501';
  end if;
  if p_expires_at < now() + interval '5 minutes' or p_expires_at > now() + interval '7 days' then
    raise exception 'Expiration must be between 5 minutes and 7 days from now' using errcode = '22023';
  end if;

  insert into public.rooms (host_id, name, type, expires_at, location_allowed, code)
  values (auth.uid(), trim(p_name), p_type, p_expires_at, coalesce(p_location_allowed, false), private.generate_room_code())
  returning * into v_room;

  insert into public.room_members (room_id, user_id, role) values (v_room.id, auth.uid(), 'host');

  insert into public.status_definitions (room_id, label, is_emergency, sort)
  values (v_room.id, 'Emergency', true, 0);
  foreach v_label in array coalesce(p_statuses, array[]::text[]) loop
    if char_length(trim(v_label)) between 1 and 30 and lower(trim(v_label)) <> 'emergency' then
      insert into public.status_definitions (room_id, label, sort) values (v_room.id, trim(v_label), v_sort);
      v_sort := v_sort + 1;
    end if;
  end loop;

  return v_room;
end;
$$;

-- Preview a room before joining. Returns nothing for an invalid or closed invite.
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
    raise exception 'Too many attempts. Try again in a few minutes.' using errcode = '54000';
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
    raise exception 'Too many attempts. Try again in a few minutes.' using errcode = '54000';
  end if;

  select * into v_room from public.rooms r
  where r.deleted_at is null and r.expires_at > now()
    and ((p_code is not null and r.code = p_code) or (p_token is not null and r.invite_token = p_token))
  limit 1
  for update;

  if v_room.id is null then
    insert into public.join_attempts (user_id, succeeded) values (auth.uid(), false);
    raise exception 'This invite is invalid or the room has ended.' using errcode = 'P0002';
  end if;

  if exists (select 1 from public.room_members where room_id = v_room.id and user_id = auth.uid()) then
    return v_room.id;
  end if;

  select count(*) into v_count from public.room_members where room_id = v_room.id;
  if v_count >= v_room.max_members then
    raise exception 'This room is full.' using errcode = '54000';
  end if;

  insert into public.room_members (room_id, user_id, role) values (v_room.id, auth.uid(), 'member');
  insert into public.join_attempts (user_id, succeeded) values (auth.uid(), true);
  insert into public.messages (room_id, sender_id, kind, body)
  values (v_room.id, auth.uid(), 'system',
          coalesce((select display_name from public.profiles where id = auth.uid()), 'Someone') || ' joined');
  return v_room.id;
end;
$$;

create or replace function public.leave_room(p_room_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.rooms where id = p_room_id and host_id = auth.uid()) then
    raise exception 'The host cannot leave. End the room instead.' using errcode = '42501';
  end if;
  delete from public.room_members where room_id = p_room_id and user_id = auth.uid();
  if found and private.room_is_open(p_room_id) then
    insert into public.messages (room_id, sender_id, kind, body)
    values (p_room_id, null, 'system',
            coalesce((select display_name from public.profiles where id = auth.uid()), 'Someone') || ' left');
  end if;
end;
$$;

-- Host ends the room now. Access stops immediately; the janitor removes data.
create or replace function public.end_room(p_room_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not private.is_room_host(p_room_id) then
    raise exception 'Only the host can end this room.' using errcode = '42501';
  end if;
  update public.rooms set deleted_at = now() where id = p_room_id;
end;
$$;

create or replace function public.update_room_expiry(p_room_id uuid, p_expires_at timestamptz)
returns public.rooms
language plpgsql security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
begin
  if not private.is_room_host(p_room_id) then
    raise exception 'Only the host can change the expiration.' using errcode = '42501';
  end if;
  if p_expires_at < now() + interval '5 minutes' or p_expires_at > now() + interval '7 days' then
    raise exception 'Expiration must be between 5 minutes and 7 days from now' using errcode = '22023';
  end if;
  update public.rooms
     set expires_at = p_expires_at, expiry_version = expiry_version + 1
   where id = p_room_id
  returning * into v_room;
  return v_room;
end;
$$;

create or replace function public.mark_arrived(p_room_id uuid)
returns timestamptz
language plpgsql security definer
set search_path = ''
as $$
declare
  v_at timestamptz;
  v_seq integer;
begin
  if not private.is_room_member(p_room_id) then
    raise exception 'Not a member of this room' using errcode = '42501';
  end if;
  select activity_seq into v_seq from public.rooms where id = p_room_id;
  insert into public.arrivals (room_id, user_id, activity_seq) values (p_room_id, auth.uid(), v_seq)
  on conflict do nothing
  returning arrived_at into v_at;
  if v_at is null then
    select arrived_at into v_at from public.arrivals
     where room_id = p_room_id and user_id = auth.uid() and activity_seq = v_seq;
    return v_at;
  end if;
  insert into public.messages (room_id, sender_id, kind, body)
  values (p_room_id, auth.uid(), 'arrival',
          coalesce((select display_name from public.profiles where id = auth.uid()), 'Someone') || ' arrived');
  return v_at;
end;
$$;

-- Sets the caller's status. Returns the emergency event id when Emergency was chosen.
create or replace function public.set_my_status(p_room_id uuid, p_status_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_def public.status_definitions;
  v_event uuid;
  v_name text;
begin
  if not private.is_room_member(p_room_id) then
    raise exception 'Not a member of this room' using errcode = '42501';
  end if;
  select * into v_def from public.status_definitions where id = p_status_id and room_id = p_room_id;
  if v_def.id is null then
    raise exception 'Unknown status' using errcode = '22023';
  end if;
  select coalesce(display_name, 'Someone') into v_name from public.profiles where id = auth.uid();

  insert into public.member_status (room_id, user_id, status_id, updated_at)
  values (p_room_id, auth.uid(), p_status_id, now())
  on conflict (room_id, user_id) do update set status_id = excluded.status_id, updated_at = now();

  if v_def.is_emergency then
    insert into public.emergency_events (room_id, user_id) values (p_room_id, auth.uid())
    returning id into v_event;
    insert into public.messages (room_id, sender_id, kind, body)
    values (p_room_id, auth.uid(), 'emergency', coalesce(v_name, 'Someone') || ' needs help (Emergency)');
  else
    insert into public.messages (room_id, sender_id, kind, body)
    values (p_room_id, auth.uid(), 'status', coalesce(v_name, 'Someone') || ': ' || v_def.label);
  end if;
  return v_event;
end;
$$;

create or replace function public.clear_my_status(p_room_id uuid)
returns void language sql security definer
set search_path = ''
as $$
  delete from public.member_status where room_id = p_room_id and user_id = auth.uid()
$$;

create or replace function public.ack_emergency(p_event_id uuid)
returns void language plpgsql security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.emergency_events e where e.id = p_event_id and private.is_room_member(e.room_id)) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  insert into public.emergency_acks (event_id, user_id) values (p_event_id, auth.uid()) on conflict do nothing;
end;
$$;

create or replace function public.set_status_definitions(p_room_id uuid, p_labels text[])
returns void language plpgsql security definer
set search_path = ''
as $$
declare
  v_label text;
  v_sort int := 1;
begin
  if not private.is_room_host(p_room_id) then
    raise exception 'Only the host can edit statuses.' using errcode = '42501';
  end if;
  delete from public.status_definitions
   where room_id = p_room_id and not is_emergency and label <> all (coalesce(p_labels, array[]::text[]));
  foreach v_label in array coalesce(p_labels, array[]::text[]) loop
    if char_length(trim(v_label)) between 1 and 30 and lower(trim(v_label)) <> 'emergency' then
      if exists (select 1 from public.status_definitions where room_id = p_room_id and label = trim(v_label)) then
        update public.status_definitions set sort = v_sort where room_id = p_room_id and label = trim(v_label);
      else
        insert into public.status_definitions (room_id, label, sort) values (p_room_id, trim(v_label), v_sort);
      end if;
      v_sort := v_sort + 1;
    end if;
  end loop;
end;
$$;

-- Activity and route (host only) ----------------------------------------------

create or replace function public.set_activity_state(p_room_id uuid, p_state text)
returns void language plpgsql security definer
set search_path = ''
as $$
begin
  if not private.is_room_host(p_room_id) then
    raise exception 'Only the host can start or end the activity.' using errcode = '42501';
  end if;
  if p_state = 'active' then
    update public.rooms
       set activity_state = 'active', activity_started_at = now(), activity_ended_at = null,
           activity_seq = activity_seq + 1
     where id = p_room_id and location_allowed and activity_state <> 'active';
    if not found and exists (select 1 from public.rooms where id = p_room_id and activity_state = 'active') then
      return;
    end if;
    if not found then
      raise exception 'Location sharing is not allowed in this room.' using errcode = '22023';
    end if;
  elsif p_state = 'ended' then
    update public.rooms set activity_state = 'ended', activity_ended_at = now() where id = p_room_id;
    delete from public.live_presence where room_id = p_room_id;
  else
    raise exception 'Unknown activity state' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.set_route(p_room_id uuid, p_route jsonb)
returns void language plpgsql security definer
set search_path = ''
as $$
begin
  if not private.is_room_host(p_room_id) then
    raise exception 'Only the host can edit the route.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_route) <> 'array' or jsonb_array_length(p_route) > 2000 then
    raise exception 'Invalid route' using errcode = '22023';
  end if;
  update public.rooms set route = p_route where id = p_room_id;
end;
$$;

-- Location ------------------------------------------------------------------

create or replace function public.set_share_location(p_room_id uuid, p_share boolean)
returns void language plpgsql security definer
set search_path = ''
as $$
begin
  if not private.is_room_member(p_room_id) then
    raise exception 'Not a member of this room' using errcode = '42501';
  end if;
  update public.room_members set share_location = p_share where room_id = p_room_id and user_id = auth.uid();
  if not p_share then
    delete from public.live_presence where room_id = p_room_id and user_id = auth.uid();
  end if;
end;
$$;

-- Accepts a position only while every server-checkable condition holds.
create or replace function public.report_location(
  p_room_id uuid, p_lat double precision, p_lng double precision,
  p_speed double precision default null, p_accuracy double precision default null, p_heading double precision default null
) returns boolean
language plpgsql security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.room_members m
    join public.rooms r on r.id = m.room_id
    where m.room_id = p_room_id and m.user_id = auth.uid() and m.share_location
      and r.deleted_at is null and r.expires_at > now()
      and r.location_allowed and r.activity_state = 'active'
  ) then
    delete from public.live_presence where room_id = p_room_id and user_id = auth.uid();
    return false;
  end if;
  insert into public.live_presence (room_id, user_id, lat, lng, speed_mps, accuracy_m, heading, updated_at)
  values (p_room_id, auth.uid(), p_lat, p_lng,
          case when p_speed is null or p_speed < 0 then null else p_speed end,
          p_accuracy, p_heading, now())
  on conflict (room_id, user_id) do update
    set lat = excluded.lat, lng = excluded.lng, speed_mps = excluded.speed_mps,
        accuracy_m = excluded.accuracy_m, heading = excluded.heading, updated_at = now();
  return true;
end;
$$;

-- Push tokens ---------------------------------------------------------------

create or replace function public.register_push_token(p_token text, p_platform text default 'ios')
returns void language sql security definer
set search_path = ''
as $$
  insert into public.push_tokens (token, user_id, platform, updated_at)
  values (p_token, auth.uid(), p_platform, now())
  on conflict (token) do update set user_id = auth.uid(), platform = excluded.platform, updated_at = now()
$$;

create or replace function public.unregister_push_token(p_token text)
returns void language sql security definer
set search_path = ''
as $$
  delete from public.push_tokens where token = p_token and user_id = auth.uid()
$$;

-- Face enrollment (client inserts via RPC after uploading the reference object) --

create or replace function public.enroll_face(p_room_id uuid, p_ref_path text)
returns uuid language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not private.is_room_member(p_room_id) then
    raise exception 'Not a member of this room' using errcode = '42501';
  end if;
  if p_ref_path not like p_room_id::text || '/' || auth.uid()::text || '/%' then
    raise exception 'Invalid reference path' using errcode = '22023';
  end if;
  delete from public.face_enrollments where room_id = p_room_id and user_id = auth.uid();
  insert into public.face_enrollments (room_id, user_id, ref_path)
  values (p_room_id, auth.uid(), p_ref_path) returning id into v_id;
  -- Queue every ready photo in the room.
  insert into public.face_jobs (enrollment_id, media_id)
  select v_id, m.id from public.media m
  where m.room_id = p_room_id and m.kind = 'photo' and m.status = 'ready'
  on conflict do nothing;
  return v_id;
end;
$$;

create or replace function public.remove_face_enrollment(p_room_id uuid)
returns void language sql security definer
set search_path = ''
as $$
  delete from public.face_enrollments where room_id = p_room_id and user_id = auth.uid()
$$;

-- When a photo becomes ready, queue it for every enrollment in that room.
create or replace function private.on_media_ready()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  if new.kind = 'photo' and new.status = 'ready' and (tg_op = 'INSERT' or old.status is distinct from 'ready') then
    insert into public.face_jobs (enrollment_id, media_id)
    select e.id, new.id from public.face_enrollments e where e.room_id = new.room_id
    on conflict do nothing;
  end if;
  return new;
end;
$$;
create trigger media_ready after insert or update of status on public.media
  for each row execute function private.on_media_ready();

-- Grants --------------------------------------------------------------------

-- Every function is executable by PUBLIC by default. Close all of them, then open what is needed.
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_host_account(), private.room_is_open(uuid), private.is_room_member(uuid),
  private.is_room_host(uuid), private.shares_open_room(uuid) to authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke all on public.cleanup_jobs, public.expiry_reminders, public.join_attempts from anon, authenticated;

-- Realtime ------------------------------------------------------------------

alter publication supabase_realtime add table
  public.messages, public.media, public.room_members, public.arrivals,
  public.live_presence, public.member_status, public.emergency_events, public.rooms,
  public.face_matches, public.status_definitions;
