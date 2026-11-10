-- Activity chat lines test (Running-crew #3). Requires migrations through 0024 (activity_chat_lines).
-- One transaction, ends with ROLLBACK: leaves no data behind. Run as postgres (Supabase MCP execute_sql).
-- Success ends with the row 'ACTIVITY CHAT LINES TESTS PASSED'.
--
-- Actors: H host, M member, O outsider.

begin;

create schema tests;
grant usage on schema tests to authenticated;

create function tests.login(p_uid uuid, p_anon boolean) returns void language sql as $$
  select set_config('request.jwt.claims',
           json_build_object('sub', p_uid, 'role', 'authenticated', 'is_anonymous', p_anon)::text, true);
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
  ('00000000-0000-0000-0000-000000000000', 'c2400000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'acl-host@test.invalid', false, '{"display_name":"Host"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c2400000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c2400000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', null, true, '{}', now(), now());

create function tests.expect(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then
    raise exception 'FAIL: %', p_label;
  end if;
end;
$$;

-- Line counters, run as postgres (bypasses RLS). t.r is the room id.
create function tests.started() returns text language sql as $$
  select $q$ select 1 from public.messages where room_id = current_setting('t.r')::uuid and kind = 'system'
    and sender_id = 'c2400000-0000-4000-8000-000000000001'
    and body = 'Activity started. Open Map to share your location.' $q$;
$$;
create function tests.ended() returns text language sql as $$
  select $q$ select 1 from public.messages where room_id = current_setting('t.r')::uuid and kind = 'system'
    and sender_id = 'c2400000-0000-4000-8000-000000000001'
    and body = 'Activity ended. Location sharing is off.' $q$;
$$;

-- H creates a sports room with location NOT allowed; M joins.
select tests.login('c2400000-0000-4000-8000-000000000001', false);
set local role authenticated;
do $$
declare r public.rooms;
begin
  r := public.create_room('Activity lines test', 'sports', now() + interval '1 day', false, array['Resting']);
  perform set_config('t.r', r.id::text, true);
  perform set_config('t.token', r.invite_token, true);
end $$;
reset role;
select tests.login('c2400000-0000-4000-8000-000000000002', true);
set local role authenticated;
select public.join_room(null, current_setting('t.token'));
reset role;

-- Refused calls post nothing: location not allowed, member, outsider, unknown state.
select tests.login('c2400000-0000-4000-8000-000000000001', false);
set local role authenticated;
select tests.expect_error($q$ select public.set_activity_state(current_setting('t.r')::uuid, 'active') $q$,
  'start refused while location is not allowed');
reset role;
select tests.expect_count(tests.started(), 0, 'no started line for a refused start');

select tests.login('c2400000-0000-4000-8000-000000000001', false);
set local role authenticated;
select public.set_location_allowed(current_setting('t.r')::uuid, true);
-- Ending an idle room is a no-op: no ended line.
select public.set_activity_state(current_setting('t.r')::uuid, 'ended');
select tests.expect_error($q$ select public.set_activity_state(current_setting('t.r')::uuid, 'paused') $q$,
  'unknown state refused');
-- set_location_allowed(false) while idle: no ended line. Allow again for the rest of the test.
select public.set_location_allowed(current_setting('t.r')::uuid, false);
select public.set_location_allowed(current_setting('t.r')::uuid, true);
reset role;
select tests.expect_count(tests.ended(), 0, 'no ended line for ending an idle room or turning location off while idle');

select tests.login('c2400000-0000-4000-8000-000000000002', true);
set local role authenticated;
select tests.expect_error($q$ select public.set_activity_state(current_setting('t.r')::uuid, 'active') $q$,
  'member cannot start');
reset role;
select tests.login('c2400000-0000-4000-8000-000000000003', true);
set local role authenticated;
select tests.expect_error($q$ select public.set_activity_state(current_setting('t.r')::uuid, 'active') $q$,
  'outsider cannot start');
reset role;
select tests.expect_count($q$ select 1 from public.messages where room_id = current_setting('t.r')::uuid
  and body like 'Activity %' $q$, 0, 'no activity line after refused calls');

-- Start: exactly one started line from the host; a second Start on an active room posts nothing.
select tests.login('c2400000-0000-4000-8000-000000000001', false);
set local role authenticated;
select public.set_activity_state(current_setting('t.r')::uuid, 'active');
select public.set_activity_state(current_setting('t.r')::uuid, 'active');
reset role;
select tests.expect_count(tests.started(), 1, 'one started line for idle -> active, none for active -> active');

-- The member sees the line through RLS; the outsider does not.
select tests.login('c2400000-0000-4000-8000-000000000002', true);
set local role authenticated;
select tests.expect_count(tests.started(), 1, 'member sees the started line');
-- A member still cannot post a system line directly.
select tests.expect_error($q$ insert into public.messages (room_id, sender_id, kind, body)
  values (current_setting('t.r')::uuid, 'c2400000-0000-4000-8000-000000000002', 'system', 'Activity ended. Location sharing is off.') $q$,
  'member cannot insert a system line');
reset role;
select tests.login('c2400000-0000-4000-8000-000000000003', true);
set local role authenticated;
select tests.expect_count($q$ select 1 from public.messages where room_id = current_setting('t.r')::uuid $q$,
  0, 'outsider sees no lines');
reset role;

-- End: one ended line; a second End posts nothing.
select tests.login('c2400000-0000-4000-8000-000000000001', false);
set local role authenticated;
select public.set_activity_state(current_setting('t.r')::uuid, 'ended');
select public.set_activity_state(current_setting('t.r')::uuid, 'ended');
reset role;
select tests.expect_count(tests.ended(), 1, 'one ended line for active -> ended, none for ended -> ended');

-- Restart from ended posts a second started line; end again posts a second ended line.
select tests.login('c2400000-0000-4000-8000-000000000001', false);
set local role authenticated;
select public.set_activity_state(current_setting('t.r')::uuid, 'active');
select public.set_activity_state(current_setting('t.r')::uuid, 'ended');
reset role;
select tests.expect_count(tests.started(), 2, 'ended -> active posts another started line');
select tests.expect_count(tests.ended(), 2, 'second active -> ended posts another ended line');

-- 0020 behaviour kept: two real starts bumped activity_seq twice; the room ends in 'ended'.
select tests.expect_count($q$ select 1 from public.rooms where id = current_setting('t.r')::uuid
  and activity_state = 'ended' and activity_seq = 2 $q$, 1, 'state and activity_seq as in 0020');

-- set_location_allowed(false): ended room -> no line; active room -> exactly one; already not allowed -> no line.
select tests.login('c2400000-0000-4000-8000-000000000001', false);
set local role authenticated;
select public.set_location_allowed(current_setting('t.r')::uuid, false);
reset role;
select tests.expect_count(tests.ended(), 2, 'location off while ended posts no line');
select tests.login('c2400000-0000-4000-8000-000000000001', false);
set local role authenticated;
select public.set_location_allowed(current_setting('t.r')::uuid, true);
select public.set_activity_state(current_setting('t.r')::uuid, 'active');
select public.set_location_allowed(current_setting('t.r')::uuid, false);
reset role;
select tests.expect_count(tests.started(), 3, 'third start posts a third started line');
select tests.expect_count(tests.ended(), 3, 'location off while active posts exactly one ended line');
select tests.expect((select activity_state = 'ended' and not location_allowed from public.rooms
  where id = current_setting('t.r')::uuid), 'location off while active ends the activity (0020 behaviour)');
select tests.login('c2400000-0000-4000-8000-000000000001', false);
set local role authenticated;
select public.set_location_allowed(current_setting('t.r')::uuid, false);
reset role;
select tests.expect_count(tests.ended(), 3, 'location off when already not allowed posts no line');
select tests.login('c2400000-0000-4000-8000-000000000002', true);
set local role authenticated;
select tests.expect_error($q$ select public.set_location_allowed(current_setting('t.r')::uuid, false) $q$,
  'member cannot change location sharing');
reset role;
select tests.expect_count(tests.ended(), 3, 'refused location change posts no line');

-- Expired room: the host gate refuses and posts nothing.
update public.rooms set created_at = now() - interval '2 days', expires_at = now() - interval '1 second'
 where id = current_setting('t.r')::uuid;
select tests.login('c2400000-0000-4000-8000-000000000001', false);
set local role authenticated;
select tests.expect_error($q$ select public.set_activity_state(current_setting('t.r')::uuid, 'active') $q$,
  'expired room: start refused');
select tests.expect_error($q$ select public.set_location_allowed(current_setting('t.r')::uuid, false) $q$,
  'expired room: location change refused');
reset role;
select tests.expect_count(tests.started(), 3, 'expired room: no new started line');
select tests.expect_count(tests.ended(), 3, 'expired room: no new ended line');

select 'ACTIVITY CHAT LINES TESTS PASSED' as result;

rollback;
