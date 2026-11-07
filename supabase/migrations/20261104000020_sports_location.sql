-- Sports flow server rules (APP_CONCEPT_KO "위치 공유 조건", "경로 그리기").
--
-- Location is written only through public.report_location, which checks the five server-side
-- conditions: the room is live, the caller is a member, the host allowed location, the member opted
-- in, and the activity is active. The device permission and logout are client-side (see 6). Adds:
--
-- 1. public.set_location_allowed: the host can turn location sharing for the room on or off after
--    creation. Turning it off ends a running activity, deletes every live position and clears every
--    member's opt-in.
-- 2. Consent does not carry over. Ending the activity clears every member's opt-in, so a restarted
--    activity starts with nobody sharing (rejoining already starts at the column default, false).
--    The human has not decided this policy (§92); OFF is the safe default and is listed as open.
-- 3. public.set_share_location refuses to opt in where the host has not allowed location.
-- 4. public.set_route validates each point and stores only {lat, lng} numbers.
-- 5. live_presence is readable only while the room's activity is running with location allowed
--    (rows are also deleted at those transitions; this is defense in depth). Starting an activity also
--    deletes the room's positions, so a report that raced the previous end is not shown again.
-- 6. public.stop_my_location: the client calls it before sign-out and when the device permission is
--    lost (§92). It clears the caller's opt-in and position in every room. The server cannot see the
--    device permission or an offline sign-out; those cases rely on the client and the stale label.
-- 7. report_location validates coordinates (22023) and stores non-finite or out-of-range speed,
--    accuracy and heading as unknown.

create or replace function private.room_location_live(p_room_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.rooms r
    where r.id = p_room_id and r.deleted_at is null and r.expires_at > now()
      and r.location_allowed and r.activity_state = 'active'
  )
$$;
revoke execute on function private.room_location_live(uuid) from public, anon;
grant execute on function private.room_location_live(uuid) to authenticated;

drop policy if exists presence_select on public.live_presence;
create policy presence_select on public.live_presence for select to authenticated
  using (private.is_room_member(room_id) and private.room_location_live(room_id));

create or replace function public.set_location_allowed(p_room_id uuid, p_allowed boolean)
returns void language plpgsql security definer
set search_path = ''
as $$
begin
  if not private.is_room_host(p_room_id) then
    raise exception 'Only the host can change location sharing.' using errcode = '42501';
  end if;
  if p_allowed is null then
    raise exception 'Invalid value' using errcode = '22023';
  end if;
  if p_allowed then
    update public.rooms set location_allowed = true where id = p_room_id and not location_allowed;
  else
    update public.rooms
       set location_allowed = false,
           activity_state = case when activity_state = 'active' then 'ended' else activity_state end,
           activity_ended_at = case when activity_state = 'active' then now() else activity_ended_at end
     where id = p_room_id and location_allowed;
    delete from public.live_presence where room_id = p_room_id;
    update public.room_members set share_location = false where room_id = p_room_id and share_location;
  end if;
end;
$$;

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
    -- A report that raced the previous 'ended' may have inserted after its delete; never carry it over.
    delete from public.live_presence where room_id = p_room_id;
  elsif p_state = 'ended' then
    update public.rooms set activity_state = 'ended', activity_ended_at = now()
     where id = p_room_id and activity_state = 'active';
    delete from public.live_presence where room_id = p_room_id;
    -- Consent does not carry over to the next activity (safe default; see header).
    update public.room_members set share_location = false where room_id = p_room_id and share_location;
  else
    raise exception 'Unknown activity state' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.set_share_location(p_room_id uuid, p_share boolean)
returns void language plpgsql security definer
set search_path = ''
as $$
begin
  if not private.is_room_member(p_room_id) then
    raise exception 'Not a member of this room' using errcode = '42501';
  end if;
  if p_share is null then
    raise exception 'Invalid value' using errcode = '22023';
  end if;
  if p_share and not exists (select 1 from public.rooms where id = p_room_id and location_allowed) then
    raise exception 'Location sharing is not allowed in this room.' using errcode = '22023';
  end if;
  update public.room_members set share_location = p_share where room_id = p_room_id and user_id = auth.uid();
  if not p_share then
    delete from public.live_presence where room_id = p_room_id and user_id = auth.uid();
  end if;
end;
$$;

-- Route: a JSON array of at most 2000 {lat, lng} points; each coordinate a finite number in range.
-- Extra keys are dropped. An empty array clears the route.
create or replace function public.set_route(p_room_id uuid, p_route jsonb)
returns void language plpgsql security definer
set search_path = ''
as $$
declare
  v_clean jsonb;
begin
  if not private.is_room_host(p_room_id) then
    raise exception 'Only the host can edit the route.' using errcode = '42501';
  end if;
  if p_route is null or jsonb_typeof(p_route) <> 'array' or jsonb_array_length(p_route) > 2000 then
    raise exception 'Invalid route' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_route) p
    where case
      when jsonb_typeof(p) = 'object' and jsonb_typeof(p -> 'lat') = 'number' and jsonb_typeof(p -> 'lng') = 'number'
        then (p ->> 'lat')::double precision not between -90 and 90
          or (p ->> 'lng')::double precision not between -180 and 180
      else true
    end
  ) then
    raise exception 'Invalid route point' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('lat', (p ->> 'lat')::double precision,
                                               'lng', (p ->> 'lng')::double precision) order by i), '[]'::jsonb)
    into v_clean
    from jsonb_array_elements(p_route) with ordinality as t(p, i);
  update public.rooms set route = v_clean where id = p_room_id;
end;
$$;

create or replace function public.stop_my_location()
returns void language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  update public.room_members set share_location = false where user_id = auth.uid() and share_location;
  delete from public.live_presence where user_id = auth.uid();
end;
$$;

create or replace function public.report_location(
  p_room_id uuid, p_lat double precision, p_lng double precision,
  p_speed double precision default null, p_accuracy double precision default null, p_heading double precision default null
) returns boolean
language plpgsql security definer
set search_path = ''
as $$
begin
  -- In Postgres NaN = NaN, so IN catches it.
  if p_lat is null or p_lng is null
     or p_lat in ('NaN', 'Infinity', '-Infinity') or p_lng in ('NaN', 'Infinity', '-Infinity')
     or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'Invalid coordinates' using errcode = '22023';
  end if;
  if p_speed in ('NaN', 'Infinity', '-Infinity') or p_speed < 0 then p_speed := null; end if;
  if p_accuracy in ('NaN', 'Infinity', '-Infinity') or p_accuracy < 0 then p_accuracy := null; end if;
  if p_heading in ('NaN', 'Infinity', '-Infinity') or p_heading < 0 or p_heading >= 360 then p_heading := null; end if;

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
  values (p_room_id, auth.uid(), p_lat, p_lng, p_speed, p_accuracy, p_heading, now())
  on conflict (room_id, user_id) do update
    set lat = excluded.lat, lng = excluded.lng, speed_mps = excluded.speed_mps,
        accuracy_m = excluded.accuracy_m, heading = excluded.heading, updated_at = now();
  return true;
end;
$$;

revoke execute on function public.set_location_allowed(uuid, boolean) from public, anon;
grant execute on function public.set_location_allowed(uuid, boolean) to authenticated;
revoke execute on function public.stop_my_location() from public, anon;
grant execute on function public.stop_my_location() to authenticated;
revoke execute on function public.report_location(uuid, double precision, double precision, double precision, double precision, double precision) from public, anon;
grant execute on function public.report_location(uuid, double precision, double precision, double precision, double precision, double precision) to authenticated;
