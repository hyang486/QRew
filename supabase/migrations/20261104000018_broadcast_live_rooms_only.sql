-- N18: only broadcast room events while the room is live.
--
-- Why: the janitor's hard delete of an expired room cascades to messages, media, members and so on,
-- and each child row fired its own realtime.send to a topic nobody can receive any more (members are
-- denied once the room is expired or deleted).
--
-- Rule:
-- * rooms DELETE: never sent (only the janitor hard-deletes; the room is already dead).
-- * rooms UPDATE: sent when the room was live BEFORE the update, so the end_room (deleted_at) and
--   expiry transitions still reach the members whose channel authorization is cached.
-- * rooms INSERT and every child table: sent only while the room row exists, is not deleted and
--   has not expired. During a cascade the parent row is already gone, so nothing is sent.

create or replace function private.broadcast_room_change()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_room uuid;
begin
  if tg_table_name = 'rooms' then
    if tg_op = 'DELETE' then
      return null;
    end if;
    v_row := to_jsonb(new);
    v_room := new.id;
    if tg_op = 'UPDATE' and not (old.deleted_at is null and old.expires_at > now()) then
      return null;
    end if;
    if tg_op = 'INSERT' and not (new.deleted_at is null and new.expires_at > now()) then
      return null;
    end if;
  else
    if tg_table_name = 'emergency_acks' then
      -- No room_id column; when the event itself is being deleted (cascade) there is nobody to tell.
      select e.room_id into v_room from public.emergency_events e where e.id = (v_row ->> 'event_id')::uuid;
    else
      v_room := (v_row ->> 'room_id')::uuid;
    end if;
    if v_room is null or not exists (
      select 1 from public.rooms r
      where r.id = v_room and r.deleted_at is null and r.expires_at > now()
    ) then
      return null;
    end if;
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
