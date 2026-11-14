-- UI v2 bug 1 (follow-up to 0025): a "1 day" room is reminded only in its last hour, like the in-room banner
-- (mobile/src/lib/expiry-plan.ts endsSoonWindowMs since 209e80c: length < REMINDER_WINDOW_MS + SHORT_ROOM_MARGIN_MS).
--
-- * A room with expires_at - created_at < 24 h + 10 min is reminded only in its last hour. This covers a
--   "1 day" room whether its length comes out a little under or a little over 24 h (client/server clock skew).
-- * Any longer room keeps the 24-hour reminder.
-- 0025 used < 24 h - 10 min, so a 1-day room was reminded on the first run after it was created.
--
-- Only the threshold changes. Unchanged from 0025: recipients, the (room_id, user_id, expiry_version) dedupe,
-- the in-app-only status, the broadcast payload and the grants. Rooms already reminded under 0025 keep their
-- rows; the dedupe means that expiry version is not reminded again in its last hour (no resend).

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
        and r.expires_at <= p_now + case
              when r.expires_at - r.created_at < interval '24 hours' + interval '10 minutes'
                then interval '1 hour'
              else interval '24 hours'
            end
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
