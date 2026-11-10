-- Place and time unit (human decision 2026-11-09: before U6).
-- Optional room fields set at creation: a place name, an optional pin (lat/lng) and an optional start time.
-- A room with none of them behaves exactly as before.
--
-- Rules:
--   * A pin needs a place name (no coordinates without text). A place name can exist without a pin.
--   * Latitude and longitude come together (both or neither), in range, finite (NaN and Infinity fail the
--     range checks in Postgres).
--   * The place name is stored trimmed, 1-80 characters; an empty or blank name counts as no place.
--   * starts_at is checked only in create_room: it must be before the room's expiry and not more than one day
--     in the past. It is not tied to expires_at by a table constraint, because update_room_expiry may later
--     move the expiry before it; the client then simply shows the time as given.
--
-- Access: unchanged. The fields are columns of public.rooms, so they are readable only through the existing
-- rooms_select policy (open-room members) and through preview_room (open rooms only, join-gated), and they
-- are removed with the room row when room-janitor deletes expired or ended rooms. No new read path.

alter table public.rooms
  add column place_name text,
  add column place_lat double precision,
  add column place_lng double precision,
  add column starts_at timestamptz,
  add constraint rooms_place_name_check
    check (place_name is null or (place_name = btrim(place_name) and char_length(place_name) between 1 and 80)),
  add constraint rooms_place_lat_range check (place_lat is null or place_lat between -90 and 90),
  add constraint rooms_place_lng_range check (place_lng is null or place_lng between -180 and 180),
  add constraint rooms_place_pin_pair check ((place_lat is null) = (place_lng is null)),
  add constraint rooms_place_pin_needs_name check (place_lat is null or place_name is not null);

-- create_room: four new optional arguments (default null). Existing callers pass the first five by name
-- (supabase-js rpc), so they keep working unchanged. The old five-argument function is dropped so that
-- PostgREST sees a single create_room and never has to choose between overloads.
drop function public.create_room(text, text, timestamptz, boolean, text[]);

create function public.create_room(
  p_name text,
  p_type text,
  p_expires_at timestamptz,
  p_location_allowed boolean,
  p_statuses text[] default array[]::text[],
  p_place_name text default null,
  p_place_lat double precision default null,
  p_place_lng double precision default null,
  p_starts_at timestamptz default null
) returns public.rooms
language plpgsql security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_label text;
  v_sort int := 1;
  v_place text := nullif(btrim(p_place_name), '');
begin
  if not private.is_host_account() then
    raise exception 'Host account required' using errcode = '42501';
  end if;
  if p_expires_at < now() + interval '5 minutes' or p_expires_at > now() + interval '7 days' then
    raise exception 'Expiration must be between 5 minutes and 7 days from now' using errcode = '22023';
  end if;
  if (p_place_lat is null) <> (p_place_lng is null) then
    raise exception 'A pin needs both latitude and longitude' using errcode = '22023';
  end if;
  if p_place_lat is not null and v_place is null then
    raise exception 'A pin needs a place name' using errcode = '22023';
  end if;
  if p_place_lat is not null
     and (not (p_place_lat between -90 and 90) or not (p_place_lng between -180 and 180)) then
    raise exception 'The pin is outside the valid range' using errcode = '22023';
  end if;
  if char_length(v_place) > 80 then
    raise exception 'Place name must be at most 80 characters' using errcode = '22023';
  end if;
  if p_starts_at is not null and (p_starts_at >= p_expires_at or p_starts_at < now() - interval '1 day') then
    raise exception 'Start time must be before the room closes and not more than a day ago' using errcode = '22023';
  end if;

  insert into public.rooms (host_id, name, type, expires_at, location_allowed, code,
                            place_name, place_lat, place_lng, starts_at)
  values (auth.uid(), trim(p_name), p_type, p_expires_at, coalesce(p_location_allowed, false),
          private.generate_room_code(), v_place, p_place_lat, p_place_lng, p_starts_at)
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

-- preview_room: same body as 0008 (join gate, open rooms only, failure rows), plus the four fields.
-- The return type changes, so the function is dropped and created again.
drop function public.preview_room(text, text);

create function public.preview_room(p_code text default null, p_token text default null)
returns table (room_id uuid, name text, type text, expires_at timestamptz, member_count bigint, max_members int,
               already_member boolean, place_name text, place_lat double precision, place_lng double precision,
               starts_at timestamptz)
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
           v_room.max_members, v_member,
           v_room.place_name, v_room.place_lat, v_room.place_lng, v_room.starts_at;
end;
$$;

-- Same grants as every public RPC (0002): signed-in users only.
revoke execute on function public.create_room(text, text, timestamptz, boolean, text[], text, double precision, double precision, timestamptz) from public, anon;
grant execute on function public.create_room(text, text, timestamptz, boolean, text[], text, double precision, double precision, timestamptz) to authenticated;
revoke execute on function public.preview_room(text, text) from public, anon;
grant execute on function public.preview_room(text, text) to authenticated;

notify pgrst, 'reload schema';
