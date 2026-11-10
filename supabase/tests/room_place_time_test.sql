-- Place and time unit test (migration 0026 room_place_and_time).
-- One transaction, ends with ROLLBACK: leaves no data behind. Run as postgres (Supabase MCP execute_sql).
-- Before the live apply it can be run with the migration's statements pasted right after BEGIN, so the DDL
-- is rolled back with the test data. Success ends with the row 'ROOM PLACE TIME TESTS PASSED'.
--
-- Actors (temporary auth.users rows, removed by the ROLLBACK):
--   H host account, M anonymous member, O anonymous outsider (never joins).
-- Rooms: created through create_room as H, plus E, an already expired room inserted directly.
-- Join-gate attempts use a documentation IP (198.51.100.226), so no live IP budget is touched.

begin;
-- A busy rooms table makes the run fail fast instead of holding up live traffic.
set local lock_timeout = '3s';

create schema tests;
grant usage on schema tests to authenticated, anon;

create function tests.login(p_uid uuid, p_anon boolean) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated', 'is_anonymous', p_anon)::text, true);
$$;
create function tests.expect_ok(p_sql text, p_label text) returns void language plpgsql as $$
begin
  execute p_sql;
exception when others then
  raise exception 'FAIL: % (% %)', p_label, sqlstate, sqlerrm;
end;
$$;
-- Fails unless the statement raises with this SQLSTATE.
create function tests.expect_state(p_sql text, p_state text, p_label text) returns void language plpgsql as $$
declare v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    v_state := sqlstate;
  end;
  if v_state is distinct from p_state then
    raise exception 'FAIL: % (expected SQLSTATE %, got %)', p_label, p_state, coalesce(v_state, 'success');
  end if;
end;
$$;
create function tests.expect_true(p_sql text, p_label text) returns void language plpgsql as $$
declare v boolean;
begin
  execute 'select (' || p_sql || ')' into v;
  if v is not true then
    raise exception 'FAIL: % (got %)', p_label, v;
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
grant execute on all functions in schema tests to authenticated, anon;
select set_config('request.headers', '{"x-forwarded-for":"198.51.100.226"}', true);

insert into auth.users (instance_id, id, aud, role, email, is_anonymous, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'c2600000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pt-host@test.invalid', false, '{"display_name":"PT Host"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c2600000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c2600000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', null, true, '{}', now(), now());

-- Results of the successful creates, read back below as postgres.
create table tests.made (label text primary key, room_id uuid, code text, token text);
grant all on tests.made to authenticated;

-- 0. Schema and grants.
select tests.expect_true($$ (select count(*) from information_schema.columns where table_schema = 'public'
  and table_name = 'rooms' and column_name in ('place_name', 'place_lat', 'place_lng', 'starts_at')
  and is_nullable = 'YES') = 4 $$, 'four nullable room columns');
select tests.expect_true($$ (select count(*) from pg_proc where proname = 'create_room'
  and pronamespace = 'public'::regnamespace) = 1 $$, 'exactly one create_room (no overload)');
select tests.expect_true($$ not has_function_privilege('anon',
  'public.create_room(text, text, timestamptz, boolean, text[], text, double precision, double precision, timestamptz)', 'execute') $$,
  'anon cannot execute create_room');
select tests.expect_true($$ not has_function_privilege('anon', 'public.preview_room(text, text)', 'execute') $$,
  'anon cannot execute preview_room');
select tests.expect_true($$ has_function_privilege('authenticated', 'public.preview_room(text, text)', 'execute') $$,
  'authenticated can execute preview_room');

set local role authenticated;
select tests.login('c2600000-0000-4000-8000-000000000001', false);

-- 1. Old callers (five named arguments, as the current app sends) are unchanged: all four fields null.
select tests.expect_ok($$ insert into tests.made
  select 'old', r.id, r.code, r.invite_token from public.create_room(
    p_name => 'PT old', p_type => 'general', p_expires_at => now() + interval '3 hours',
    p_location_allowed => false, p_statuses => array['On my way']) r $$, 'old five-argument call');
select tests.expect_ok($$ insert into tests.made
  select 'old4', r.id, r.code, r.invite_token from public.create_room(
    p_name => 'PT old4', p_type => 'event', p_expires_at => now() + interval '3 hours',
    p_location_allowed => true) r $$, 'old four-argument call (statuses defaulted)');

-- 2. Each field alone and together.
select tests.expect_ok($$ insert into tests.made
  select 'name', r.id, r.code, r.invite_token from public.create_room('PT name', 'general',
    now() + interval '3 hours', false, p_place_name => '  Ferry Building  ') r $$, 'place name only (trimmed)');
select tests.expect_ok($$ insert into tests.made
  select 'pin', r.id, r.code, r.invite_token from public.create_room('PT pin', 'general',
    now() + interval '3 hours', false, p_place_name => 'Dolores Park',
    p_place_lat => 37.7596, p_place_lng => -122.4269) r $$, 'place name with pin');
select tests.expect_ok($$ insert into tests.made
  select 'time', r.id, r.code, r.invite_token from public.create_room('PT time', 'general',
    now() + interval '3 hours', false, p_starts_at => now() + interval '1 hour') r $$, 'start time only');
select tests.expect_ok($$ insert into tests.made
  select 'all', r.id, r.code, r.invite_token from public.create_room('PT all', 'event',
    now() + interval '2 days', false, array['Here'], 'Oracle Park', 37.7786, -122.3893,
    now() + interval '1 day') r $$, 'all fields (positional)');
select tests.expect_ok($$ insert into tests.made
  select 'blank', r.id, r.code, r.invite_token from public.create_room('PT blank', 'general',
    now() + interval '3 hours', false, p_place_name => '   ') r $$, 'blank place name means no place');
select tests.expect_ok($$ insert into tests.made
  select 'edges', r.id, r.code, r.invite_token from public.create_room('PT edges', 'general',
    now() + interval '3 hours', false, p_place_name => repeat('x', 80), p_place_lat => -90, p_place_lng => 180,
    p_starts_at => now() - interval '23 hours') r $$, 'edge values (80 chars, -90/180, 23 h ago)');

-- 3. Invalid combinations are rejected with 22023, and nothing is created.
select tests.expect_state($$ select public.create_room('PT bad', 'general', now() + interval '3 hours', false,
  p_place_lat => 37.0, p_place_lng => -122.0) $$, '22023', 'pin without a place name');
select tests.expect_state($$ select public.create_room('PT bad', 'general', now() + interval '3 hours', false,
  p_place_name => '   ', p_place_lat => 37.0, p_place_lng => -122.0) $$, '22023', 'pin with a blank place name');
select tests.expect_state($$ select public.create_room('PT bad', 'general', now() + interval '3 hours', false,
  p_place_name => 'Half pin', p_place_lat => 37.0) $$, '22023', 'latitude without longitude');
select tests.expect_state($$ select public.create_room('PT bad', 'general', now() + interval '3 hours', false,
  p_place_name => 'Half pin', p_place_lng => -122.0) $$, '22023', 'longitude without latitude');
select tests.expect_state($$ select public.create_room('PT bad', 'general', now() + interval '3 hours', false,
  p_place_name => 'North', p_place_lat => 90.0001, p_place_lng => 0) $$, '22023', 'latitude above 90');
select tests.expect_state($$ select public.create_room('PT bad', 'general', now() + interval '3 hours', false,
  p_place_name => 'South', p_place_lat => -90.0001, p_place_lng => 0) $$, '22023', 'latitude below -90');
select tests.expect_state($$ select public.create_room('PT bad', 'general', now() + interval '3 hours', false,
  p_place_name => 'East', p_place_lat => 0, p_place_lng => 180.0001) $$, '22023', 'longitude above 180');
select tests.expect_state($$ select public.create_room('PT bad', 'general', now() + interval '3 hours', false,
  p_place_name => 'West', p_place_lat => 0, p_place_lng => -180.0001) $$, '22023', 'longitude below -180');
select tests.expect_state($$ select public.create_room('PT bad', 'general', now() + interval '3 hours', false,
  p_place_name => 'NaN', p_place_lat => 'NaN'::float8, p_place_lng => 0) $$, '22023', 'NaN latitude');
select tests.expect_state($$ select public.create_room('PT bad', 'general', now() + interval '3 hours', false,
  p_place_name => 'Inf', p_place_lat => 0, p_place_lng => 'Infinity'::float8) $$, '22023', 'infinite longitude');
select tests.expect_state($$ select public.create_room('PT bad', 'general', now() + interval '3 hours', false,
  p_place_name => repeat('x', 81)) $$, '22023', 'place name over 80 characters');
select tests.expect_state($$ select public.create_room('PT bad', 'general', now() + interval '3 hours', false,
  p_starts_at => now() + interval '3 hours') $$, '22023', 'start time at the expiry');
select tests.expect_state($$ select public.create_room('PT bad', 'general', now() + interval '3 hours', false,
  p_starts_at => now() + interval '4 hours') $$, '22023', 'start time after the expiry');
select tests.expect_state($$ select public.create_room('PT bad', 'general', now() + interval '3 hours', false,
  p_starts_at => now() - interval '25 hours') $$, '22023', 'start time more than a day ago');
reset role;
select tests.expect_count($$ select 1 from public.rooms where name = 'PT bad' $$, 0, 'no room from a rejected call');

-- 4. Stored values.
select tests.expect_true($$ (select place_name is null and place_lat is null and place_lng is null and starts_at is null
  from public.rooms where id = (select room_id from tests.made where label = 'old')) $$, 'old call stores no fields');
select tests.expect_true($$ (select place_name is null and place_lat is null and starts_at is null
  from public.rooms where id = (select room_id from tests.made where label = 'old4')) $$, 'old4 call stores no fields');
select tests.expect_true($$ (select place_name = 'Ferry Building' and place_lat is null and place_lng is null
  from public.rooms where id = (select room_id from tests.made where label = 'name')) $$, 'name stored trimmed, no pin');
select tests.expect_true($$ (select place_name = 'Dolores Park' and place_lat = 37.7596 and place_lng = -122.4269
  from public.rooms where id = (select room_id from tests.made where label = 'pin')) $$, 'pin stored');
select tests.expect_true($$ (select place_name is null and starts_at is not null
  from public.rooms where id = (select room_id from tests.made where label = 'time')) $$, 'time stored, no place');
select tests.expect_true($$ (select place_name is null
  from public.rooms where id = (select room_id from tests.made where label = 'blank')) $$, 'blank name stored as null');
select tests.expect_count($$ select 1 from public.status_definitions
  where room_id = (select room_id from tests.made where label = 'all') $$, 2, 'statuses still created (Emergency + Here)');
select tests.expect_count($$ select 1 from public.room_members
  where room_id = (select room_id from tests.made where label = 'all') and role = 'host' $$, 1, 'host membership still created');

-- 5. Table constraints hold even without the RPC (defense in depth).
select tests.expect_state($$ update public.rooms set place_name = null
  where id = (select room_id from tests.made where label = 'pin') $$, '23514', 'table: pin without name');
select tests.expect_state($$ update public.rooms set place_lng = null
  where id = (select room_id from tests.made where label = 'pin') $$, '23514', 'table: half pin');
select tests.expect_state($$ update public.rooms set place_name = ' padded '
  where id = (select room_id from tests.made where label = 'name') $$, '23514', 'table: untrimmed name');
select tests.expect_state($$ update public.rooms set place_lat = 91
  where id = (select room_id from tests.made where label = 'pin') $$, '23514', 'table: latitude out of range');

-- 6. Only a host account can create (unchanged): the anonymous member gets 42501 even with valid fields.
set local role authenticated;
select tests.login('c2600000-0000-4000-8000-000000000002', true);
select tests.expect_state($$ select public.create_room('PT guest', 'general', now() + interval '3 hours', false,
  p_place_name => 'Somewhere') $$, '42501', 'anonymous user cannot create');

-- 7. preview_room: the fields for a non-member with the code or the QR token, and for a member.
select tests.login('c2600000-0000-4000-8000-000000000003', true);
select tests.expect_true($$ (select place_name = 'Dolores Park' and place_lat = 37.7596 and place_lng = -122.4269
  and starts_at is null and not already_member
  from public.preview_room(p_code => (select code from tests.made where label = 'pin'))) $$, 'outsider preview by code: pin');
select tests.expect_true($$ (select place_name = 'Oracle Park' and starts_at is not null
  from public.preview_room(p_token => (select token from tests.made where label = 'all'))) $$, 'outsider preview by token: all');
select tests.expect_true($$ (select place_name is null and place_lat is null and place_lng is null and starts_at is null
  from public.preview_room(p_code => (select code from tests.made where label = 'old'))) $$, 'preview of a room without fields');
-- The outsider still cannot read the rooms row itself (RLS unchanged).
select tests.expect_count($$ select 1 from public.rooms where id = (select room_id from tests.made where label = 'pin') $$,
  0, 'outsider cannot select the room');
select tests.login('c2600000-0000-4000-8000-000000000001', false);
select tests.expect_true($$ (select already_member and place_name = 'Dolores Park'
  from public.preview_room(p_code => (select code from tests.made where label = 'pin'))) $$, 'host preview: member');
select tests.expect_count($$ select 1 from public.rooms where id = (select room_id from tests.made where label = 'pin')
  and place_name = 'Dolores Park' $$, 1, 'member reads the fields through rooms_select');
reset role;

-- 8. Expired room: nothing is shown, to a member or an outsider.
insert into public.rooms (id, host_id, name, created_at, expires_at, code, place_name, place_lat, place_lng, starts_at)
values ('c2610000-0000-4000-8000-0000000000e1', 'c2600000-0000-4000-8000-000000000001', 'PT expired',
        now() - interval '2 hours', now() - interval '1 minute', '92601', 'Old place', 10, 20, now() - interval '90 minutes');
insert into public.room_members (room_id, user_id, role)
values ('c2610000-0000-4000-8000-0000000000e1', 'c2600000-0000-4000-8000-000000000001', 'host');
set local role authenticated;
select tests.login('c2600000-0000-4000-8000-000000000001', false);
select tests.expect_count($$ select 1 from public.preview_room(p_code => '92601') $$, 0, 'expired: member preview empty');
select tests.expect_count($$ select 1 from public.rooms where id = 'c2610000-0000-4000-8000-0000000000e1' $$, 0,
  'expired: member cannot select the row');
select tests.login('c2600000-0000-4000-8000-000000000003', true);
select tests.expect_count($$ select 1 from public.preview_room(p_code => '92601') $$, 0, 'expired: outsider preview empty');
reset role;

-- 9. Deletion: the fields go with the room row (room-janitor deletes rows; the FK cascade and cleanup trigger
--    are unchanged).
delete from public.rooms where id = 'c2610000-0000-4000-8000-0000000000e1';
select tests.expect_count($$ select 1 from public.rooms where place_name = 'Old place' $$, 0, 'deleted room leaves no place data');

select 'ROOM PLACE TIME TESTS PASSED' as result;
rollback;
