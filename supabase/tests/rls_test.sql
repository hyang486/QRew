-- Re-runnable RLS / RPC permission test (supervisor note P1).
-- Runs entirely inside one transaction and ends with ROLLBACK, so it leaves no data behind.
-- Requires all migrations through messages_server_created_at (20261104000011).
-- Run as the database owner (postgres), e.g. Supabase MCP `execute_sql` with this file's contents,
-- or `psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_test.sql`.
-- Any failed expectation raises `FAIL: <label>` and aborts. Success ends with the row 'RLS TESTS PASSED'.
--
-- Actors: H host account, G anonymous guest, O anonymous outsider (never joins),
--         L anonymous guest who joins then leaves, plus the anon (signed-out) role.
-- Rooms:  R open sports room, X room that expires, Y room the host ends early.

begin;

create schema tests;
grant usage on schema tests to authenticated, anon;

create function tests.login(p_uid uuid, p_anon boolean) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated', 'is_anonymous', p_anon)::text, true);
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

create function tests.expect_ok(p_sql text, p_label text) returns void language plpgsql as $$
begin
  execute p_sql;
exception when others then
  raise exception 'FAIL: % (% %)', p_label, sqlstate, sqlerrm;
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

create function tests.expect_error_like(p_sql text, p_pattern text, p_label text) returns void language plpgsql as $$
declare v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    v_msg := sqlerrm;
  end;
  if v_msg is null then
    raise exception 'FAIL: % (statement succeeded but should have failed)', p_label;
  elsif v_msg not like p_pattern then
    raise exception 'FAIL: % (wrong error: %)', p_label, v_msg;
  end if;
end;
$$;

-- Runs a statement and expects it to fail with the given SQLSTATE.
create function tests.expect_sqlstate(p_sql text, p_state text, p_label text) returns void language plpgsql as $$
declare v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    v_state := sqlstate;
  end;
  if v_state is null then
    raise exception 'FAIL: % (statement succeeded but should have failed)', p_label;
  elsif v_state <> p_state then
    raise exception 'FAIL: % (sqlstate % instead of %)', p_label, v_state, p_state;
  end if;
end;
$$;

-- Runs a single-value query and expects SQL null (no error).
create function tests.expect_null(p_sql text, p_label text) returns void language plpgsql as $$
declare v text;
begin
  execute p_sql into v;
  if v is not null then
    raise exception 'FAIL: % (expected null, got %)', p_label, v;
  end if;
exception when others then
  if sqlerrm like 'FAIL:%' then raise; end if;
  raise exception 'FAIL: % (% %)', p_label, sqlstate, sqlerrm;
end;
$$;

create function tests.expect_affected(p_sql text, p_n bigint, p_label text) returns void language plpgsql as $$
declare v bigint;
begin
  execute p_sql;
  get diagnostics v = row_count;
  if v is distinct from p_n then
    raise exception 'FAIL: % (expected % rows affected, got %)', p_label, p_n, v;
  end if;
end;
$$;

-- Runs a statement inside a read-only transaction state, as PostgREST does for GET /rpc/*.
-- The setting is undone when the enclosing subtransaction aborts.
create function tests.read_only(p_sql text) returns void language plpgsql as $$
begin
  set local transaction_read_only = on;
  execute p_sql;
end;
$$;

-- Simulates the API gateway's request headers (PostgREST exposes them as request.headers).
create function tests.headers(p_json text) returns void language sql as $$
  select set_config('request.headers', p_json, true);
$$;

grant execute on all functions in schema tests to authenticated, anon;

-- Fixed test identities (rolled back at the end).
insert into auth.users (instance_id, id, aud, role, email, is_anonymous, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'rls-host@test.invalid', false, '{"display_name":"Host"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000007', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000008', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000009', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000010', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000011', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000012', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000013', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000014', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000015', 'authenticated', 'authenticated', null, true, '{}', now(), now());

do $$ begin
  if (select count(*) from public.profiles where id::text like 'a0000000-0000-4000-8000-0000000000__') <> 15 then
    raise exception 'FAIL: sign-up trigger did not create 15 profiles';
  end if;
end $$;

-- H creates rooms ------------------------------------------------------------
select tests.login('a0000000-0000-4000-8000-000000000001', false);
set local role authenticated;
do $$
declare r public.rooms;
begin
  r := public.create_room('Sunset Run', 'sports', now() + interval '2 days', true, array['Resting', 'Need water', 'emergency']);
  perform set_config('t.r', r.id::text, true);
  perform set_config('t.r_code', r.code, true);
  perform set_config('t.r_token', r.invite_token, true);
  r := public.create_room('Expiring', 'event', now() + interval '1 hour', false, null);
  perform set_config('t.x', r.id::text, true);
  perform set_config('t.x_code', r.code, true);
  r := public.create_room('Ended early', 'general', now() + interval '1 hour', false, null);
  perform set_config('t.y', r.id::text, true);
  perform set_config('t.y_code', r.code, true);
end $$;
select tests.expect_count($q$ select 1 from public.status_definitions where room_id = current_setting('t.r')::uuid $q$, 3,
  'create_room adds Emergency + 2 custom statuses (duplicate Emergency label ignored)');
select tests.expect_count($q$ select 1 from public.status_definitions where room_id = current_setting('t.r')::uuid and is_emergency $q$, 1,
  'exactly one built-in Emergency status');
select tests.expect_error($q$ insert into public.rooms (host_id, name, expires_at, code) values (auth.uid(), 'direct', now() + interval '1 day', '00001') $q$,
  'rooms cannot be inserted directly, only through create_room');
select tests.expect_error($q$ select public.create_room('Too long', 'general', now() + interval '30 days', false) $q$,
  'expiration beyond 7 days is rejected');
select tests.expect_error($q$ select public.create_room('Bad type', 'party', now() + interval '1 day', false) $q$,
  'unknown room type is rejected');
reset role;

-- G (anonymous guest) --------------------------------------------------------
select tests.login('a0000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select tests.expect_error($q$ select public.create_room('Guest room', 'general', now() + interval '1 day', false) $q$,
  'anonymous guest cannot create a room');
select tests.expect_count($q$ select 1 from public.rooms $q$, 0, 'guest sees no rooms before joining');
select tests.expect_count($q$ select * from public.preview_room(current_setting('t.r_code'), null) where not already_member $q$, 1,
  'guest can preview room by code');
select tests.expect_ok($q$ select public.join_room(null, current_setting('t.r_token')) $q$, 'guest joins R by QR token');
select tests.expect_ok($q$ select public.join_room(current_setting('t.r_code'), null) $q$, 'joining twice is idempotent');
select tests.expect_ok($q$ select public.join_room(current_setting('t.x_code'), null) $q$, 'guest joins X by code');
select tests.expect_ok($q$ select public.join_room(current_setting('t.y_code'), null) $q$, 'guest joins Y by code');
select tests.expect_count($q$ select 1 from public.rooms $q$, 3, 'guest sees the 3 joined rooms');
select tests.expect_count($q$ select 1 from public.room_members where room_id = current_setting('t.r')::uuid $q$, 2,
  'guest sees R members (host + self)');
select tests.expect_count($q$ select 1 from public.room_members where room_id = current_setting('t.r')::uuid and user_id = auth.uid() $q$, 1,
  'joining twice created one membership');
select tests.expect_ok($q$ insert into public.messages (room_id, sender_id, body) values (current_setting('t.r')::uuid, auth.uid(), 'hello') $q$,
  'member can send a text message');
select tests.expect_ok($q$ insert into public.messages (room_id, sender_id, body, created_at) values (current_setting('t.r')::uuid, auth.uid(), 'future', '2099-01-01') $q$,
  'member insert with a client created_at is accepted');
select tests.expect_count($q$ select 1 from public.messages where room_id = current_setting('t.r')::uuid and body = 'future' and created_at = now() $q$, 1,
  'client created_at is replaced with server now() (F7)');
select tests.expect_count($q$ select 1 from public.messages where created_at > now() $q$, 0,
  'no message has a future created_at (F7)');
select tests.expect_error($q$ insert into public.messages (room_id, sender_id, body) values (current_setting('t.r')::uuid, 'a0000000-0000-4000-8000-000000000001', 'spoof') $q$,
  'member cannot send as someone else');
select tests.expect_error($q$ insert into public.messages (room_id, sender_id, kind, body) values (current_setting('t.r')::uuid, auth.uid(), 'system', 'fake system') $q$,
  'member cannot send system messages');
select tests.expect_error($q$ insert into public.messages (room_id, sender_id, kind, body) values (current_setting('t.r')::uuid, auth.uid(), 'emergency', 'fake') $q$,
  'member cannot forge emergency messages directly');
select tests.expect_error($q$ insert into public.messages (room_id, sender_id, body) values (current_setting('t.r')::uuid, auth.uid(), '   ') $q$,
  'blank text message is rejected');
select tests.expect_error($q$ insert into public.messages (room_id, sender_id, body) values (current_setting('t.r')::uuid, auth.uid(), null) $q$,
  'text message without a body is rejected');
select tests.expect_error($q$ insert into public.messages (room_id, sender_id, body) values (current_setting('t.r')::uuid, auth.uid(), repeat('x', 4001)) $q$,
  'text message over 4000 characters is rejected');
select tests.expect_affected($q$ update public.messages set body = 'edited' where room_id = current_setting('t.r')::uuid $q$, 0,
  'member cannot edit messages');
select tests.expect_affected($q$ update public.rooms set name = 'hijack' where id = current_setting('t.r')::uuid $q$, 0,
  'member cannot update the room row');
select tests.expect_affected($q$ delete from public.messages where room_id = current_setting('t.r')::uuid $q$, 0,
  'member cannot delete messages');
select tests.expect_error($q$ select public.set_activity_state(current_setting('t.r')::uuid, 'active') $q$,
  'guest cannot start the activity');
select tests.expect_error($q$ select public.set_route(current_setting('t.r')::uuid, '[]'::jsonb) $q$,
  'guest cannot edit the route');
select tests.expect_error($q$ select public.end_room(current_setting('t.r')::uuid) $q$, 'guest cannot end the room');
select tests.expect_error($q$ select public.rotate_invite(current_setting('t.r')::uuid) $q$, 'guest cannot reissue the invite');
select tests.expect_error($q$ select public.set_status_definitions(current_setting('t.r')::uuid, array['x']) $q$,
  'guest cannot edit statuses');
select tests.expect_error($q$ select 1 from public.cleanup_jobs $q$, 'cleanup_jobs is not readable by clients');
select tests.expect_error($q$ select 1 from public.join_attempts $q$, 'join_attempts is not readable by clients');
select tests.expect_error($q$ select 1 from public.expiry_reminders $q$, 'expiry_reminders is not readable by clients');
select tests.expect_error($q$ insert into public.live_presence (room_id, user_id, lat, lng) values (current_setting('t.r')::uuid, auth.uid(), 1, 1) $q$,
  'live_presence cannot be written directly');
select tests.expect_error($q$ insert into public.arrivals (room_id, user_id) values (current_setting('t.r')::uuid, auth.uid()) $q$,
  'arrivals cannot be written directly');
-- Arrival dedup before any activity (activity_seq 0).
select tests.expect_ok($q$ select public.mark_arrived(current_setting('t.r')::uuid) $q$, 'guest marks arrived');
select tests.expect_ok($q$ select public.mark_arrived(current_setting('t.r')::uuid) $q$, 'repeat arrival tap is accepted');
select tests.expect_count($q$ select 1 from public.arrivals where room_id = current_setting('t.r')::uuid $q$, 1, 'repeat tap does not duplicate arrival');
select tests.expect_count($q$ select 1 from public.messages where room_id = current_setting('t.r')::uuid and kind = 'arrival' $q$, 1,
  'repeat tap does not duplicate the arrival notice');
-- Location is refused until the host starts the activity and the member opts in.
select tests.expect_count($q$ select 1 where public.report_location(current_setting('t.r')::uuid, 37.0, -122.0, 3.0) $q$, 0,
  'location refused: not opted in, activity not started');
select tests.expect_ok($q$ select public.set_share_location(current_setting('t.r')::uuid, true) $q$, 'guest opts in to location');
select tests.expect_count($q$ select 1 where public.report_location(current_setting('t.r')::uuid, 37.0, -122.0, 3.0) $q$, 0,
  'location refused: activity not started');
reset role;

-- H starts the activity --------------------------------------------------------
select tests.login('a0000000-0000-4000-8000-000000000001', false);
set local role authenticated;
select tests.expect_ok($q$ select public.set_activity_state(current_setting('t.r')::uuid, 'active') $q$, 'host starts activity');
select tests.expect_ok($q$ select public.set_route(current_setting('t.r')::uuid, '[{"latitude":37,"longitude":-122}]'::jsonb) $q$, 'host sets route');
select tests.expect_error($q$ select public.set_activity_state(current_setting('t.x')::uuid, 'active') $q$,
  'activity cannot start in a room without location permission');
select tests.expect_count($q$ select 1 from public.profiles where id = 'a0000000-0000-4000-8000-000000000002' $q$, 1,
  'host can see a co-member profile');
select tests.expect_affected($q$ update public.profiles set display_name = 'pwned' where id = 'a0000000-0000-4000-8000-000000000002' $q$, 0,
  'host cannot edit another profile');
select tests.expect_error($q$ select public.leave_room(current_setting('t.r')::uuid) $q$, 'host cannot leave (must end the room)');
reset role;

-- G during the activity --------------------------------------------------------
select tests.login('a0000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select tests.expect_count($q$ select 1 where public.report_location(current_setting('t.r')::uuid, 37.0, -122.0, 3.0) $q$, 1,
  'location accepted when all server conditions hold');
select tests.expect_count($q$ select 1 from public.live_presence where room_id = current_setting('t.r')::uuid $q$, 1, 'presence row stored');
select tests.expect_count($q$ select 1 where public.report_location(current_setting('t.x')::uuid, 37.0, -122.0, 3.0) $q$, 0,
  'location refused in a room without location permission');
select tests.expect_ok($q$ select public.mark_arrived(current_setting('t.r')::uuid) $q$, 'guest marks arrived for the new activity');
select tests.expect_count($q$ select 1 from public.arrivals where room_id = current_setting('t.r')::uuid and user_id = auth.uid() $q$, 2,
  'a new activity allows a new arrival (P2)');
select tests.expect_ok($q$ select public.set_my_status(current_setting('t.r')::uuid,
  (select id from public.status_definitions where room_id = current_setting('t.r')::uuid and is_emergency)) $q$, 'guest raises Emergency');
select tests.expect_count($q$ select 1 from public.emergency_events where room_id = current_setting('t.r')::uuid $q$, 1, 'emergency event recorded');
select tests.expect_error($q$ select public.set_my_status(current_setting('t.r')::uuid,
  (select id from public.status_definitions where room_id = current_setting('t.x')::uuid and is_emergency)) $q$,
  'status from another room is rejected');
select tests.expect_ok($q$ select public.set_share_location(current_setting('t.r')::uuid, false) $q$, 'guest opts out');
select tests.expect_count($q$ select 1 from public.live_presence where room_id = current_setting('t.r')::uuid and user_id = auth.uid() $q$, 0,
  'opting out deletes the stored position');
select tests.expect_ok($q$ select public.set_share_location(current_setting('t.r')::uuid, true) $q$, 'guest opts in again');
select tests.expect_ok($q$ select public.report_location(current_setting('t.r')::uuid, 37.0, -122.0, 3.0) $q$, 'guest reports again');
-- Face enrollment is per room and per member.
select tests.expect_error($q$ select public.enroll_face(current_setting('t.r')::uuid, 'other/path.jpg') $q$,
  'face reference path must be under room/user');
select tests.expect_ok($q$ select public.enroll_face(current_setting('t.r')::uuid,
  current_setting('t.r') || '/' || auth.uid() || '/ref.jpg') $q$, 'guest enrolls a face reference in R');
select tests.expect_count($q$ select 1 from public.face_enrollments $q$, 1, 'guest sees own enrollment');
reset role;

-- H cannot see the guest's face data; host ends the activity -------------------
select tests.login('a0000000-0000-4000-8000-000000000001', false);
set local role authenticated;
select tests.expect_count($q$ select 1 from public.face_enrollments $q$, 0, 'host cannot see guest face enrollment');
select tests.expect_count($q$ select 1 from public.emergency_events where room_id = current_setting('t.r')::uuid $q$, 1, 'host sees the emergency');
select tests.expect_ok($q$ select public.ack_emergency((select id from public.emergency_events where room_id = current_setting('t.r')::uuid)) $q$,
  'host acknowledges the emergency');
select tests.expect_ok($q$ select public.set_activity_state(current_setting('t.r')::uuid, 'ended') $q$, 'host ends the activity');
select tests.expect_count($q$ select 1 from public.live_presence where room_id = current_setting('t.r')::uuid $q$, 0,
  'ending the activity clears all positions');
select set_config('t.y_token', (select invite_token from public.rooms where id = current_setting('t.y')::uuid), true);
select tests.expect_ok($q$ select public.rotate_invite(current_setting('t.y')::uuid) $q$, 'host reissues the invite of room Y');
select set_config('t.y_new_code', (select code from public.rooms where id = current_setting('t.y')::uuid), true);
select set_config('t.y_new_token', (select invite_token from public.rooms where id = current_setting('t.y')::uuid), true);
select tests.expect_count($q$ select 1 from public.rooms where id = current_setting('t.y')::uuid
  and code <> current_setting('t.y_code') and invite_token <> current_setting('t.y_token') $q$, 1,
  'room Y code and token both changed after reissue');
select tests.expect_count($q$ select 1 from public.preview_room(current_setting('t.y_code')) $q$, 0, 'old code no longer previews after reissue');
select tests.expect_count($q$ select 1 from public.preview_room(null, current_setting('t.y_token')) $q$, 0, 'old token no longer previews after reissue');
select tests.expect_null($q$ select public.join_room(null, current_setting('t.y_token')) $q$, 'old token cannot join after reissue');
select tests.expect_null($q$ select public.join_room(current_setting('t.y_code'), null) $q$, 'old code cannot join after reissue');
reset role;
select tests.login('a0000000-0000-4000-8000-000000000006', true);
set local role authenticated;
select tests.expect_count($q$ select 1 from public.preview_room(current_setting('t.y_new_code')) $q$, 1, 'new code previews 1 row');
select tests.expect_count($q$ select 1 from public.preview_room(null, current_setting('t.y_new_token')) $q$, 1, 'new token previews 1 row');
select tests.expect_ok($q$ select public.join_room(current_setting('t.y_new_code'), null) $q$, 'non-member joins room Y with the new code');
reset role;
select tests.login('a0000000-0000-4000-8000-000000000001', false);
set local role authenticated;
select tests.expect_ok($q$ select public.end_room(current_setting('t.y')::uuid) $q$, 'host ends room Y early');
reset role;

-- O (outsider who never joined) ----------------------------------------------
select tests.login('a0000000-0000-4000-8000-000000000003', true);
set local role authenticated;
select tests.expect_count($q$ select 1 from public.rooms $q$, 0, 'outsider sees no rooms');
select tests.expect_count($q$ select 1 from public.messages $q$, 0, 'outsider sees no messages');
select tests.expect_count($q$ select 1 from public.room_members $q$, 0, 'outsider sees no members');
select tests.expect_count($q$ select 1 from public.status_definitions $q$, 0, 'outsider sees no statuses');
select tests.expect_count($q$ select 1 from public.arrivals $q$, 0, 'outsider sees no arrivals');
select tests.expect_count($q$ select 1 from public.live_presence $q$, 0, 'outsider sees no positions');
select tests.expect_count($q$ select 1 from public.emergency_events $q$, 0, 'outsider sees no emergencies');
select tests.expect_count($q$ select 1 from public.emergency_acks $q$, 0, 'outsider sees no acknowledgements');
select tests.expect_count($q$ select 1 from public.media $q$, 0, 'outsider sees no media');
select tests.expect_count($q$ select 1 from public.face_enrollments $q$, 0, 'outsider sees no face data');
select tests.expect_count($q$ select 1 from public.profiles $q$, 1, 'outsider sees only own profile');
select tests.expect_error($q$ insert into public.messages (room_id, sender_id, body) values (current_setting('t.r')::uuid, auth.uid(), 'x') $q$,
  'outsider cannot post');
-- A well-formed path, so the failure comes from RLS and not from the media_integrity path check.
select tests.expect_sqlstate($q$ insert into public.media (id, room_id, uploader_id, kind, original_path, file_name, mime_type)
  values ('c0000000-0000-4000-8000-0000000000aa', current_setting('t.r')::uuid, auth.uid(), 'photo',
          current_setting('t.r') || '/c0000000-0000-4000-8000-0000000000aa/original.jpg', 'a.jpg', 'image/jpeg') $q$,
  '42501', 'outsider cannot add media');
select tests.expect_error($q$ select public.mark_arrived(current_setting('t.r')::uuid) $q$, 'outsider cannot mark arrival');
select tests.expect_count($q$ select 1 where public.report_location(current_setting('t.r')::uuid, 1, 1) $q$, 0, 'outsider location refused');
select tests.expect_error($q$ select public.ack_emergency((select id from public.emergency_events limit 1)) $q$, 'outsider cannot acknowledge');
select tests.expect_count($q$ select * from public.preview_room('99999x', null) $q$, 0, 'invalid code previews nothing');
select tests.expect_null($q$ select public.join_room(null, 'not-a-token') $q$, 'invalid token cannot join');
select tests.expect_null($q$ select public.join_room(current_setting('t.y_code'), null) $q$, 'cannot join a room the host ended');
select tests.expect_count($q$ select 1 from public.room_members where room_id = current_setting('t.y')::uuid and user_id = auth.uid() $q$, 0,
  'failed join adds no membership');
reset role;

-- Storage RLS (room-media, face-refs) ----------------------------------------
-- R is open with H (host) and G (member); O never joined. Requires migration storage_buckets.
select tests.login('a0000000-0000-4000-8000-000000000002', true);
set local role authenticated;
do $$
declare m uuid := gen_random_uuid();
begin
  -- Paths must live under {room_id}/{media_id}/ (migration media_integrity).
  insert into public.media (id, room_id, uploader_id, kind, original_path, file_name, mime_type)
  values (m, current_setting('t.r')::uuid, auth.uid(), 'photo', current_setting('t.r') || '/' || m || '/original.jpg', 'a.jpg', 'image/jpeg');
  perform set_config('t.m', m::text, true);
end $$;
select tests.expect_ok($q$ insert into storage.objects (bucket_id, name, owner_id) values ('room-media',
  current_setting('t.r') || '/' || current_setting('t.m') || '/original.jpg', auth.uid()::text) $q$, 'uploader writes the original for own media row');
select tests.expect_error($q$ insert into storage.objects (bucket_id, name, owner_id) values ('room-media',
  current_setting('t.r') || '/' || gen_random_uuid() || '/original.jpg', auth.uid()::text) $q$, 'cannot upload without a matching media row');
select tests.expect_error($q$ insert into storage.objects (bucket_id, name, owner_id) values ('room-media',
  'not-a-uuid/x/original.jpg', auth.uid()::text) $q$, 'malformed path is rejected');
select tests.expect_ok($q$ insert into storage.objects (bucket_id, name, owner_id) values ('face-refs',
  current_setting('t.r') || '/' || auth.uid() || '/ref.jpg', auth.uid()::text) $q$, 'member writes own face reference');
select tests.expect_error($q$ insert into storage.objects (bucket_id, name, owner_id) values ('face-refs',
  current_setting('t.r') || '/a0000000-0000-4000-8000-000000000001/ref.jpg', auth.uid()::text) $q$, 'cannot write another user''s face reference');
select tests.expect_count($q$ select 1 from storage.objects where bucket_id = 'face-refs' $q$, 1, 'member sees own face reference');
-- Direct deletes are refused (by the storage delete guard or by the absence of a delete policy).
do $$ begin
  begin delete from storage.objects where bucket_id in ('room-media', 'face-refs'); exception when others then null; end;
end $$;
select tests.expect_count($q$ select 1 from storage.objects where bucket_id = 'room-media' $q$, 1, 'client cannot delete room media objects');
select tests.expect_count($q$ select 1 from storage.objects where bucket_id = 'face-refs' $q$, 1, 'client cannot delete face reference objects');
reset role;

select tests.login('a0000000-0000-4000-8000-000000000001', false);
set local role authenticated;
select tests.expect_count($q$ select 1 from storage.objects where bucket_id = 'room-media' $q$, 1, 'host (member) sees room media');
select tests.expect_count($q$ select 1 from storage.objects where bucket_id = 'face-refs' $q$, 0, 'host cannot see guest face reference');
select tests.expect_error($q$ insert into storage.objects (bucket_id, name, owner_id) values ('room-media',
  current_setting('t.r') || '/' || current_setting('t.m') || '/preview.jpg', auth.uid()::text) $q$, 'host cannot write into another member''s media folder');
reset role;

select tests.login('a0000000-0000-4000-8000-000000000003', true);
set local role authenticated;
select tests.expect_count($q$ select 1 from storage.objects where bucket_id in ('room-media', 'face-refs') $q$, 0, 'outsider sees no objects');
reset role;

select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select tests.expect_count($q$ select 1 from storage.objects where bucket_id in ('room-media', 'face-refs') $q$, 0, 'anon sees no objects');
reset role;

-- L joins then leaves --------------------------------------------------------
select tests.login('a0000000-0000-4000-8000-000000000004', true);
set local role authenticated;
select tests.expect_ok($q$ select public.join_room(current_setting('t.r_code'), null) $q$, 'L joins R');
select tests.expect_ok($q$ select public.enroll_face(current_setting('t.r')::uuid, current_setting('t.r') || '/' || auth.uid() || '/ref.jpg') $q$,
  'L enrolls a face reference');
select tests.expect_ok($q$ select public.leave_room(current_setting('t.r')::uuid) $q$, 'L leaves R');
select tests.expect_count($q$ select 1 from public.rooms $q$, 0, 'left member sees no rooms');
select tests.expect_count($q$ select 1 from public.messages $q$, 0, 'left member sees no messages');
select tests.expect_count($q$ select 1 from public.face_enrollments $q$, 0, 'left member face enrollment is gone');
select tests.expect_error($q$ insert into public.messages (room_id, sender_id, body) values (current_setting('t.r')::uuid, auth.uid(), 'x') $q$,
  'left member cannot post');
reset role;

do $$ begin
  if not exists (select 1 from public.cleanup_jobs
                 where bucket = 'face-refs'
                   and prefix = current_setting('t.r') || '/a0000000-0000-4000-8000-000000000004/') then
    raise exception 'FAIL: leaving did not queue face reference cleanup';
  end if;
end $$;

-- X expires (server time passes expires_at) ------------------------------------
update public.rooms set created_at = now() - interval '2 hours', expires_at = now() - interval '1 second'
 where id = current_setting('t.x')::uuid;

select tests.login('a0000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select tests.expect_count($q$ select 1 from public.rooms where id = current_setting('t.x')::uuid $q$, 0, 'expired room is hidden before cleanup');
select tests.expect_count($q$ select 1 from public.messages where room_id = current_setting('t.x')::uuid $q$, 0, 'expired room messages hidden');
select tests.expect_count($q$ select 1 from public.status_definitions where room_id = current_setting('t.x')::uuid $q$, 0, 'expired room statuses hidden');
select tests.expect_error($q$ insert into public.messages (room_id, sender_id, body) values (current_setting('t.x')::uuid, auth.uid(), 'late') $q$,
  'cannot post into an expired room');
select tests.expect_error($q$ select public.mark_arrived(current_setting('t.x')::uuid) $q$, 'cannot mark arrival in an expired room');
select tests.expect_count($q$ select 1 from public.rooms where id = current_setting('t.y')::uuid $q$, 0, 'room ended by host is hidden');
select tests.expect_count($q$ select 1 from public.profiles where id = 'a0000000-0000-4000-8000-000000000001' $q$, 1,
  'profile visible while sharing open room R');
select tests.expect_null($q$ select public.join_room(current_setting('t.x_code'), null) $q$, 'cannot join an expired room');
reset role;

select tests.login('a0000000-0000-4000-8000-000000000001', false);
set local role authenticated;
select tests.expect_error($q$ select public.update_room_expiry(current_setting('t.x')::uuid, now() + interval '1 day') $q$,
  'an expired room cannot be revived');
select tests.expect_ok($q$ select public.update_room_expiry(current_setting('t.r')::uuid, now() + interval '3 days') $q$, 'host extends open room');
select tests.expect_count($q$ select 1 from public.rooms where id = current_setting('t.r')::uuid and expiry_version = 2 $q$, 1,
  'expiry change bumps expiry_version');
reset role;

-- Signed-out (anon role) -----------------------------------------------------
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select tests.expect_count($q$ select 1 from public.rooms $q$, 0, 'anon sees no rooms');
select tests.expect_count($q$ select 1 from public.profiles $q$, 0, 'anon sees no profiles');
select tests.expect_error($q$ select public.join_room(current_setting('t.r_code'), null) $q$, 'anon cannot call join_room');
select tests.expect_error($q$ select * from public.preview_room(current_setting('t.r_code'), null) $q$, 'anon cannot preview rooms');
select tests.expect_error($q$ select private.is_room_member(current_setting('t.r')::uuid) $q$, 'anon cannot call private helpers');
reset role;

-- Join throttle (supervisor F1): failed attempts persist and block after 10 -------
-- P (…05) uses join_room only; Q (…06) uses preview_room only.
select tests.login('a0000000-0000-4000-8000-000000000005', true);
set local role authenticated;
do $$ begin
  for i in 1..10 loop
    perform tests.expect_null($q$ select public.join_room('99999x', null) $q$, 'invalid join_room #' || i || ' returns null');
  end loop;
end $$;
select tests.expect_error_like($q$ select public.join_room('99999x', null) $q$, 'Too many attempts%',
  '11th invalid join_room is throttled');
select tests.expect_error_like($q$ select public.join_room(current_setting('t.r_code'), null) $q$, 'Too many attempts%',
  'throttle also blocks a valid code');
select tests.expect_sqlstate($q$ select public.join_room('99999x', null) $q$, 'PT429',
  'join throttle uses SQLSTATE PT429 (HTTP 429)');
reset role;

select tests.login('a0000000-0000-4000-8000-000000000006', true);
set local role authenticated;
do $$ begin
  for i in 1..10 loop
    perform tests.expect_count($q$ select * from public.preview_room('99999x', null) $q$, 0, 'invalid preview #' || i);
  end loop;
end $$;
select tests.expect_error_like($q$ select * from public.preview_room('99999x', null) $q$, 'Too many attempts%',
  '11th invalid preview_room is throttled');
select tests.expect_sqlstate($q$ select * from public.preview_room('99999x', null) $q$, 'PT429',
  'preview throttle uses SQLSTATE PT429 (HTTP 429)');
reset role;

-- Full room (supervisor N4): distinct SQLSTATE PT409 (HTTP 409) -------------------
update public.rooms set max_members = (select count(*) from public.room_members m where m.room_id = rooms.id)
where id = current_setting('t.r')::uuid;
select tests.login('a0000000-0000-4000-8000-000000000007', true);
set local role authenticated;
select tests.expect_sqlstate($q$ select public.join_room(current_setting('t.r_code'), null) $q$, 'PT409',
  'joining a full room fails with PT409');
reset role;
update public.rooms set max_members = 30 where id = current_setting('t.r')::uuid;

do $$ begin
  if (select count(*) from public.join_attempts
      where user_id = 'a0000000-0000-4000-8000-000000000005' and not succeeded) <> 10 then
    raise exception 'FAIL: join_room did not persist exactly 10 failed attempts';
  end if;
  if (select count(*) from public.join_attempts
      where user_id = 'a0000000-0000-4000-8000-000000000006' and not succeeded) <> 10 then
    raise exception 'FAIL: preview_room did not persist exactly 10 failed attempts';
  end if;
end $$;

-- F1b join gate: per-IP, stress mode, QR path, member re-open, GET -------------
-- U8, U9, U10 each fail 10 code attempts from IP A: 30 failures for that IP.
do $$
declare u text;
begin
  foreach u in array array['a0000000-0000-4000-8000-000000000008', 'a0000000-0000-4000-8000-000000000009',
                           'a0000000-0000-4000-8000-000000000010'] loop
    perform tests.login(u::uuid, true);
    perform tests.headers('{"cf-connecting-ip":"203.0.113.7"}');
    set local role authenticated;
    for i in 1..10 loop
      perform tests.expect_null($q$ select public.join_room('88888x', null) $q$, 'IP A failure ' || i || ' for ' || u);
    end loop;
    reset role;
  end loop;
end $$;
select tests.login('a0000000-0000-4000-8000-000000000011', true);
select tests.headers('{"cf-connecting-ip":"203.0.113.7"}');
set local role authenticated;
select tests.expect_sqlstate($q$ select public.join_room('88888x', null) $q$, 'PT429',
  'per-IP limit (30) blocks a fresh user on the same IP');
select tests.expect_sqlstate($q$ select * from public.preview_room('88888x', null) $q$, 'PT429',
  'per-IP limit also covers preview_room');
select tests.expect_count($q$ select 1 from public.preview_room(null, current_setting('t.r_token')) $q$, 1,
  'QR token path still works on the blocked IP');
select tests.headers('{"x-forwarded-for":"198.51.100.1, 203.0.113.7"}');
select tests.expect_sqlstate($q$ select public.join_room('88888x', null) $q$, 'PT429',
  'a forged first x-forwarded-for hop does not change the counted IP');
select tests.headers('{"cf-connecting-ip":"203.0.113.8"}');
select tests.expect_null($q$ select public.join_room('88888x', null) $q$, 'same user from another IP is not blocked');
select tests.expect_sqlstate($q$ select tests.read_only($x$ select public.join_room('88888x', null) $x$) $q$, 'PT405',
  'read-only (GET) join_room is rejected before any lookup');
select tests.expect_sqlstate($q$ select tests.read_only($x$ select * from public.preview_room(current_setting('t.r_code'), null) $x$) $q$, 'PT405',
  'read-only (GET) preview_room is rejected even for a valid code');
reset role;
do $$ begin
  -- Scoped to the fixed test users: the live table may hold real attempts from other sessions.
  if (select count(*) from public.join_attempts
      where user_id::text like 'a0000000-0000-4000-8000-%' and ip_hash is not null and not succeeded) <> 31 then
    raise exception 'FAIL: expected 31 IP-tagged failure rows (30 on IP A, 1 on IP B)';
  end if;
  if exists (select 1 from public.join_attempts
             where user_id::text like 'a0000000-0000-4000-8000-%' and ip_hash is not null and ip_hash !~ '^[0-9a-f]{64}$') then
    raise exception 'FAIL: ip_hash must be a 64-char hex HMAC, never a raw IP';
  end if;
  if (select count(distinct ip_hash) from public.join_attempts
      where user_id::text like 'a0000000-0000-4000-8000-%' and ip_hash is not null) <> 2 then
    raise exception 'FAIL: expected exactly 2 distinct IP hashes';
  end if;
end $$;

-- Stress mode: more than 200 code-path failures in the window (rows injected as postgres).
insert into public.join_attempts (user_id, succeeded, kind)
select 'a0000000-0000-4000-8000-000000000008', false, 'code' from generate_series(1, 201);
select tests.login('a0000000-0000-4000-8000-000000000012', true);
select tests.headers('{"cf-connecting-ip":"203.0.113.9"}');
set local role authenticated;
select tests.expect_null($q$ select public.join_room('77777x', null) $q$, 'stress mode: a fresh user still gets 1 code attempt');
select tests.expect_sqlstate($q$ select public.join_room('77777x', null) $q$, 'PT429',
  'stress mode: the 2nd code failure is blocked (per-user budget 1)');
select tests.expect_ok($q$ select public.join_room(null, current_setting('t.r_token')) $q$,
  'stress mode: the QR token path still joins');
select tests.expect_count($q$ select 1 from public.preview_room(current_setting('t.r_code'), null) where already_member $q$, 1,
  'stress mode: a blocked member can still preview its own room by code');
select tests.expect_ok($q$ select public.join_room(current_setting('t.r_code'), null) $q$,
  'stress mode: a blocked member re-opens its own room by code');
select tests.expect_count($q$ select 1 from public.rooms where id = current_setting('t.r')::uuid $q$, 1,
  'stress mode: member still reads its room');
reset role;
delete from public.join_attempts where user_id = 'a0000000-0000-4000-8000-000000000008' and ip_hash is null;
select tests.headers('');
do $$ begin
  if (select count(*) from public.join_attempts where user_id = 'a0000000-0000-4000-8000-000000000012' and not succeeded) <> 1 then
    raise exception 'FAIL: stress mode should persist exactly 1 failure row for U12';
  end if;
end $$;

-- F6: per-IP key is the IPv6 /64 prefix; IPv4-mapped IPv6 equals its IPv4 address ---
do $$ begin
  if private.normalize_ip('2001:db8:1:2:aaaa::1') <> '2001:db8:1:2::/64'
     or private.normalize_ip('2001:DB8:1:2:ffff:1:2:3') <> '2001:db8:1:2::/64'
     or private.normalize_ip('::ffff:203.0.113.7') <> '203.0.113.7'
     or private.normalize_ip('203.0.113.7') <> '203.0.113.7'
     or private.normalize_ip('not-an-ip') <> 'not-an-ip'
     or private.normalize_ip('') is not null then
    raise exception 'FAIL: normalize_ip mapping';
  end if;
end $$;
-- U13, U14, U15 each fail 10 code attempts from different addresses in one /64.
do $$
declare u text; a text; n int := 0;
begin
  foreach u in array array['a0000000-0000-4000-8000-000000000013', 'a0000000-0000-4000-8000-000000000014',
                           'a0000000-0000-4000-8000-000000000015'] loop
    n := n + 1;
    a := (array['2001:db8:1:2::a', '2001:db8:1:2:aaaa:bbbb:cccc:1', '2001:db8:1:2:ffff::c'])[n];
    perform tests.login(u::uuid, true);
    perform tests.headers(json_build_object('cf-connecting-ip', a)::text);
    set local role authenticated;
    for i in 1..10 loop
      perform tests.expect_null($q$ select public.join_room('66666x', null) $q$, 'IPv6 /64 failure ' || i || ' for ' || u);
    end loop;
    reset role;
  end loop;
end $$;
select tests.login('a0000000-0000-4000-8000-000000000011', true);
select tests.headers('{"cf-connecting-ip":"2001:db8:1:2::d"}');
set local role authenticated;
select tests.expect_sqlstate($q$ select public.join_room('66666x', null) $q$, 'PT429',
  'another address in the same IPv6 /64 shares the per-IP budget');
select tests.headers('{"cf-connecting-ip":"2001:db8:1:3::d"}');
select tests.expect_null($q$ select public.join_room('66666x', null) $q$, 'a different IPv6 /64 has its own budget');
select tests.headers('{"cf-connecting-ip":"::ffff:203.0.113.7"}');
select tests.expect_sqlstate($q$ select public.join_room('66666x', null) $q$, 'PT429',
  'IPv4-mapped IPv6 address counts as its IPv4 address');
select tests.headers('{"cf-connecting-ip":"not-an-ip"}');
select tests.expect_null($q$ select public.join_room('66666x', null) $q$, 'an unparseable IP header does not break the gate');
reset role;
select tests.headers('');
do $$ begin
  if (select count(*) from public.join_attempts
      where user_id in ('a0000000-0000-4000-8000-000000000013', 'a0000000-0000-4000-8000-000000000014',
                        'a0000000-0000-4000-8000-000000000015') and not succeeded) <> 30
     or (select count(distinct ip_hash) from public.join_attempts
         where user_id in ('a0000000-0000-4000-8000-000000000013', 'a0000000-0000-4000-8000-000000000014',
                           'a0000000-0000-4000-8000-000000000015')) <> 1 then
    raise exception 'FAIL: the three /64 addresses should persist 30 rows under one ip_hash';
  end if;
end $$;

-- profiles.updated_at is maintained on update ---------------------------------
alter table public.profiles disable trigger profiles_set_updated_at;
update public.profiles set updated_at = now() - interval '1 day' where id = 'a0000000-0000-4000-8000-000000000002';
alter table public.profiles enable trigger profiles_set_updated_at;
select tests.login('a0000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select tests.expect_affected($q$ update public.profiles set display_name = 'Guest renamed' where id = auth.uid() $q$, 1,
  'member renames own profile');
select tests.expect_count($q$ select 1 from public.profiles where id = auth.uid() and updated_at = now() $q$, 1,
  'profile update bumps updated_at');
reset role;

-- Room deletion queues storage cleanup for both buckets ------------------------
delete from public.rooms where id = current_setting('t.x')::uuid;
do $$ begin
  if (select count(*) from public.cleanup_jobs where prefix = current_setting('t.x') || '/' and bucket in ('room-media', 'face-refs')) <> 2 then
    raise exception 'FAIL: deleting a room did not queue both storage prefixes';
  end if;
end $$;

select 'RLS TESTS PASSED' as result;
rollback;
