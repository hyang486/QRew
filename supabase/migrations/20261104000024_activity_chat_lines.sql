-- Running-crew #3: Start activity / End activity post a chat line, so members on the chat screen know to open
-- Map and share, and when it has ended.
-- NOT APPLIED. Apply only after explicit sign-off (see docs/CURRENT_STATE.md).
--
-- set_activity_state (from 0020) is replaced with the same body plus one kind='system' message from the host:
--   idle/ended -> active: "Activity started. Open Map to share your location."
--   active -> ended:      "Activity ended. Location sharing is off."
-- Nothing is posted when the state does not change (Start on an active room, End on an idle or ended room) or
-- when the call is refused (not the host of an open room, location not allowed, unknown state): those paths
-- return or raise before any insert. The host gate (private.is_room_host) already requires an open room.
--
-- set_location_allowed (from 0020) is also replaced (supervisor review): turning location off during an activity
-- moves it active -> ended, so it posts the same "Activity ended. Location sharing is off." line, only when the
-- room really was active (prior state read under a row lock). Off while idle/ended or already not allowed: no line.
--
-- Function replacements only: same names, arguments and return types, so the grants carry over. No table, RLS,
-- publication or Edge Function change. security definer with search_path '' as before. 'system' is already a
-- chat notice kind on the client.

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
    -- #3: only a real idle/ended -> active change gets here (an already active room returned above).
    insert into public.messages (room_id, sender_id, kind, body)
    values (p_room_id, auth.uid(), 'system', 'Activity started. Open Map to share your location.');
  elsif p_state = 'ended' then
    update public.rooms set activity_state = 'ended', activity_ended_at = now()
     where id = p_room_id and activity_state = 'active';
    -- #3: a line only for a real active -> ended change, not for ending an idle or already ended room.
    if found then
      insert into public.messages (room_id, sender_id, kind, body)
      values (p_room_id, auth.uid(), 'system', 'Activity ended. Location sharing is off.');
    end if;
    delete from public.live_presence where room_id = p_room_id;
    -- Consent does not carry over to the next activity (safe default; see header).
    update public.room_members set share_location = false where room_id = p_room_id and share_location;
  else
    raise exception 'Unknown activity state' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.set_location_allowed(p_room_id uuid, p_allowed boolean)
returns void language plpgsql security definer
set search_path = ''
as $$
declare
  v_was_active boolean;
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
    -- #3: read the prior state under a row lock, so a concurrent End cannot produce a second ended line.
    select location_allowed and activity_state = 'active' into v_was_active
      from public.rooms where id = p_room_id for update;
    update public.rooms
       set location_allowed = false,
           activity_state = case when activity_state = 'active' then 'ended' else activity_state end,
           activity_ended_at = case when activity_state = 'active' then now() else activity_ended_at end
     where id = p_room_id and location_allowed;
    if found and v_was_active then
      insert into public.messages (room_id, sender_id, kind, body)
      values (p_room_id, auth.uid(), 'system', 'Activity ended. Location sharing is off.');
    end if;
    delete from public.live_presence where room_id = p_room_id;
    update public.room_members set share_location = false where room_id = p_room_id and share_location;
  end if;
end;
$$;
