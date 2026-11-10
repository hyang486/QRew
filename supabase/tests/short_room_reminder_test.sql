-- G6b short-room reminder window test. Requires migrations through 0025 (short_room_reminder_window).
-- One transaction, ends with ROLLBACK: leaves no data behind. Run as postgres (Supabase MCP execute_sql).
-- private.send_expiry_reminders(p_now) is called with simulated clock values around each window edge.
-- Success ends with the row 'SHORT ROOM REMINDER TESTS PASSED'.
--
-- Actors: H host, G member (temporary auth.users rows, removed by the ROLLBACK).
-- Rooms (all created at T = now()):
--   S3   3 h room                 -> last hour only (window opens at T+2h)
--   S23  23 h room                -> last hour only (T+22h)
--   S2349 23 h 49 min room        -> last hour only (just under 24 h - 10 min)
--   D2350 23 h 50 min room        -> 24 h window (a "1 day" room created with client clock lag)
--   D30  30 h room                -> 24 h window (T+6h), as in 0019
--   X    3 h room extended to 3 days by the host (new expiry version) -> 24 h window

begin;

create schema tests;

create function tests.expect_eq(p_got bigint, p_n bigint, p_label text) returns void language plpgsql as $$
begin
  if p_got is distinct from p_n then
    raise exception 'FAIL: % (expected %, got %)', p_label, p_n, p_got;
  end if;
end;
$$;

create function tests.reminded(p_room uuid) returns bigint language sql as $$
  select count(*) from public.expiry_reminders where room_id = p_room;
$$;

-- Runs the sender at T + p_offset and returns how many reminders it added for THIS test's rooms. Live rooms
-- in the project may enter their own window at a simulated time (their rows are rolled back too), so the
-- function's global return value is not asserted.
create function tests.run(p_offset interval) returns bigint language plpgsql as $$
declare before bigint; after bigint;
begin
  select count(*) into before from public.expiry_reminders where room_id::text like 'c2510000-%';
  perform private.send_expiry_reminders(now() + p_offset);
  select count(*) into after from public.expiry_reminders where room_id::text like 'c2510000-%';
  return after - before;
end;
$$;

insert into auth.users (instance_id, id, aud, role, email, is_anonymous, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'c2500000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'srr-host@test.invalid', false, '{"display_name":"Host"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c2500000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', null, true, '{}', now(), now());

insert into public.rooms (id, host_id, name, created_at, expires_at, code) values
  ('c2510000-0000-4000-8000-000000000001', 'c2500000-0000-4000-8000-000000000001', 'SRR 3h',     now(), now() + interval '3 hours', '92501'),
  ('c2510000-0000-4000-8000-000000000002', 'c2500000-0000-4000-8000-000000000001', 'SRR 23h',    now(), now() + interval '23 hours', '92502'),
  ('c2510000-0000-4000-8000-000000000003', 'c2500000-0000-4000-8000-000000000001', 'SRR 23h49',  now(), now() + interval '23 hours 49 minutes', '92503'),
  ('c2510000-0000-4000-8000-000000000004', 'c2500000-0000-4000-8000-000000000001', 'SRR 23h50',  now(), now() + interval '23 hours 50 minutes', '92504'),
  ('c2510000-0000-4000-8000-000000000005', 'c2500000-0000-4000-8000-000000000001', 'SRR 30h',    now(), now() + interval '30 hours', '92505'),
  ('c2510000-0000-4000-8000-000000000006', 'c2500000-0000-4000-8000-000000000001', 'SRR extend', now(), now() + interval '3 hours', '92506');

insert into public.room_members (room_id, user_id, role)
select r.id, 'c2500000-0000-4000-8000-000000000001', 'host' from public.rooms r where r.code between '92501' and '92506';
insert into public.room_members (room_id, user_id, role)
  values ('c2510000-0000-4000-8000-000000000001', 'c2500000-0000-4000-8000-000000000002', 'member');

-- 1. Right after creation (T+1s): only the 24-hour rooms that are already inside 24 h (D2350).
--    The 3 h, 23 h and 23 h 49 min rooms are NOT reminded (0019 reminded all of them here).
select tests.expect_eq(tests.run(interval '1 second'), 1, 'T+1s: only the 23h50 room');
select tests.expect_eq(tests.reminded('c2510000-0000-4000-8000-000000000004'), 1, 'D2350 reminded at creation (24 h window)');
select tests.expect_eq(tests.reminded('c2510000-0000-4000-8000-000000000001'), 0, 'S3 not reminded at creation');
select tests.expect_eq(tests.reminded('c2510000-0000-4000-8000-000000000002'), 0, 'S23 not reminded at creation');
select tests.expect_eq(tests.reminded('c2510000-0000-4000-8000-000000000003'), 0, 'S2349 not reminded at creation');
select tests.expect_eq(tests.reminded('c2510000-0000-4000-8000-000000000006'), 0, 'X not reminded at creation');

-- X: the host extends it to 3 days (new version) right after creation. Its length from created_at is now
-- 3 days, so it is a 24 h-window room: reminded at T+2d, not in its old last hour.
update public.rooms set expires_at = now() + interval '3 days', expiry_version = expiry_version + 1
  where id = 'c2510000-0000-4000-8000-000000000006';

-- 2. S3 edges: one minute before its last hour nothing; just inside, host and member once, one broadcast.
select tests.expect_eq(tests.run(interval '2 hours' - interval '1 minute'), 0, 'S3: 1 min before last hour');
select tests.expect_eq(tests.run(interval '2 hours' + interval '1 second'), 2, 'S3: last hour, H and G');
select tests.expect_eq(
  (select count(*) from realtime.messages
    where topic = 'room:c2510000-0000-4000-8000-000000000001' and event = 'expiry_reminders'
      and payload - 'id' = '{"table":"expiry_reminders","op":"INSERT","expiry_version":1}'::jsonb),
  1, 'S3: one broadcast, same payload shape as 0019');
select tests.expect_eq(tests.run(interval '2 hours' + interval '1 second'), 0, 'S3: rerun deduplicated');

-- 3. X was extended before its old last hour (T+2h): nothing then, even though S3 was reminded at T+2h.
select tests.expect_eq(tests.reminded('c2510000-0000-4000-8000-000000000006'), 0, 'X: nothing in its old last hour');

-- 4. 23 h and 23 h 49 min rooms: last hour only.
select tests.expect_eq(tests.run(interval '22 hours' - interval '1 minute'), 1, 'T+22h-1m: only D30 (24 h window since T+6h)');
select tests.expect_eq(tests.reminded('c2510000-0000-4000-8000-000000000005'), 1, 'D30 reminded inside its 24 h window');
select tests.expect_eq(tests.run(interval '22 hours' + interval '1 second'), 1, 'T+22h: S23 enters its last hour');
select tests.expect_eq(tests.reminded('c2510000-0000-4000-8000-000000000002'), 1, 'S23 reminded in its last hour');
select tests.expect_eq(tests.run(interval '22 hours 48 minutes'), 0, 'T+22h48m: S2349 not yet');
select tests.expect_eq(tests.run(interval '22 hours 49 minutes' + interval '1 second'), 1, 'T+22h49m: S2349 enters its last hour');

-- 5. X after the extension: nothing until 24 h before its new end, then once.
select tests.expect_eq(tests.run(interval '2 days' - interval '1 minute'), 0, 'X: before its 24 h window');
select tests.expect_eq(tests.run(interval '2 days' + interval '1 second'), 1, 'X: inside its 24 h window');
select tests.expect_eq(
  (select count(*) from public.expiry_reminders where room_id = 'c2510000-0000-4000-8000-000000000006' and expiry_version = 2),
  1, 'X: reminder for version 2');

-- 6. Grants unchanged: clients still cannot call the function.
select tests.expect_eq(
  (select count(*) from (values ('anon'), ('authenticated')) r(role)
    where has_function_privilege(r.role, 'private.send_expiry_reminders(timestamptz)', 'execute')),
  0, 'anon and authenticated cannot execute send_expiry_reminders');

select 'SHORT ROOM REMINDER TESTS PASSED' as result;

rollback;
