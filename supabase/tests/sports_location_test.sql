-- Sports location/route test. Requires migrations through 0020 (sports_location).
-- One transaction, ends with ROLLBACK: leaves no data behind. Run as postgres (Supabase MCP execute_sql).
-- Success ends with the row 'SPORTS LOCATION TESTS PASSED'.
--
-- Actors: H host, G member who opts in, N member who never opts in, O outsider, L member who leaves.

begin;

create schema tests;
grant usage on schema tests to authenticated;

create function tests.login(p_uid uuid, p_anon boolean) returns void language sql as $$
  select set_config('request.jwt.claims',
           json_build_object('sub', p_uid, 'role', 'authenticated', 'is_anonymous', p_anon)::text, true);
$$;

create function tests.expect(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then
    raise exception 'FAIL: %', p_label;
  end if;
end;
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

create function tests.expect_sqlstate(p_sql text, p_state text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_state then
      return;
    end if;
    raise exception 'FAIL: % (expected SQLSTATE %, got %: %)', p_label, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: % (statement succeeded but should have failed)', p_label;
end;
$$;

grant execute on all functions in schema tests to authenticated;

insert into auth.users (instance_id, id, aud, role, email, is_anonymous, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'c0000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'sl-host@test.invalid', false, '{"display_name":"Host"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c0000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c0000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c0000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c0000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', null, true, '{}', now(), now());

-- Shorthands (set_config is transaction-local): t.r room, t.token invite token.
-- H creates a sports room with location NOT allowed; G, N and L join.
select tests.login('c0000000-0000-4000-8000-000000000001', false);
set local role authenticated;
do $$
declare r public.rooms;
begin
  r := public.create_room('Sports test', 'sports', now() + interval '1 day', false, array['Resting']);
  perform set_config('t.r', r.id::text, true);
  perform set_config('t.token', r.invite_token, true);
end $$;
reset role;

select tests.login('c0000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select public.join_room(null, current_setting('t.token'));
-- Location not allowed: opting in is refused, reporting is refused.
select tests.expect_error($q$ select public.set_share_location(current_setting('t.r')::uuid, true) $q$,
  'opt-in refused while the host has not allowed location');
select tests.expect(not public.report_location(current_setting('t.r')::uuid, 37.0, -122.0, 2.0, 5.0, 0.0),
  'report refused while location is not allowed');
reset role;

select tests.login('c0000000-0000-4000-8000-000000000003', true);
set local role authenticated;
select public.join_room(null, current_setting('t.token'));
reset role;
select tests.login('c0000000-0000-4000-8000-000000000005', true);
set local role authenticated;
select public.join_room(null, current_setting('t.token'));
reset role;

-- Only the host changes location_allowed, starts the activity and edits the route.
select tests.login('c0000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select tests.expect_error($q$ select public.set_location_allowed(current_setting('t.r')::uuid, true) $q$,
  'member cannot allow location');
reset role;
select tests.login('c0000000-0000-4000-8000-000000000001', false);
set local role authenticated;
select tests.expect_error($q$ select public.set_activity_state(current_setting('t.r')::uuid, 'active') $q$,
  'activity cannot start while location is not allowed');
select public.set_location_allowed(current_setting('t.r')::uuid, true);
reset role;
select tests.expect((select location_allowed from public.rooms where id = current_setting('t.r')::uuid),
  'host allowed location');

-- Opted in but activity idle: no position stored.
select tests.login('c0000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select public.set_share_location(current_setting('t.r')::uuid, true);
select tests.expect(not public.report_location(current_setting('t.r')::uuid, 37.0, -122.0, 2.0, 5.0, 0.0),
  'report refused while the activity is idle');
reset role;
select tests.login('c0000000-0000-4000-8000-000000000005', true);
set local role authenticated;
select public.set_share_location(current_setting('t.r')::uuid, true);
reset role;
select tests.expect_count($q$ select 1 from public.live_presence where room_id = current_setting('t.r')::uuid $q$,
  0, 'nothing stored before the activity starts');

-- Host starts the activity.
select tests.login('c0000000-0000-4000-8000-000000000001', false);
set local role authenticated;
select public.set_activity_state(current_setting('t.r')::uuid, 'active');
reset role;

-- G (opted in) reports; negative speed is stored as unknown.
select tests.login('c0000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select tests.expect(public.report_location(current_setting('t.r')::uuid, 37.33, -122.03, -1.0, 5.0, 90.0),
  'opted-in member reports during the activity');
select tests.expect(public.report_location(current_setting('t.r')::uuid, 37.331, -122.031, 3.2, 5.0, 90.0),
  'second report updates the latest point');
reset role;
select tests.expect_count($q$ select 1 from public.live_presence where room_id = current_setting('t.r')::uuid
  and user_id = 'c0000000-0000-4000-8000-000000000002' and lat = 37.331 and speed_mps = 3.2 $q$,
  1, 'only the latest point is kept (no history)');

-- L (opted in) reports, then leaves: the position goes with the membership.
select tests.login('c0000000-0000-4000-8000-000000000005', true);
set local role authenticated;
select tests.expect(public.report_location(current_setting('t.r')::uuid, 37.2, -122.2, 1.0, 5.0, 0.0),
  'L reports');
select public.leave_room(current_setting('t.r')::uuid);
select tests.expect(not public.report_location(current_setting('t.r')::uuid, 37.2, -122.2, 1.0, 5.0, 0.0),
  'a member who left cannot report');
reset role;
select tests.expect_count($q$ select 1 from public.live_presence where room_id = current_setting('t.r')::uuid
  and user_id = 'c0000000-0000-4000-8000-000000000005' $q$, 0, 'leaving deletes the position');

-- N (never opted in) cannot report; N can see G's position as a member.
select tests.login('c0000000-0000-4000-8000-000000000003', true);
set local role authenticated;
select tests.expect(not public.report_location(current_setting('t.r')::uuid, 37.0, -122.0, 1.0, 5.0, 0.0),
  'member who did not opt in cannot report');
select tests.expect_count($q$ select 1 from public.live_presence where room_id = current_setting('t.r')::uuid $q$,
  1, 'member sees the shared position');
select tests.expect_error($q$ insert into public.live_presence (room_id, user_id, lat, lng)
  values (current_setting('t.r')::uuid, 'c0000000-0000-4000-8000-000000000003', 1, 1) $q$,
  'no direct insert into live_presence');
reset role;

-- O (outsider) cannot report, opt in or read.
select tests.login('c0000000-0000-4000-8000-000000000004', true);
set local role authenticated;
select tests.expect(not public.report_location(current_setting('t.r')::uuid, 37.0, -122.0, 1.0, 5.0, 0.0),
  'outsider cannot report');
select tests.expect_error($q$ select public.set_share_location(current_setting('t.r')::uuid, true) $q$,
  'outsider cannot opt in');
select tests.expect_count($q$ select 1 from public.live_presence where room_id = current_setting('t.r')::uuid $q$,
  0, 'outsider sees no positions');
select tests.expect_count($q$ select 1 from public.live_presence $q$, 0, 'outsider sees no positions anywhere');
reset role;

-- Route: host only; points validated and normalized.
select tests.login('c0000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select tests.expect_error($q$ select public.set_route(current_setting('t.r')::uuid, '[{"lat":1,"lng":2}]') $q$,
  'member cannot edit the route');
reset role;
select tests.login('c0000000-0000-4000-8000-000000000001', false);
set local role authenticated;
select tests.expect_error($q$ select public.set_route(current_setting('t.r')::uuid, '[{"lat":91,"lng":2}]') $q$,
  'latitude out of range');
select tests.expect_error($q$ select public.set_route(current_setting('t.r')::uuid, '[{"lat":"1","lng":2}]') $q$,
  'string coordinate');
select tests.expect_error($q$ select public.set_route(current_setting('t.r')::uuid, '[[1,2]]') $q$,
  'point that is not an object');
select tests.expect_error($q$ select public.set_route(current_setting('t.r')::uuid, '{"lat":1}') $q$,
  'route that is not an array');
select tests.expect_error($q$ select public.set_route(current_setting('t.r')::uuid,
  (select jsonb_agg(jsonb_build_object('lat', 1, 'lng', 1)) from generate_series(1, 2001))) $q$,
  'more than 2000 points');
select public.set_route(current_setting('t.r')::uuid,
  '[{"lat":37.1,"lng":-122.1,"x":"drop"},{"lat":37.2,"lng":-122.2}]');
reset role;
select tests.expect((select route from public.rooms where id = current_setting('t.r')::uuid)
  = '[{"lat":37.1,"lng":-122.1},{"lat":37.2,"lng":-122.2}]'::jsonb, 'route stored in order, extra keys dropped');

-- Host ends the activity: positions deleted, consent cleared, reports refused, reads empty.
select tests.login('c0000000-0000-4000-8000-000000000001', false);
set local role authenticated;
select public.set_activity_state(current_setting('t.r')::uuid, 'ended');
reset role;
select tests.expect_count($q$ select 1 from public.live_presence where room_id = current_setting('t.r')::uuid $q$,
  0, 'ending the activity deletes positions');
select tests.expect_count($q$ select 1 from public.room_members where room_id = current_setting('t.r')::uuid
  and share_location $q$, 0, 'ending the activity clears every opt-in');

-- L2: a report that raced the end (inserted after its delete) must not reappear on restart.
insert into public.live_presence (room_id, user_id, lat, lng)
values (current_setting('t.r')::uuid, 'c0000000-0000-4000-8000-000000000002', 1, 1);

-- Restart: consent does not carry over.
select tests.login('c0000000-0000-4000-8000-000000000001', false);
set local role authenticated;
select public.set_activity_state(current_setting('t.r')::uuid, 'active');
reset role;
select tests.expect_count($q$ select 1 from public.live_presence where room_id = current_setting('t.r')::uuid $q$,
  0, 'starting an activity deletes a position left by a race with the previous end');
select tests.login('c0000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select tests.expect(not public.report_location(current_setting('t.r')::uuid, 37.0, -122.0, 1.0, 5.0, 0.0),
  'restarted activity: previous consent does not carry over');
select public.set_share_location(current_setting('t.r')::uuid, true);
select tests.expect(public.report_location(current_setting('t.r')::uuid, 37.0, -122.0, 1.0, 5.0, 0.0),
  'G opts in again and reports');
-- Opting out deletes the position immediately.
select public.set_share_location(current_setting('t.r')::uuid, false);
select tests.expect_count($q$ select 1 from public.live_presence where room_id = current_setting('t.r')::uuid $q$,
  0, 'opt-out deletes my position');
select public.set_share_location(current_setting('t.r')::uuid, true);
select tests.expect(public.report_location(current_setting('t.r')::uuid, 37.0, -122.0, 1.0, 5.0, 0.0),
  'G reports again');

-- L3: invalid coordinates raise 22023; non-finite or out-of-range extras are stored as unknown.
select tests.expect_sqlstate($q$ select public.report_location(current_setting('t.r')::uuid, 91, 0) $q$,
  '22023', 'latitude out of range');
select tests.expect_sqlstate($q$ select public.report_location(current_setting('t.r')::uuid, 0, -180.5) $q$,
  '22023', 'longitude out of range');
select tests.expect_sqlstate($q$ select public.report_location(current_setting('t.r')::uuid, 'NaN', 0) $q$,
  '22023', 'NaN latitude');
select tests.expect_sqlstate($q$ select public.report_location(current_setting('t.r')::uuid, 0, 'Infinity') $q$,
  '22023', 'infinite longitude');
select tests.expect_sqlstate($q$ select public.report_location(current_setting('t.r')::uuid, null, 0) $q$,
  '22023', 'null latitude');
select tests.expect(public.report_location(current_setting('t.r')::uuid, 37.5, -122.5, 'NaN', 'Infinity', 400),
  'report with non-finite extras is accepted');
reset role;
select tests.expect_count($q$ select 1 from public.live_presence where room_id = current_setting('t.r')::uuid
  and user_id = 'c0000000-0000-4000-8000-000000000002' and lat = 37.5
  and speed_mps is null and accuracy_m is null and heading is null $q$, 1, 'non-finite extras stored as unknown');
select tests.login('c0000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select tests.expect(public.report_location(current_setting('t.r')::uuid, 37.5, -122.5, 'Infinity', -3, 360),
  'report with infinite speed, negative accuracy, heading 360');
reset role;
select tests.expect_count($q$ select 1 from public.live_presence where room_id = current_setting('t.r')::uuid
  and user_id = 'c0000000-0000-4000-8000-000000000002'
  and speed_mps is null and accuracy_m is null and heading is null $q$, 1, 'out-of-range extras stored as unknown');

-- L1: stop_my_location (sign-out, permission lost) clears my opt-in and position in every room.
select tests.login('c0000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select public.stop_my_location();
reset role;
select tests.expect_count($q$ select 1 from public.live_presence where user_id = 'c0000000-0000-4000-8000-000000000002' $q$,
  0, 'stop_my_location deletes my positions');
select tests.expect_count($q$ select 1 from public.room_members where user_id = 'c0000000-0000-4000-8000-000000000002' and share_location $q$,
  0, 'stop_my_location clears my opt-ins');
select tests.login('c0000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select tests.expect(not public.report_location(current_setting('t.r')::uuid, 37.0, -122.0, 1.0, 5.0, 0.0),
  'after stop_my_location, reports are refused');
select public.set_share_location(current_setting('t.r')::uuid, true);
select tests.expect(public.report_location(current_setting('t.r')::uuid, 37.0, -122.0, 1.0, 5.0, 0.0),
  'G opts in again after stop_my_location and reports');
reset role;
select tests.expect(not has_function_privilege('anon', 'public.stop_my_location()', 'execute'),
  'anon cannot call stop_my_location');

-- Host turns location off: activity ended, positions deleted, consent cleared.
select tests.login('c0000000-0000-4000-8000-000000000001', false);
set local role authenticated;
select public.set_location_allowed(current_setting('t.r')::uuid, false);
reset role;
select tests.expect((select activity_state = 'ended' and not location_allowed from public.rooms
  where id = current_setting('t.r')::uuid), 'disallowing location ends the activity');
select tests.expect_count($q$ select 1 from public.live_presence where room_id = current_setting('t.r')::uuid $q$,
  0, 'disallowing location deletes positions');
select tests.expect_count($q$ select 1 from public.room_members where room_id = current_setting('t.r')::uuid
  and share_location $q$, 0, 'disallowing location clears every opt-in');

-- Expired room (not yet cleaned up): no reports, no reads, no host changes.
select tests.login('c0000000-0000-4000-8000-000000000001', false);
set local role authenticated;
select public.set_location_allowed(current_setting('t.r')::uuid, true);
select public.set_activity_state(current_setting('t.r')::uuid, 'active');
reset role;
select tests.login('c0000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select public.set_share_location(current_setting('t.r')::uuid, true);
select tests.expect(public.report_location(current_setting('t.r')::uuid, 37.0, -122.0, 1.0, 5.0, 0.0),
  'G reports before expiry');
reset role;
update public.rooms set created_at = now() - interval '2 days', expires_at = now() - interval '1 second'
 where id = current_setting('t.r')::uuid;
select tests.login('c0000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select tests.expect_count($q$ select 1 from public.live_presence where room_id = current_setting('t.r')::uuid $q$,
  0, 'expired room: positions not readable');
select tests.expect(not public.report_location(current_setting('t.r')::uuid, 37.0, -122.0, 1.0, 5.0, 0.0),
  'expired room: report refused');
reset role;
select tests.expect_count($q$ select 1 from public.live_presence where room_id = current_setting('t.r')::uuid $q$,
  0, 'expired room: the refused report also removed the stale row');
select tests.login('c0000000-0000-4000-8000-000000000001', false);
set local role authenticated;
select tests.expect_error($q$ select public.set_route(current_setting('t.r')::uuid, '[]') $q$,
  'expired room: route edit refused');
select tests.expect_error($q$ select public.set_location_allowed(current_setting('t.r')::uuid, false) $q$,
  'expired room: location setting refused');
reset role;

select 'SPORTS LOCATION TESTS PASSED' as result;

rollback;
