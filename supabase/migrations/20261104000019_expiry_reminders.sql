-- 24-hour expiry reminder (APP_CONCEPT_KO "방 만료 1일 전 알림").
--
-- private.send_expiry_reminders(p_now) records one reminder per (room, current member, expiry_version)
-- for every live room whose expiry is within 24 hours, and tells each affected room over its private
-- Broadcast topic so open clients can show the reminder in the app. The broadcast carries only
-- {table, op, expiry_version} (no user ids, same shape as the S1 change signals); each client reads
-- its own row through expiry_reminders_select_own.
--
-- * Recipients: current room_members rows (host included). People who left have no row; a deleted or
--   expired room is skipped. A late joiner (< 24 h left) gets a reminder on the next run.
-- * Dedupe: the primary key (room_id, user_id, expiry_version) makes reruns no-ops. Changing the expiry
--   bumps rooms.expiry_version (update_room_expiry), so the new time gets its own reminder once it is
--   within 24 hours; reminders for older versions are never re-sent.
-- * Delivery: there is no remote push this milestone (no paid Apple account; USER_DECISIONS
--   notifications). Rows are stored as status 'no_token' with detail {"channel": "in_app"} so they
--   are never mistaken for a delivered push. Clients also schedule a local notification themselves.
-- * Scheduling (pure-SQL pg_cron job 'expiry-reminders', every 5 minutes) is a separate, human-approved step; it is not in this file.

create or replace function private.send_expiry_reminders(p_now timestamptz default now())
returns integer language plpgsql security definer
set search_path = ''
as $$
declare
  v_total integer := 0;
  v_room record;
begin
  for v_room in
    with due as (
      select r.id, r.expiry_version, r.expires_at
      from public.rooms r
      where r.deleted_at is null
        and r.expires_at > p_now
        and r.expires_at <= p_now + interval '24 hours'
    ),
    inserted as (
      insert into public.expiry_reminders (room_id, user_id, expiry_version, status, sent_at, detail)
      select d.id, m.user_id, d.expiry_version, 'no_token', p_now,
             jsonb_build_object('channel', 'in_app', 'expires_at', d.expires_at)
      from due d
      join public.room_members m on m.room_id = d.id
      on conflict (room_id, user_id, expiry_version) do nothing
      returning room_id, user_id, expiry_version
    )
    select i.room_id, i.expiry_version, count(*) as n
    from inserted i
    group by i.room_id, i.expiry_version
  loop
    v_total := v_total + v_room.n;
    perform realtime.send(
      jsonb_build_object('table', 'expiry_reminders', 'op', 'INSERT',
                         'expiry_version', v_room.expiry_version),
      'expiry_reminders',
      'room:' || v_room.room_id::text,
      true
    );
  end loop;
  return v_total;
end;
$$;
revoke all on function private.send_expiry_reminders(timestamptz) from public, anon, authenticated;

-- Members may read their own reminder rows for rooms they can still access (e.g. to show
-- "reminder sent" state); the table stays write-protected for clients.
create policy expiry_reminders_select_own on public.expiry_reminders for select to authenticated
  using (user_id = (select auth.uid()) and private.is_room_member(room_id));
grant select on public.expiry_reminders to authenticated;
