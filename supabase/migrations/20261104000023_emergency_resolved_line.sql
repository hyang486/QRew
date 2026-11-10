-- Running-crew #4: ending an Emergency posts a resolution line in chat.
-- NOT APPLIED. Apply only after explicit sign-off (see docs/CURRENT_STATE.md).
--
-- Before: "I'm OK" (clear_my_status) only deleted the caller's member_status row, and switching from Emergency
-- to another status (set_my_status) posted only "<name>: <label>". Either way the Emergency card disappeared
-- while the last chat event stayed "<name> needs help (Emergency)" for everyone.
-- After: when the caller's Emergency ends, one 'status' message "<name> is OK (Emergency resolved)" is posted
-- from the caller:
--   clear_my_status: the cleared status was the room's Emergency status.
--   set_my_status:   the previous status was Emergency and the new one is not; its one status line reads
--                    "<name> is OK (Emergency resolved) · <label>" instead of "<name>: <label>".
--                    Emergency → Emergency is unchanged (a new event).
-- Anything else behaves as before.
--
-- clear_my_status posts only while private.is_room_member (current member of a room that is open: not
-- deleted, not expired), the same gate set_my_status already has. Its delete stays ungated as before: it only
-- touches the caller's own row, so an expired room or a former member can still clear it, silently.
--
-- Function replacements only: same names, arguments and return types, so the grants from 0002 (execute to
-- authenticated, revoked from public and anon) carry over. No table, RLS, publication or Edge Function
-- change. security definer with search_path '' as before.

create or replace function public.clear_my_status(p_room_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_status uuid;
  v_name text;
begin
  delete from public.member_status
   where room_id = p_room_id and user_id = auth.uid()
  returning status_id into v_status;

  if v_status is not null
     and private.is_room_member(p_room_id)
     and exists (select 1 from public.status_definitions d
                  where d.id = v_status and d.room_id = p_room_id and d.is_emergency) then
    select coalesce(display_name, 'Someone') into v_name from public.profiles where id = auth.uid();
    insert into public.messages (room_id, sender_id, kind, body)
    values (p_room_id, auth.uid(), 'status', coalesce(v_name, 'Someone') || ' is OK (Emergency resolved)');
  end if;
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
  v_was_emergency boolean;
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

  -- The previous status, read before the upsert replaces it.
  select coalesce(d.is_emergency, false) into v_was_emergency
    from public.member_status s
    join public.status_definitions d on d.id = s.status_id and d.room_id = s.room_id
   where s.room_id = p_room_id and s.user_id = auth.uid();

  insert into public.member_status (room_id, user_id, status_id, updated_at)
  values (p_room_id, auth.uid(), p_status_id, now())
  on conflict (room_id, user_id) do update set status_id = excluded.status_id, updated_at = now();

  if v_def.is_emergency then
    insert into public.emergency_events (room_id, user_id) values (p_room_id, auth.uid())
    returning id into v_event;
    insert into public.messages (room_id, sender_id, kind, body)
    values (p_room_id, auth.uid(), 'emergency', coalesce(v_name, 'Someone') || ' needs help (Emergency)');
  else
    -- One line either way: two rows in one transaction share created_at (the 0011 trigger sets now()), and
    -- chat breaks that tie by random id, so a separate resolved line could show after the status line.
    insert into public.messages (room_id, sender_id, kind, body)
    values (p_room_id, auth.uid(), 'status',
            case when coalesce(v_was_emergency, false)
                 then coalesce(v_name, 'Someone') || ' is OK (Emergency resolved) · ' || v_def.label
                 else coalesce(v_name, 'Someone') || ': ' || v_def.label end);
  end if;
  return v_event;
end;
$$;
