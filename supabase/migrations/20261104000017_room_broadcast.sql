-- S1: move room events from Postgres Changes to private Broadcast topics `room:<room_id>`.
--
-- Why: Postgres Changes DELETE events skip RLS and carry the primary key, so any authenticated
-- subscriber could see (room_id, user_id) pairs from rooms they are not in.
--
-- Design:
-- * Triggers send a minimal payload {table, op, id} to the private topic `room:<room_id>`.
--   No row content is broadcast. Clients refetch through RLS, so a member who has left or a room that
--   has expired gets nothing from the refetch even while an old channel authorization is still cached.
-- * Only room members may receive on `room:<id>` (SELECT policy on realtime.messages).
--   There is no INSERT policy, so clients cannot publish or forge room events.
-- * Every room-scoped table is dropped from the supabase_realtime publication.
--   face_matches has no live consumer and is per-user, so it is dropped and not broadcast.

create or replace function private.room_topic_id(p_topic text)
returns uuid language sql immutable
set search_path = ''
as $$
  select case when p_topic like 'room:%' then private.try_uuid(substr(p_topic, 6)) end
$$;
revoke all on function private.room_topic_id(text) from public, anon, authenticated;
grant execute on function private.room_topic_id(text) to authenticated;

create policy room_topic_receive on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and private.is_room_member(private.room_topic_id((select realtime.topic())))
  );

create or replace function private.broadcast_room_change()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_room uuid;
begin
  if tg_table_name = 'rooms' then
    v_room := (v_row ->> 'id')::uuid;
  elsif tg_table_name = 'emergency_acks' then
    -- No room_id column; when the event itself is being deleted (cascade) there is nobody to tell.
    select e.room_id into v_room from public.emergency_events e where e.id = (v_row ->> 'event_id')::uuid;
  else
    v_room := (v_row ->> 'room_id')::uuid;
  end if;
  if v_room is null then
    return null;
  end if;
  perform realtime.send(
    jsonb_strip_nulls(jsonb_build_object('table', tg_table_name, 'op', tg_op, 'id', v_row ->> 'id')),
    tg_table_name,
    'room:' || v_room::text,
    true
  );
  return null;
end;
$$;
revoke all on function private.broadcast_room_change() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['rooms', 'room_members', 'messages', 'media', 'status_definitions', 'member_status',
                           'arrivals', 'live_presence', 'emergency_events', 'emergency_acks'] loop
    execute format(
      'create trigger broadcast_room_change after insert or update or delete on public.%I
         for each row execute function private.broadcast_room_change()', t);
  end loop;
end;
$$;

alter publication supabase_realtime drop table
  public.rooms, public.room_members, public.messages, public.media, public.status_definitions,
  public.member_status, public.arrivals, public.live_presence, public.emergency_events,
  public.emergency_acks, public.face_matches;
