-- S1 room Broadcast authorization test. Requires migrations through 0017 (room_broadcast).
-- One transaction, ends with ROLLBACK: leaves no data behind. Run as postgres (Supabase MCP execute_sql).
-- Mirrors how Realtime authorizes a private channel join: with the caller's JWT claims, role
-- `authenticated` and `realtime.topic` set, can the caller SELECT broadcast rows for that topic?
-- Success ends with the row 'ROOM BROADCAST TESTS PASSED'.
--
-- Actors: H host, G guest member, O outsider (never joins), L guest who joins and then leaves.

begin;

create schema tests;
grant usage on schema tests to authenticated;

create function tests.login(p_uid uuid, p_anon boolean, p_topic text) returns void language sql as $$
  select set_config('request.jwt.claims',
           json_build_object('sub', p_uid, 'role', 'authenticated', 'is_anonymous', p_anon)::text, true),
         set_config('realtime.topic', p_topic, true);
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
  ('00000000-0000-0000-0000-000000000000', 'b0000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'bc-host@test.invalid', false, '{"display_name":"Host"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b0000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b0000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b0000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', null, true, '{}', now(), now());

-- Publication: no room-scoped table is still published through Postgres Changes.
do $$ begin
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
               and tablename in ('rooms', 'room_members', 'messages', 'media', 'status_definitions', 'member_status',
                                 'arrivals', 'live_presence', 'emergency_events', 'emergency_acks', 'face_matches')) then
    raise exception 'FAIL: a room-scoped table is still in supabase_realtime';
  end if;
end $$;

-- H creates a room; G and L join; L leaves.
select tests.login('b0000000-0000-4000-8000-000000000001', false, '');
set local role authenticated;
do $$
declare r public.rooms;
begin
  r := public.create_room('Broadcast test', 'sports', now() + interval '1 day', false, array['Resting']);
  perform set_config('t.r', r.id::text, true);
  perform set_config('t.token', r.invite_token, true);
end $$;
reset role;

select tests.login('b0000000-0000-4000-8000-000000000002', true, '');
set local role authenticated;
select public.join_room(null, current_setting('t.token'));
select public.mark_arrived(current_setting('t.r')::uuid);
select public.set_my_status(current_setting('t.r')::uuid,
  (select id from public.status_definitions where room_id = current_setting('t.r')::uuid and is_emergency));
reset role;

select tests.login('b0000000-0000-4000-8000-000000000001', false, '');
set local role authenticated;
select public.ack_emergency((select id from public.emergency_events where room_id = current_setting('t.r')::uuid));
reset role;

select tests.login('b0000000-0000-4000-8000-000000000004', true, '');
set local role authenticated;
select public.join_room(null, current_setting('t.token'));
select public.leave_room(current_setting('t.r')::uuid);
reset role;

select tests.login('b0000000-0000-4000-8000-000000000002', true, '');
set local role authenticated;
select public.clear_my_status(current_setting('t.r')::uuid);
reset role;

-- Triggers: every change reached room:<id>, as private broadcasts, without row content.
select tests.expect_count($q$ select 1 from realtime.messages where topic = 'room:' || current_setting('t.r')
  and event in ('arrivals', 'member_status', 'emergency_events', 'emergency_acks', 'room_members', 'messages') group by event $q$, 6,
  'arrival, status, emergency, ack, membership and message changes are broadcast');
select tests.expect_count($q$ select 1 from realtime.messages where topic = 'room:' || current_setting('t.r')
  and event = 'member_status' and payload ->> 'op' = 'DELETE' $q$, 1, 'status clear (DELETE) is broadcast to the room');
select tests.expect_count($q$ select 1 from realtime.messages where topic = 'room:' || current_setting('t.r')
  and event = 'room_members' and payload ->> 'op' = 'DELETE' $q$, 1, 'leave (DELETE) is broadcast to the room');
select tests.expect_count($q$ select 1 from realtime.messages where topic = 'room:' || current_setting('t.r')
  and (not private or extension <> 'broadcast') $q$, 0, 'all room events are private broadcasts');
select tests.expect_count($q$ select 1 from realtime.messages where topic = 'room:' || current_setting('t.r')
  and exists (select 1 from jsonb_object_keys(payload) k where k not in ('table', 'op', 'id')) $q$, 0,
  'payloads carry only table, op and id (no user ids, bodies or locations)');

-- Receive authorization for room:<id>.
select tests.login('b0000000-0000-4000-8000-000000000002', true, 'room:' || current_setting('t.r'));
set local role authenticated;
select tests.expect_count($q$ select 1 from realtime.messages where topic = realtime.topic() and event = 'arrivals' $q$, 1,
  'member G can receive room:<id>');
reset role;

select tests.login('b0000000-0000-4000-8000-000000000001', false, 'room:' || current_setting('t.r'));
set local role authenticated;
select tests.expect_count($q$ select 1 from realtime.messages where topic = realtime.topic() and event = 'emergency_acks' $q$, 1,
  'host H can receive room:<id>');
reset role;

select tests.login('b0000000-0000-4000-8000-000000000003', true, 'room:' || current_setting('t.r'));
set local role authenticated;
select tests.expect_count($q$ select 1 from realtime.messages $q$, 0, 'outsider O cannot receive room:<id>');
select tests.expect_error($q$ insert into realtime.messages (topic, extension, event, payload, private)
  values (realtime.topic(), 'broadcast', 'messages', '{}', true) $q$, 'outsider O cannot publish to room:<id>');
reset role;

select tests.login('b0000000-0000-4000-8000-000000000004', true, 'room:' || current_setting('t.r'));
set local role authenticated;
select tests.expect_count($q$ select 1 from realtime.messages $q$, 0, 'departed member L cannot receive room:<id>');
reset role;

select tests.login('b0000000-0000-4000-8000-000000000002', true, 'room:' || current_setting('t.r'));
set local role authenticated;
select tests.expect_error($q$ insert into realtime.messages (topic, extension, event, payload, private)
  values (realtime.topic(), 'broadcast', 'messages', '{}', true) $q$, 'member G cannot publish (forge) room events');
reset role;

-- Malformed topics never authorize.
select tests.login('b0000000-0000-4000-8000-000000000002', true, 'room:not-a-uuid');
set local role authenticated;
select tests.expect_count($q$ select 1 from realtime.messages $q$, 0, 'malformed room topic authorizes nothing');
reset role;

-- An expired room stops authorizing at once.
update public.rooms set created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' where id = current_setting('t.r')::uuid;
select tests.login('b0000000-0000-4000-8000-000000000002', true, 'room:' || current_setting('t.r'));
set local role authenticated;
select tests.expect_count($q$ select 1 from realtime.messages $q$, 0, 'member of an expired room cannot receive');
reset role;

-- N18 (0018): only live rooms broadcast.
select tests.expect_count($q$ select 1 from realtime.messages where topic = 'room:' || current_setting('t.r')
  and event = 'rooms' and payload ->> 'op' = 'UPDATE' $q$, 1, 'the live -> expired transition is still broadcast');
select set_config('t.n', (select count(*) from realtime.messages where topic = 'room:' || current_setting('t.r'))::text, true);
update public.status_definitions set label = label where room_id = current_setting('t.r')::uuid;
update public.rooms set name = name where id = current_setting('t.r')::uuid;
select tests.expect_count($q$ select 1 from realtime.messages where topic = 'room:' || current_setting('t.r') $q$,
  current_setting('t.n')::bigint, 'changes in an expired room are not broadcast');
delete from public.rooms where id = current_setting('t.r')::uuid;
select tests.expect_count($q$ select 1 from realtime.messages where topic = 'room:' || current_setting('t.r') $q$,
  current_setting('t.n')::bigint, 'janitor-style cascade delete of an expired room sends nothing');

-- Host-ended room (end_room sets deleted_at): the end notice is sent, later changes are not.
select tests.login('b0000000-0000-4000-8000-000000000001', false, '');
set local role authenticated;
do $$
declare r public.rooms;
begin
  r := public.create_room('Broadcast end test', 'sports', now() + interval '1 day', false, array['Resting']);
  perform set_config('t.r2', r.id::text, true);
end $$;
select public.end_room(current_setting('t.r2')::uuid);
reset role;
select tests.expect_count($q$ select 1 from realtime.messages where topic = 'room:' || current_setting('t.r2')
  and event = 'rooms' and payload ->> 'op' = 'UPDATE' $q$, 1, 'end_room notice is broadcast');
select set_config('t.n2', (select count(*) from realtime.messages where topic = 'room:' || current_setting('t.r2'))::text, true);
update public.status_definitions set label = label where room_id = current_setting('t.r2')::uuid;
delete from public.rooms where id = current_setting('t.r2')::uuid;
select tests.expect_count($q$ select 1 from realtime.messages where topic = 'room:' || current_setting('t.r2') $q$,
  current_setting('t.n2')::bigint, 'ended room: later changes and the cascade delete send nothing');

select 'ROOM BROADCAST TESTS PASSED' as result;

rollback;
