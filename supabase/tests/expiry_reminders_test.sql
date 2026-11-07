-- 24-hour expiry reminder test. Requires migrations through 0019 (expiry_reminders).
-- One transaction, ends with ROLLBACK: leaves no data behind. Run as postgres (Supabase MCP execute_sql).
-- Near-threshold check without waiting a day: private.send_expiry_reminders(p_now) is called with
-- simulated clock values on both sides of the 24-hour mark.
-- Success ends with the row 'EXPIRY REMINDER TESTS PASSED'.
--
-- Actors: H host, G member, L member who left, J late joiner, O outsider.
-- Rooms: R1 live (expires now()+30h), R2 ended (deleted_at set), R3 already expired at the simulated time.

begin;

create schema tests;
grant usage on schema tests to authenticated;

create function tests.login(p_uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
           json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
$$;

create function tests.expect_count(p_sql text, p_n bigint, p_label text) returns void language plpgsql as $$
declare v bigint;
begin
  execute 'select count(*) from (' || p_sql || ') s' into v;
  if v is distinct from p_n then
    raise exception 'FAIL: % (expected %, got %)', p_label, p_n, v;
  end if;
end;
$$;

create function tests.expect_eq(p_got bigint, p_n bigint, p_label text) returns void language plpgsql as $$
begin
  if p_got is distinct from p_n then
    raise exception 'FAIL: % (expected %, got %)', p_label, p_n, p_got;
  end if;
end;
$$;

create function tests.expect_error(p_sql text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    return;
  end;
  raise exception 'FAIL: % (statement succeeded but should have failed)', p_label;
end;
$$;

grant execute on all functions in schema tests to authenticated;

insert into auth.users (instance_id, id, aud, role, email, is_anonymous, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'c0000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'er-host@test.invalid', false, '{"display_name":"Host"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c0000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c0000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c0000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c0000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', null, true, '{}', now(), now());

insert into public.rooms (id, host_id, name, expires_at, code) values
  ('c1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'ER live', now() + interval '30 hours', '90001'),
  ('c1000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001', 'ER ended', now() + interval '30 hours', '90002'),
  ('c1000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000001', 'ER short', now() + interval '1 hour', '90003');
update public.rooms set deleted_at = now() where id = 'c1000000-0000-4000-8000-000000000002';

insert into public.room_members (room_id, user_id, role) values
  ('c1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'host'),
  ('c1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'member'),
  ('c1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000003', 'member'),
  ('c1000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001', 'host'),
  ('c1000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002', 'member'),
  ('c1000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000001', 'host');
-- L leaves R1 before the reminder window.
delete from public.room_members
  where room_id = 'c1000000-0000-4000-8000-000000000001' and user_id = 'c0000000-0000-4000-8000-000000000003';

-- Simulated clocks. R1 expires at T+30h, so its reminder window opens at T+6h.
select set_config('t.before', (now() + interval '6 hours' - interval '1 minute')::text, true),
       set_config('t.after',  (now() + interval '6 hours' + interval '1 second')::text, true),
       set_config('t.v2before', (now() + interval '8 hours' - interval '1 minute')::text, true),
       set_config('t.v2after',  (now() + interval '8 hours' + interval '1 second')::text, true);

-- 1. One minute before the window: nothing for R1. R3 (1h left) is already expired at that simulated
--    time, and R2 is ended, so the whole run inserts nothing.
select tests.expect_eq(private.send_expiry_reminders(current_setting('t.before')::timestamptz), 0, 'before window: 0 reminders');

-- 2. Just inside the window: host and current member, not the member who left; ended room skipped.
select tests.expect_eq(private.send_expiry_reminders(current_setting('t.after')::timestamptz), 2, 'inside window: 2 reminders');
select tests.expect_count($q$ select 1 from public.expiry_reminders
  where room_id = 'c1000000-0000-4000-8000-000000000001' and expiry_version = 1
    and user_id in ('c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002')
    and status = 'no_token' and detail ->> 'channel' = 'in_app' $q$, 2, 'R1 v1: H and G, stored as in-app only');
select tests.expect_count($q$ select 1 from public.expiry_reminders where user_id = 'c0000000-0000-4000-8000-000000000003' $q$, 0, 'left member L: none');
select tests.expect_count($q$ select 1 from public.expiry_reminders where room_id = 'c1000000-0000-4000-8000-000000000002' $q$, 0, 'ended room R2: none');
select tests.expect_count($q$ select 1 from public.expiry_reminders where room_id = 'c1000000-0000-4000-8000-000000000003' $q$, 0, 'expired room R3: none');
select tests.expect_count($q$ select 1 from realtime.messages
  where topic = 'room:c1000000-0000-4000-8000-000000000001' and event = 'expiry_reminders'
    and payload - 'id' = '{"table":"expiry_reminders","op":"INSERT","expiry_version":1}'::jsonb $q$, 1, 'one R1 broadcast, no user ids');
select tests.expect_count($q$ select 1 from realtime.messages
  where topic in ('room:c1000000-0000-4000-8000-000000000002', 'room:c1000000-0000-4000-8000-000000000003')
    and event = 'expiry_reminders' $q$, 0, 'no broadcast for R2/R3');

-- 3. Rerun: deduplicated, no new broadcast.
select tests.expect_eq(private.send_expiry_reminders(current_setting('t.after')::timestamptz), 0, 'rerun: 0 reminders');
select tests.expect_count($q$ select 1 from realtime.messages
  where topic = 'room:c1000000-0000-4000-8000-000000000001' and event = 'expiry_reminders' $q$, 1, 'rerun: still one broadcast');

-- 4. Late joiner J (< 24h left) gets a reminder on the next run; earlier recipients do not repeat.
insert into public.room_members (room_id, user_id, role)
  values ('c1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000004', 'member');
select tests.expect_eq(private.send_expiry_reminders(current_setting('t.after')::timestamptz), 1, 'late joiner: 1 reminder');
select tests.expect_count($q$ select 1 from realtime.messages
  where topic = 'room:c1000000-0000-4000-8000-000000000001' and event = 'expiry_reminders'
    and not (payload ? 'user_ids') $q$, 2, 'late joiner: one more broadcast, no user ids');

-- 5. Host moves the expiry 2h later: new version, nothing until the new window, then everyone once.
update public.rooms set expires_at = expires_at + interval '2 hours', expiry_version = expiry_version + 1
  where id = 'c1000000-0000-4000-8000-000000000001';
select tests.expect_eq(private.send_expiry_reminders(current_setting('t.v2before')::timestamptz), 0, 'v2 before its window: 0');
select tests.expect_eq(private.send_expiry_reminders(current_setting('t.v2after')::timestamptz), 3, 'v2 inside window: H, G, J');
select tests.expect_count($q$ select 1 from public.expiry_reminders
  where room_id = 'c1000000-0000-4000-8000-000000000001' and expiry_version = 2 $q$, 3, 'v2 rows');
select tests.expect_eq(private.send_expiry_reminders(current_setting('t.v2after')::timestamptz), 0, 'v2 rerun: 0');

-- 6. Client access: own rows only, for live rooms; no writes; the sender is not callable.
set local role authenticated;
select tests.login('c0000000-0000-4000-8000-000000000002');
select tests.expect_count($q$ select 1 from public.expiry_reminders $q$, 2, 'G sees own v1 and v2 rows');
select tests.expect_count($q$ select 1 from public.expiry_reminders where user_id <> 'c0000000-0000-4000-8000-000000000002' $q$, 0, 'G sees no one else');
select tests.expect_error($q$ insert into public.expiry_reminders (room_id, user_id, expiry_version)
  values ('c1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 9) $q$, 'G cannot insert');
select tests.expect_error($q$ update public.expiry_reminders set status = 'sent' $q$, 'G cannot update');
select tests.expect_error($q$ select private.send_expiry_reminders() $q$, 'G cannot run the sender');
select tests.login('c0000000-0000-4000-8000-000000000005');
select tests.expect_count($q$ select 1 from public.expiry_reminders $q$, 0, 'outsider O sees none');
select tests.login('c0000000-0000-4000-8000-000000000003');
select tests.expect_count($q$ select 1 from public.expiry_reminders $q$, 0, 'left member L sees none');
reset role;

select 'EXPIRY REMINDER TESTS PASSED' as result;

rollback;
