-- Qrewing AI test (migration 0027 qrewing_ai).
-- One transaction, ends with ROLLBACK: leaves no data behind. Run as postgres (Supabase MCP execute_sql).
-- Before the live apply it can be run with the migration's statements pasted right after BEGIN, so the DDL
-- is rolled back with the test data. Success ends with the row 'QREWING AI TESTS PASSED'; the statement
-- after ROLLBACK must then return leftovers = 0.
--
-- Actors (temporary auth.users rows, removed by the ROLLBACK):
--   H host account, A and B anonymous members, O anonymous outsider (never joins).
-- Rooms: E (event) and G (general), created through create_room as H; A and B join both directly.
-- G is ended early in 7b (grace); D is ended by H's account deletion.

begin;
-- A busy table makes the run fail fast instead of holding up live traffic.
set local lock_timeout = '3s';

create schema tests;
grant usage on schema tests to authenticated, anon, service_role;

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
-- Rows of all five client-readable room tables for one room (as the current role).
create function tests.visible(p_room uuid) returns bigint language sql as $$
  select (select count(*) from public.qrewing_rooms where room_id = p_room)
       + (select count(*) from public.qrewing_members where room_id = p_room)
       + (select count(*) from public.entry_profiles where room_id = p_room)
       + (select count(*) from public.message_triage where room_id = p_room)
       + (select count(*) from public.room_recaps where room_id = p_room)
       + (select count(*) from public.qrewing_matches where room_id = p_room);
$$;
grant execute on all functions in schema tests to authenticated, anon, service_role;

insert into auth.users (instance_id, id, aud, role, email, is_anonymous, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'c2700000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'qa-host@test.invalid', false, '{"display_name":"QA Host"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c2700000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c2700000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c2700000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', null, true, '{}', now(), now());

create table tests.made (label text primary key, room_id uuid);
grant all on tests.made to authenticated, service_role;

-- 0. Schema, RLS and grants.
select tests.expect_true($$ (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relrowsecurity and c.relname in ('qrewing_rooms', 'qrewing_members',
  'entry_profiles', 'message_triage', 'room_recaps', 'qrewing_matches')) = 6 $$, 'RLS on all six public tables');
select tests.expect_true($$ (select c.relrowsecurity from pg_class c
  where c.oid = 'private.qrewing_usage'::regclass) $$, 'RLS on private.qrewing_usage');
select tests.expect_true($$ not has_table_privilege('authenticated', 'private.qrewing_usage', 'select') $$,
  'authenticated cannot read usage');
select tests.expect_true($$ not has_table_privilege('anon', 'public.entry_profiles', 'select') $$,
  'anon cannot read entry_profiles');
select tests.expect_true($$ not has_table_privilege('authenticated', 'public.message_triage', 'insert')
  and not has_table_privilege('authenticated', 'public.room_recaps', 'update')
  and not has_table_privilege('authenticated', 'public.qrewing_matches', 'insert')
  and not has_table_privilege('authenticated', 'public.entry_profiles', 'insert')
  and not has_table_privilege('authenticated', 'public.qrewing_rooms', 'delete') $$,
  'clients have no direct write grants');
select tests.expect_true($$ not has_function_privilege('anon', 'public.set_qrewing_room(uuid, boolean, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.set_qrewing_member(uuid, boolean, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.upsert_entry_profile(uuid, text, text, text, text[])', 'execute') $$,
  'anon cannot execute the RPCs');
select tests.expect_true($$ not has_function_privilege('authenticated',
  'public.log_qrewing_usage(uuid, text, text, integer, integer)', 'execute')
  and has_function_privilege('service_role', 'public.log_qrewing_usage(uuid, text, text, integer, integer)', 'execute') $$,
  'log_qrewing_usage is service_role only');

-- Rooms E (event) and G (general) as H; A and B join both.
set local role authenticated;
select tests.login('c2700000-0000-4000-8000-000000000001', false);
select tests.expect_ok($$ insert into tests.made select 'E', r.id from public.create_room(
  p_name => 'QA event', p_type => 'event', p_expires_at => now() + interval '3 hours', p_location_allowed => false) r $$,
  'create event room');
select tests.expect_ok($$ insert into tests.made select 'G', r.id from public.create_room(
  p_name => 'QA general', p_type => 'general', p_expires_at => now() + interval '3 hours', p_location_allowed => false) r $$,
  'create general room');
reset role;
insert into public.room_members (room_id, user_id)
select m.room_id, u.id from tests.made m
cross join (values ('c2700000-0000-4000-8000-000000000002'::uuid), ('c2700000-0000-4000-8000-000000000003'::uuid)) u(id);

-- 1. set_qrewing_room: host only; entry_required only with AI on in an event room.
set local role authenticated;
select tests.login('c2700000-0000-4000-8000-000000000002', true);
select tests.expect_state($$ select public.set_qrewing_room((select room_id from tests.made where label = 'E'), true, false) $$,
  '42501', 'member (non-host) cannot set_qrewing_room');
select tests.login('c2700000-0000-4000-8000-000000000004', true);
select tests.expect_state($$ select public.set_qrewing_room((select room_id from tests.made where label = 'E'), true, false) $$,
  '42501', 'outsider cannot set_qrewing_room');
select tests.login('c2700000-0000-4000-8000-000000000001', false);
select tests.expect_state($$ select public.set_qrewing_room((select room_id from tests.made where label = 'G'), true, true) $$,
  '22023', 'entry_required rejected for a non-event room');
select tests.expect_state($$ select public.set_qrewing_room((select room_id from tests.made where label = 'E'), false, true) $$,
  '22023', 'entry_required rejected with AI off');
-- From 0028 on, entry_required needs at least one entry question (entry_questions_test.sql covers that rule).
do $$ begin
  if to_regprocedure('public.set_entry_questions(uuid, jsonb)') is not null then
    perform public.set_entry_questions((select room_id from tests.made where label = 'E'),
      '[{"kind":"short","prompt":"Headline","required":true}]');
  end if;
end $$;
select tests.expect_ok($$ select public.set_qrewing_room((select room_id from tests.made where label = 'E'), true, true) $$,
  'host turns AI and entry info on (event)');
select tests.expect_ok($$ select public.set_qrewing_room((select room_id from tests.made where label = 'E'), true, true) $$,
  'second call is an upsert');
select tests.expect_ok($$ select public.set_qrewing_room((select room_id from tests.made where label = 'G'), false, false) $$,
  'host keeps AI off (general)');

-- 2. set_qrewing_member: own row; mute needs consent; consent needs AI on; withdrawing clears both.
select tests.login('c2700000-0000-4000-8000-000000000002', true);
select tests.expect_state($$ select public.set_qrewing_member((select room_id from tests.made where label = 'E'), false, true) $$,
  '22023', 'mute without ai_ok rejected');
select tests.expect_state($$ select public.set_qrewing_member((select room_id from tests.made where label = 'G'), true, false) $$,
  '22023', 'consent rejected while AI is off');
select tests.expect_ok($$ select public.set_qrewing_member((select room_id from tests.made where label = 'E'), true, true) $$,
  'A agrees and mutes');
select tests.expect_true($$ (select ai_ok_at is not null and mute_small_talk from public.qrewing_members
  where room_id = (select room_id from tests.made where label = 'E')) $$, 'A row: consent and mute');
select tests.expect_ok($$ select public.set_qrewing_member((select room_id from tests.made where label = 'E'), false, false) $$,
  'A withdraws');
select tests.expect_true($$ (select ai_ok_at is null and not mute_small_talk from public.qrewing_members
  where room_id = (select room_id from tests.made where label = 'E')) $$, 'withdraw clears ai_ok_at and mute');
select tests.expect_ok($$ select public.set_qrewing_member((select room_id from tests.made where label = 'E'), true, true) $$,
  'A agrees again');
select tests.login('c2700000-0000-4000-8000-000000000004', true);
select tests.expect_state($$ select public.set_qrewing_member((select room_id from tests.made where label = 'E'), true, false) $$,
  '42501', 'outsider cannot set_qrewing_member');
select tests.login('c2700000-0000-4000-8000-000000000003', true);
select tests.expect_ok($$ select public.set_qrewing_member((select room_id from tests.made where label = 'E'), true, false) $$,
  'B agrees');

-- 3. Entry limits.
select tests.expect_state($$ select public.upsert_entry_profile((select room_id from tests.made where label = 'E'),
  repeat('h', 81), '', '', '{}') $$, '22023', '81-char headline rejected');
select tests.expect_state($$ select public.upsert_entry_profile((select room_id from tests.made where label = 'E'),
  '   ', '', '', '{}') $$, '22023', 'blank headline rejected');
select tests.expect_state($$ select public.upsert_entry_profile((select room_id from tests.made where label = 'E'),
  'B', '', '', array['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example']) $$,
  '22023', '4 links rejected');
select tests.expect_state($$ select public.upsert_entry_profile((select room_id from tests.made where label = 'E'),
  'B', '', '', array['http://a.example']) $$, '22023', 'http:// link rejected');
select tests.expect_state($$ select public.upsert_entry_profile((select room_id from tests.made where label = 'E'),
  'B', repeat('i', 301), '', '{}') $$, '22023', '301-char interests rejected');
select tests.expect_ok($$ select public.upsert_entry_profile((select room_id from tests.made where label = 'E'),
  '  CS junior at SJSU  ', 'ML', 'study group', array['https://b.example/me']) $$, 'B entry saved');
select tests.expect_true($$ (select headline = 'CS junior at SJSU' from public.entry_profiles
  where user_id = 'c2700000-0000-4000-8000-000000000003') $$, 'headline stored trimmed');
select tests.login('c2700000-0000-4000-8000-000000000002', true);
select tests.expect_ok($$ select public.upsert_entry_profile((select room_id from tests.made where label = 'E'),
  'Designer', '', '', '{}') $$, 'A entry saved');
select tests.login('c2700000-0000-4000-8000-000000000004', true);
select tests.expect_state($$ select public.upsert_entry_profile((select room_id from tests.made where label = 'E'),
  'Outsider', '', '', '{}') $$, '42501', 'outsider cannot save entry info');
reset role;
-- Table constraints hold without the RPC (defense in depth).
select tests.expect_state($$ update public.entry_profiles set links = array['http://x.example']
  where user_id = 'c2700000-0000-4000-8000-000000000003' $$, '23514', 'table: http link');
select tests.expect_state($$ update public.qrewing_members set ai_ok_at = null
  where user_id = 'c2700000-0000-4000-8000-000000000002' $$, '23514', 'table: mute without consent');

-- 4. Service-role writes, as the Edge Function makes them (the message itself is inserted as postgres).
insert into public.messages (id, room_id, sender_id, kind, body)
values ('c2710000-0000-4000-8000-0000000000a1', (select room_id from tests.made where label = 'E'),
        'c2700000-0000-4000-8000-000000000003', 'text', 'Meet at gate B at 6');
set local role service_role;
insert into public.message_triage (message_id, room_id, state, important, reason)
values ('c2710000-0000-4000-8000-0000000000a1', (select room_id from tests.made where label = 'E'), 'done', true, 'Meeting place');
select tests.expect_state($$ insert into public.message_triage (message_id, room_id, state, important)
  values ('c2710000-0000-4000-8000-0000000000a1', (select room_id from tests.made where label = 'E'), 'pending', null) $$,
  '23505', 'a message is claimed once');
select tests.expect_true($$ (select source from public.message_triage
  where message_id = 'c2710000-0000-4000-8000-0000000000a1') = 'model' $$, 'triage source defaults to model');
select tests.expect_state($$ update public.message_triage set source = 'rule', state = 'skipped', important = false
  where message_id = 'c2710000-0000-4000-8000-0000000000a1' $$, '23514', 'a rule row is always done');
select tests.expect_state($$ update public.message_triage set source = 'guess'
  where message_id = 'c2710000-0000-4000-8000-0000000000a1' $$, '23514', 'triage source is model or rule');
insert into public.room_recaps (room_id, state, title, summary, highlights)
values ((select room_id from tests.made where label = 'E'), 'done', 'QA night', 'Summary', array['One']);
select tests.expect_state($$ insert into public.room_recaps (room_id, state, highlights)
  values ((select room_id from tests.made where label = 'G'), 'pending', array['1','2','3','4','5','6']) $$,
  '23514', 'table: 6 highlights');
insert into public.qrewing_matches (room_id, user_id, input_hash, matches)
select room_id, u.id, 'h', '[]'::jsonb from tests.made m
cross join (values ('c2700000-0000-4000-8000-000000000002'::uuid), ('c2700000-0000-4000-8000-000000000003'::uuid)) u(id)
where m.label = 'E';
select public.log_qrewing_usage((select room_id from tests.made where label = 'E'), 'triage', 'claude-haiku-5-5', 120, 30);
reset role;
select tests.expect_count($$ select 1 from private.qrewing_usage
  where room_id = (select room_id from tests.made where label = 'E') and input_tokens = 120 $$, 1, 'usage logged');

-- 5. Visibility.
set local role authenticated;
select tests.login('c2700000-0000-4000-8000-000000000004', true);
select tests.expect_true($$ tests.visible((select room_id from tests.made where label = 'E')) = 0 $$,
  'outsider reads 0 rows from every table');
select tests.login('c2700000-0000-4000-8000-000000000002', true);
select tests.expect_count($$ select 1 from public.qrewing_members where room_id = (select room_id from tests.made where label = 'E') $$,
  1, 'A sees only own qrewing_members row');
select tests.expect_count($$ select 1 from public.qrewing_members where user_id = 'c2700000-0000-4000-8000-000000000003' $$,
  0, 'A cannot read B qrewing_members');
select tests.expect_count($$ select 1 from public.qrewing_matches where user_id = 'c2700000-0000-4000-8000-000000000003' $$,
  0, 'A cannot read B qrewing_matches');
select tests.expect_count($$ select 1 from public.qrewing_matches where room_id = (select room_id from tests.made where label = 'E') $$,
  1, 'A reads own qrewing_matches');
select tests.expect_count($$ select 1 from public.entry_profiles where room_id = (select room_id from tests.made where label = 'E') $$,
  2, 'A reads attendees entry info');
select tests.expect_count($$ select 1 from public.message_triage where room_id = (select room_id from tests.made where label = 'E') $$,
  1, 'A reads triage');
select tests.expect_count($$ select 1 from public.room_recaps where room_id = (select room_id from tests.made where label = 'E') $$,
  1, 'A reads recap');
select tests.expect_count($$ select 1 from public.qrewing_rooms where room_id = (select room_id from tests.made where label = 'E') $$,
  1, 'A reads room switch');
reset role;

-- 6. Leaving removes the leaver's rows (B).
delete from public.room_members where room_id = (select room_id from tests.made where label = 'E')
  and user_id = 'c2700000-0000-4000-8000-000000000003';
select tests.expect_count($$ select 1 from public.qrewing_members where user_id = 'c2700000-0000-4000-8000-000000000003'
  union all select 1 from public.entry_profiles where user_id = 'c2700000-0000-4000-8000-000000000003'
  union all select 1 from public.qrewing_matches where user_id = 'c2700000-0000-4000-8000-000000000003' $$,
  0, 'leaving cascades consent, entry and matches');

-- 7. After expires_at passes, a member reads 0 rows from every table.
update public.rooms set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'
where id = (select room_id from tests.made where label = 'E');
set local role authenticated;
select tests.login('c2700000-0000-4000-8000-000000000002', true);
select tests.expect_true($$ tests.visible((select room_id from tests.made where label = 'E')) = 0 $$,
  'expired: member reads 0 rows from every table');
select tests.expect_state($$ select public.set_qrewing_member((select room_id from tests.made where label = 'E'), true, false) $$,
  '42501', 'expired: member cannot change consent');
select tests.login('c2700000-0000-4000-8000-000000000001', false);
select tests.expect_state($$ select public.set_qrewing_room((select room_id from tests.made where label = 'E'), true, false) $$,
  '42501', 'expired: host cannot change the switch');
reset role;

-- 7b. Early-end grace (spec 7.1). Room G: a message, A's media (row + Storage object), A's face enrollment and
-- match, and a done recap; then the host ends G.
insert into public.messages (id, room_id, sender_id, kind, body)
values ('c2710000-0000-4000-8000-0000000000b1', (select room_id from tests.made where label = 'G'),
        'c2700000-0000-4000-8000-000000000003', 'text', 'Bus at 5');
-- Storage objects first, with a size: media_integrity (0015) rejects a ready row whose original is missing or empty.
insert into storage.objects (bucket_id, name, owner_id, metadata)
select 'room-media', room_id::text || '/c2720000-0000-4000-8000-0000000000c1/original.jpg',
       'c2700000-0000-4000-8000-000000000002', '{"size":1}'::jsonb
from tests.made where label = 'G';
insert into storage.objects (bucket_id, name, owner_id, metadata)
select 'room-media', room_id::text || '/c2720000-0000-4000-8000-0000000000c1/detect/0.jpg',
       'c2700000-0000-4000-8000-000000000002', '{"size":1}'::jsonb
from tests.made where label = 'G';
insert into public.media (id, room_id, uploader_id, kind, original_path, preview_path, file_name, mime_type, status)
select 'c2720000-0000-4000-8000-0000000000c1', room_id, 'c2700000-0000-4000-8000-000000000002', 'photo',
       room_id::text || '/c2720000-0000-4000-8000-0000000000c1/original.jpg', null, 'a.jpg', 'image/jpeg', 'ready'
from tests.made where label = 'G';
insert into public.face_enrollments (id, room_id, user_id, ref_path)
select 'c2730000-0000-4000-8000-0000000000d1', room_id, 'c2700000-0000-4000-8000-000000000002', 'qa/ref.jpg'
from tests.made where label = 'G';
insert into public.face_matches (enrollment_id, media_id, similarity, matched)
values ('c2730000-0000-4000-8000-0000000000d1', 'c2720000-0000-4000-8000-0000000000c1', 99, true);
-- Pending: not announced. It turns done during grace below.
insert into public.room_recaps (room_id, state) select room_id, 'pending' from tests.made where label = 'G';

-- Rows of the grace set for one room (as the current role).
create function tests.grace_visible(p_room uuid) returns bigint language sql as $$
  select (select count(*) from public.rooms where id = p_room)
       + (select count(*) from public.room_members where room_id = p_room)
       + (select count(*) from public.media where room_id = p_room)
       + (select count(*) from storage.objects where bucket_id = 'room-media' and name like p_room::text || '/%')
       + (select count(*) from public.face_enrollments where room_id = p_room)
       + (select count(*) from public.face_matches f join public.media m on m.id = f.media_id where m.room_id = p_room)
       + (select count(*) from public.room_recaps where room_id = p_room);
$$;
grant execute on function tests.grace_visible(uuid) to authenticated;

set local role authenticated;
select tests.login('c2700000-0000-4000-8000-000000000001', false);
select tests.expect_ok($$ select public.end_room((select room_id from tests.made where label = 'G')) $$, 'host ends G early');
reset role;
select tests.expect_true($$ (select deleted_at is not null and grace_until between now() + interval '29 minutes'
  and now() + interval '31 minutes' from public.rooms where id = (select room_id from tests.made where label = 'G')) $$,
  'end_room sets deleted_at and grace_until = now + 30 minutes');
-- Only the recap notice is broadcast during grace: a new message sends nothing, the recap turning done
-- sends one. Notices from before the end (message, rooms update) are cleared first.
delete from realtime.messages where topic = 'room:' || (select room_id from tests.made where label = 'G');
insert into public.messages (room_id, sender_id, kind, body)
select room_id, 'c2700000-0000-4000-8000-000000000003', 'text', 'After the end' from tests.made where label = 'G';
update public.room_recaps set state = 'done', title = 'QA general', summary = 'Summary' where room_id = (select room_id from tests.made where label = 'G');
select tests.expect_count($$ select 1 from realtime.messages
  where topic = 'room:' || (select room_id from tests.made where label = 'G') and event = 'messages' $$,
  0, 'grace: messages are not broadcast');
select tests.expect_true($$ (select count(*) from realtime.messages
  where topic = 'room:' || (select room_id from tests.made where label = 'G') and event = 'room_recaps') = 1 $$,
  'grace: the room_recaps notice is broadcast');
-- A forged non-recap row on the topic, to prove a grace member cannot receive it.
insert into realtime.messages (topic, extension, event, payload, private)
select 'room:' || room_id, 'broadcast', 'messages', '{}'::jsonb, true from tests.made where label = 'G';

set local role authenticated;
select tests.login('c2700000-0000-4000-8000-000000000002', true);
select tests.expect_count($$ select 1 from public.rooms where id = (select room_id from tests.made where label = 'G') $$,
  1, 'grace: A reads the rooms row');
select tests.expect_count($$ select 1 from public.room_members where room_id = (select room_id from tests.made where label = 'G') $$,
  1, 'grace: A reads only own room_members row');
select tests.expect_count($$ select 1 from public.media where room_id = (select room_id from tests.made where label = 'G') $$,
  1, 'grace: A reads media');
select tests.expect_count($$ select 1 from storage.objects where bucket_id = 'room-media'
  and name like (select room_id from tests.made where label = 'G')::text || '/%' $$,
  1, 'grace: A reads the original, never the detect copy');
select tests.expect_count($$ select 1 from public.face_enrollments where room_id = (select room_id from tests.made where label = 'G') $$,
  1, 'grace: A reads own face enrollment');
select tests.expect_count($$ select 1 from public.face_matches where enrollment_id = 'c2730000-0000-4000-8000-0000000000d1' $$,
  1, 'grace: A reads own face matches');
select tests.expect_count($$ select 1 from public.room_recaps where room_id = (select room_id from tests.made where label = 'G') $$,
  1, 'grace: A reads the recap');
select tests.expect_count($$ select 1 from public.messages where room_id = (select room_id from tests.made where label = 'G') $$,
  0, 'grace: A reads no messages');
select tests.expect_count($$ select 1 from public.qrewing_rooms where room_id = (select room_id from tests.made where label = 'G')
  union all select 1 from public.qrewing_members where room_id = (select room_id from tests.made where label = 'G')
  union all select 1 from public.entry_profiles where room_id = (select room_id from tests.made where label = 'G') $$,
  0, 'grace: A reads no Qrewing settings or entry info');
select set_config('realtime.topic', 'room:' || (select room_id from tests.made where label = 'G'), true);
select tests.expect_true($$ (select count(*) from realtime.messages where event = 'room_recaps') >= 1 $$,
  'grace: A may receive the room_recaps notice');
select tests.expect_count($$ select 1 from realtime.messages where event <> 'room_recaps' $$,
  0, 'grace: A may not receive any other event on the topic');
-- Every write path stays closed (42501).
select tests.expect_state($$ insert into public.messages (room_id, sender_id, kind, body)
  values ((select room_id from tests.made where label = 'G'), 'c2700000-0000-4000-8000-000000000002', 'text', 'x') $$,
  '42501', 'grace: A cannot send a message');
-- A valid path under {room_id}/{media_id}/ and the default status ('uploading'), so media_integrity (0015, a BEFORE
-- trigger that runs before the RLS check) passes and the 42501 comes from the insert policy under test.
select tests.expect_state($$ insert into public.media (id, room_id, uploader_id, kind, original_path, file_name, mime_type)
  select 'c2720000-0000-4000-8000-0000000000c2', room_id, 'c2700000-0000-4000-8000-000000000002', 'photo',
         room_id::text || '/c2720000-0000-4000-8000-0000000000c2/original.jpg', 'x.jpg', 'image/jpeg'
  from tests.made where label = 'G' $$, '42501', 'grace: A cannot add media');
select tests.expect_state($$ select public.set_qrewing_member((select room_id from tests.made where label = 'G'), false, false) $$,
  '42501', 'grace: A cannot change consent');
select tests.expect_state($$ select public.upsert_entry_profile((select room_id from tests.made where label = 'G'), 'A', '', '', '{}') $$,
  '42501', 'grace: A cannot save entry info');
select tests.expect_state($$ select public.set_my_status((select room_id from tests.made where label = 'G'), null) $$,
  '42501', 'grace: A cannot set a status');
update public.face_matches set excluded = true where enrollment_id = 'c2730000-0000-4000-8000-0000000000d1';
select tests.login('c2700000-0000-4000-8000-000000000001', false);
select tests.expect_state($$ select public.update_room_expiry((select room_id from tests.made where label = 'G'), now() + interval '1 hour') $$,
  '42501', 'grace: host cannot extend');
select tests.expect_state($$ select public.end_room((select room_id from tests.made where label = 'G')) $$,
  '42501', 'grace: host cannot end again (grace is not reset)');
select tests.expect_state($$ select public.set_qrewing_room((select room_id from tests.made where label = 'G'), true, false) $$,
  '42501', 'grace: host cannot change Qrewing AI');
-- An outsider reads nothing and receives nothing.
select tests.login('c2700000-0000-4000-8000-000000000004', true);
select tests.expect_true($$ tests.grace_visible((select room_id from tests.made where label = 'G')) = 0 $$,
  'grace: outsider reads nothing');
select tests.expect_count($$ select 1 from realtime.messages $$, 0, 'grace: outsider receives nothing');
reset role;
select tests.expect_true($$ (select not excluded from public.face_matches where enrollment_id = 'c2730000-0000-4000-8000-0000000000d1') $$,
  'grace: A cannot exclude a match (update had no effect)');

-- Grace over: the grace set reads 0 (and nothing is received).
update public.rooms set grace_until = now() - interval '1 minute' where id = (select room_id from tests.made where label = 'G');
set local role authenticated;
select tests.login('c2700000-0000-4000-8000-000000000002', true);
select tests.expect_true($$ tests.grace_visible((select room_id from tests.made where label = 'G')) = 0 $$,
  'grace over: A reads 0 of the grace set');
select tests.expect_count($$ select 1 from realtime.messages $$, 0, 'grace over: A receives nothing');
-- Expiry without grace (E expired in 7): 0 of the grace set.
select tests.expect_true($$ tests.grace_visible((select room_id from tests.made where label = 'E')) = 0 $$,
  'expiry has no grace: A reads 0 of the grace set');
reset role;
select tests.expect_true($$ (select grace_until is null from public.rooms where id = (select room_id from tests.made where label = 'E')) $$,
  'expiry leaves grace_until null');

-- Account-deletion end has no grace: a fresh open room H hosts, then prepare_account_deletion(H).
set local role authenticated;
select tests.login('c2700000-0000-4000-8000-000000000001', false);
select tests.expect_ok($$ insert into tests.made select 'D', r.id from public.create_room(
  p_name => 'QA delete', p_type => 'general', p_expires_at => now() + interval '3 hours', p_location_allowed => false) r $$,
  'create room D');
reset role;
select public.prepare_account_deletion('c2700000-0000-4000-8000-000000000001');
select tests.expect_true($$ (select deleted_at is not null and grace_until is null from public.rooms
  where id = (select room_id from tests.made where label = 'D')) $$, 'account-deletion end: deleted_at set, no grace');

-- Janitor cadence: the single room-janitor job runs every 5 minutes.
select tests.expect_true($$ (select count(*) = 1 and min(schedule) = '*/5 * * * *'
  and min(command) = 'select private.invoke_janitor()' from cron.job where jobname = 'room-janitor') $$,
  'room-janitor is one job at */5');

-- 8. Room delete cascades all six tables to 0 (usage keeps counts only, by design).
delete from public.rooms where id in (select room_id from tests.made);
select tests.expect_true($$ (select count(*) from public.qrewing_rooms where room_id in (select room_id from tests.made))
  + (select count(*) from public.qrewing_members where room_id in (select room_id from tests.made))
  + (select count(*) from public.entry_profiles where room_id in (select room_id from tests.made))
  + (select count(*) from public.message_triage where room_id in (select room_id from tests.made))
  + (select count(*) from public.room_recaps where room_id in (select room_id from tests.made))
  + (select count(*) from public.qrewing_matches where room_id in (select room_id from tests.made)) = 0 $$,
  'room delete cascades every table to 0');

select 'QREWING AI TESTS PASSED' as result;
rollback;

-- Leftover check (run after the ROLLBACK): must return 0.
select (select count(*) from auth.users where id::text like 'c2700000-%')
     + (select count(*) from public.messages where id in ('c2710000-0000-4000-8000-0000000000a1', 'c2710000-0000-4000-8000-0000000000b1'))
     + (select count(*) from public.media where id = 'c2720000-0000-4000-8000-0000000000c1')
     + (select count(*) from storage.objects where name like '%/c2720000-0000-4000-8000-0000000000c1/%')
     + (select count(*) from information_schema.schemata where schema_name = 'tests') as leftovers;
