-- Entry questions test (migration 0028 entry_questions; spec planning/QREWING_AI_SPEC_EN.md 9.2).
-- Rollback test: run on a database at 0027 (0028 NOT applied). Paste the whole 0028 migration at the
-- @@MIGRATION@@ marker line below (the local runner does this). One transaction, ends with ROLLBACK, so the
-- DDL and all test data are rolled back. Success prints 'ENTRY QUESTIONS TESTS PASSED'; the statement
-- after ROLLBACK must then return leftovers = 0 (no test rows, no tests schema, no 0028 objects).
--
-- Actors (temporary auth.users rows): H host, A and B anonymous members, O anonymous outsider.
-- Legacy rooms (made at 0027, before the migration runs): L1 event with entry required and profiles from
-- A (all four fields) and B (headline only); L2 event with entry off but A's profile; L3 event with AI on
-- and entry off and no profile; L4 general. After the migration: E and F (event), G (general), E2 (event).

begin;
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

create table tests.made (label text primary key, room_id uuid);
create table tests.before (user_id uuid, room_id uuid, updated_at timestamptz);
-- Room id by label, and question id by room label and position (definer: reads past RLS).
create function tests.rid(p_label text) returns uuid language sql stable security definer as $$
  select room_id from tests.made where label = p_label $$;
grant all on tests.made, tests.before to authenticated, service_role;
grant execute on all functions in schema tests to authenticated, anon, service_role;

insert into auth.users (instance_id, id, aud, role, email, is_anonymous, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'c2800000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'qa-host-0028@test.invalid', false, '{"display_name":"QA Host"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c2800000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c2800000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c2800000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', null, true, '{}', now(), now());

-- Legacy data at 0027 ------------------------------------------------------------
set local role authenticated;
select tests.login('c2800000-0000-4000-8000-000000000001', false);
insert into tests.made select 'L1', r.id from public.create_room(p_name => 'QA L1', p_type => 'event',
  p_expires_at => now() + interval '3 hours', p_location_allowed => false) r;
insert into tests.made select 'L2', r.id from public.create_room(p_name => 'QA L2', p_type => 'event',
  p_expires_at => now() + interval '3 hours', p_location_allowed => false) r;
insert into tests.made select 'L3', r.id from public.create_room(p_name => 'QA L3', p_type => 'event',
  p_expires_at => now() + interval '3 hours', p_location_allowed => false) r;
insert into tests.made select 'L4', r.id from public.create_room(p_name => 'QA L4', p_type => 'general',
  p_expires_at => now() + interval '3 hours', p_location_allowed => false) r;
select public.set_qrewing_room(tests.rid('L1'), true, true);
select public.set_qrewing_room(tests.rid('L3'), true, false);
reset role;
insert into public.room_members (room_id, user_id)
select m.room_id, u.id from tests.made m
cross join (values ('c2800000-0000-4000-8000-000000000002'::uuid), ('c2800000-0000-4000-8000-000000000003'::uuid)) u(id);
set local role authenticated;
select tests.login('c2800000-0000-4000-8000-000000000002', true);
select public.upsert_entry_profile(tests.rid('L1'), 'Designer', 'Agentic AI', 'A cofounder', array['https://a.example/me']);
select public.upsert_entry_profile(tests.rid('L2'), 'Only headline', '', '', '{}');
select tests.login('c2800000-0000-4000-8000-000000000003', true);
select public.upsert_entry_profile(tests.rid('L1'), 'Student', '', '', '{}');
reset role;
-- Make the legacy updated_at values distinct from now() so "kept" is observable.
alter table public.entry_profiles disable trigger entry_profiles_set_updated_at;
update public.entry_profiles set updated_at = now() - interval '10 minutes' where room_id in (select room_id from tests.made);
alter table public.entry_profiles enable trigger entry_profiles_set_updated_at;
insert into tests.before select user_id, room_id, updated_at from public.entry_profiles where room_id in (select room_id from tests.made);

-- Migration 0028 --------------------------------------------------------------------
-- @@MIGRATION supabase/migrations/20261104000028_entry_questions.sql@@

create function tests.qid(p_label text, p_pos integer) returns text language sql stable security definer as $$
  select q.id::text from public.entry_questions q where q.room_id = tests.rid(p_label) and q.position = p_pos $$;
create function tests.visible_questions(p_room uuid) returns bigint language sql as $$
  select count(*) from public.entry_questions where room_id = p_room $$;
grant execute on all functions in schema tests to authenticated, anon, service_role;

-- 0. Schema, RLS and grants.
select tests.expect_true($$ (select c.relrowsecurity from pg_class c where c.oid = 'public.entry_questions'::regclass) $$,
  'RLS on entry_questions');
select tests.expect_true($$ not has_table_privilege('authenticated', 'public.entry_questions', 'insert')
  and not has_table_privilege('authenticated', 'public.entry_questions', 'update')
  and not has_table_privilege('authenticated', 'public.entry_questions', 'delete')
  and has_table_privilege('authenticated', 'public.entry_questions', 'select') $$,
  'clients only select entry_questions');
select tests.expect_true($$ not has_table_privilege('anon', 'public.entry_questions', 'select') $$,
  'anon cannot read entry_questions');
select tests.expect_true($$ not has_function_privilege('anon', 'public.set_entry_questions(uuid, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.upsert_entry_answers(uuid, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.set_qrewing_room(uuid, boolean, boolean)', 'execute')
  and has_function_privilege('authenticated', 'public.set_entry_questions(uuid, jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.upsert_entry_answers(uuid, jsonb)', 'execute') $$,
  'RPC grants: authenticated only');
select tests.expect_true($$ not has_function_privilege('authenticated', 'private.entry_room_lock_key(uuid)', 'execute') $$,
  'lock-key helper is not client-callable');

-- 1. Backfill.
select tests.expect_true($$ (select count(*) from public.entry_questions where room_id = tests.rid('L1')) = 4
  and (select count(*) from public.entry_questions where room_id = tests.rid('L2')) = 4
  and (select count(*) from public.entry_questions where room_id = tests.rid('L3')) = 0
  and (select count(*) from public.entry_questions where room_id = tests.rid('L4')) = 0 $$,
  'backfill: default four for entry_required or existing profiles only');
select tests.expect_true($$ (select string_agg(position || ':' || kind || ':' || prompt || ':' || required, '|' order by position)
  from public.entry_questions where room_id = tests.rid('L1'))
  = '0:short:Headline:true|1:long:Interests:false|2:long:Looking for:false|3:links:Links:false' $$,
  'backfill: the default four in order');
select tests.expect_true($$ (select answers from public.entry_profiles where room_id = tests.rid('L1')
  and user_id = 'c2800000-0000-4000-8000-000000000002')
  = jsonb_build_object(tests.qid('L1', 0), 'Designer', tests.qid('L1', 1), 'Agentic AI',
      tests.qid('L1', 2), 'A cofounder', tests.qid('L1', 3), jsonb_build_array('https://a.example/me')) $$,
  'backfill: full profile converted');
select tests.expect_true($$ (select answers from public.entry_profiles where room_id = tests.rid('L1')
  and user_id = 'c2800000-0000-4000-8000-000000000003') = jsonb_build_object(tests.qid('L1', 0), 'Student') $$,
  'backfill: blank fields left out');
select tests.expect_true($$ (select answers from public.entry_profiles where room_id = tests.rid('L2')
  and user_id = 'c2800000-0000-4000-8000-000000000002') = jsonb_build_object(tests.qid('L2', 0), 'Only headline') $$,
  'backfill: profile in a room with entry off converted');
select tests.expect_true($$ not exists (select 1 from public.entry_profiles e join tests.before b using (room_id, user_id)
  where e.updated_at is distinct from b.updated_at) $$, 'backfill: updated_at kept');
select tests.expect_true($$ (select headline || interests || looking_for from public.entry_profiles
  where room_id = tests.rid('L1') and user_id = 'c2800000-0000-4000-8000-000000000002') = 'DesignerAgentic AIA cofounder' $$,
  'backfill: old columns kept');
select tests.expect_true($$ exists (select 1 from pg_trigger where tgname = 'entry_profiles_set_updated_at'
  and tgrelid = 'public.entry_profiles'::regclass and tgenabled = 'O') $$, 'backfill: updated_at trigger enabled again');
set local role authenticated;
select tests.login('c2800000-0000-4000-8000-000000000001', false);
select tests.expect_state($$ select public.set_entry_questions(tests.rid('L1'), '[{"kind":"short","prompt":"X"}]') $$,
  '55000', 'backfill: a room with converted profiles is locked');

-- New rooms: E, F (event), G (general), E2 (event). A and B join all of them.
insert into tests.made select 'E', r.id from public.create_room(p_name => 'QA E', p_type => 'event',
  p_expires_at => now() + interval '3 hours', p_location_allowed => false) r;
insert into tests.made select 'F', r.id from public.create_room(p_name => 'QA F', p_type => 'event',
  p_expires_at => now() + interval '3 hours', p_location_allowed => false) r;
insert into tests.made select 'G', r.id from public.create_room(p_name => 'QA G', p_type => 'general',
  p_expires_at => now() + interval '3 hours', p_location_allowed => false) r;
insert into tests.made select 'E2', r.id from public.create_room(p_name => 'QA E2', p_type => 'event',
  p_expires_at => now() + interval '3 hours', p_location_allowed => false) r;
reset role;
insert into public.room_members (room_id, user_id)
select m.room_id, u.id from tests.made m
cross join (values ('c2800000-0000-4000-8000-000000000002'::uuid), ('c2800000-0000-4000-8000-000000000003'::uuid)) u(id)
where m.label in ('E', 'F', 'G', 'E2');

-- 2. set_entry_questions: host only, event only, caps, types.
set local role authenticated;
select tests.login('c2800000-0000-4000-8000-000000000002', true);
select tests.expect_state($$ select public.set_entry_questions(tests.rid('E'), '[{"kind":"short","prompt":"X"}]') $$,
  '42501', 'member (non-host) cannot set questions');
select tests.login('c2800000-0000-4000-8000-000000000004', true);
select tests.expect_state($$ select public.set_entry_questions(tests.rid('E'), '[{"kind":"short","prompt":"X"}]') $$,
  '42501', 'outsider cannot set questions');
select tests.login('c2800000-0000-4000-8000-000000000001', false);
select tests.expect_state($$ select public.set_entry_questions(tests.rid('G'), '[{"kind":"short","prompt":"X"}]') $$,
  '22023', 'general room rejected');
select tests.expect_state($$ select public.set_entry_questions(tests.rid('E'), '[]') $$, '22023', '0 questions rejected');
select tests.expect_state($$ select public.set_entry_questions(tests.rid('E'), null) $$, '22023', 'null list rejected');
select tests.expect_state($$ select public.set_entry_questions(tests.rid('E'), '{"kind":"short","prompt":"X"}') $$,
  '22023', 'non-array rejected');
select tests.expect_state($$ select public.set_entry_questions(tests.rid('E'),
  (select jsonb_agg(jsonb_build_object('kind', 'short', 'prompt', 'Q' || i)) from generate_series(1, 9) i)) $$,
  '22023', '9 questions rejected');
select tests.expect_state($$ select public.set_entry_questions(tests.rid('E'), '[{"kind":"choice","prompt":"X"}]') $$,
  '22023', 'unknown kind rejected');
select tests.expect_state($$ select public.set_entry_questions(tests.rid('E'), '[{"prompt":"X"}]') $$,
  '22023', 'missing kind rejected');
select tests.expect_state($$ select public.set_entry_questions(tests.rid('E'), '[{"kind":"short","prompt":"   "}]') $$,
  '22023', 'blank prompt rejected');
select tests.expect_state($$ select public.set_entry_questions(tests.rid('E'),
  jsonb_build_array(jsonb_build_object('kind', 'short', 'prompt', repeat('p', 121)))) $$, '22023', '121-char prompt rejected');
select tests.expect_state($$ select public.set_entry_questions(tests.rid('E'), '[{"kind":"short","prompt":5}]') $$,
  '22023', 'non-string prompt rejected');
select tests.expect_state($$ select public.set_entry_questions(tests.rid('E'), '[{"kind":"short","prompt":"X","required":"yes"}]') $$,
  '22023', 'non-boolean required rejected');
select tests.expect_state($$ select public.set_entry_questions(tests.rid('E'), '["X"]') $$, '22023', 'non-object item rejected');
select tests.expect_ok($$ select public.set_entry_questions(tests.rid('E'),
  (select jsonb_agg(jsonb_build_object('kind', 'long', 'prompt', 'Q' || i) order by i) from generate_series(1, 8) i)) $$,
  '8 questions accepted');
select tests.expect_true($$ (select count(*) = 8 and min(position) = 0 and max(position) = 7
  from public.entry_questions where room_id = tests.rid('E')) $$, '8 questions at positions 0..7');
select tests.expect_ok($$ select public.set_entry_questions(tests.rid('E'), jsonb_build_array(
  jsonb_build_object('kind', 'short', 'prompt', '  What do you do?  ', 'required', true),
  jsonb_build_object('kind', 'long', 'prompt', 'Topics you want to talk about'),
  jsonb_build_object('kind', 'links', 'prompt', 'Portfolio', 'required', false),
  jsonb_build_object('kind', 'short', 'prompt', repeat('t', 120), 'id', 'client-key-ignored'))) $$,
  'list replaced with 4 questions (extra keys ignored)');
select tests.expect_true($$ (select string_agg(position || ':' || kind || ':' || left(prompt, 16) || ':' || required, '|' order by position)
  from public.entry_questions where room_id = tests.rid('E'))
  = '0:short:What do you do?:true|1:long:Topics you want :false|2:links:Portfolio:false|3:short:tttttttttttttttt:false' $$,
  'replace: whole list, trimmed prompt, required defaults to false');
select tests.expect_true($$ (select count(*) from public.set_entry_questions(tests.rid('F'), jsonb_build_array(
  jsonb_build_object('kind', 'long', 'prompt', 'About you', 'required', true),
  jsonb_build_object('kind', 'links', 'prompt', 'Links'),
  jsonb_build_object('kind', 'short', 'prompt', 'Role')))) = 3 $$, 'F: returns the 3 rows');

-- 3. set_qrewing_room: entry_required needs at least one question.
select tests.expect_state($$ select public.set_qrewing_room(tests.rid('E2'), true, true) $$,
  '22023', 'entry_required without questions rejected');
select tests.expect_ok($$ select public.set_qrewing_room(tests.rid('E2'), true, false) $$, 'AI on, entry off, no questions: ok');
select tests.expect_ok($$ select public.set_qrewing_room(tests.rid('E'), true, true) $$, 'entry_required with questions: ok');
select tests.expect_ok($$ select public.set_qrewing_room(tests.rid('F'), true, true) $$, 'F: entry_required ok');

-- 4. Reads: members only; no direct writes.
select tests.login('c2800000-0000-4000-8000-000000000002', true);
select tests.expect_true($$ tests.visible_questions(tests.rid('E')) = 4 $$, 'member reads the questions');
select tests.expect_state($$ insert into public.entry_questions (room_id, position, kind, prompt)
  values (tests.rid('E'), 5, 'short', 'X') $$, '42501', 'member cannot insert a question directly');
select tests.expect_state($$ delete from public.entry_questions where room_id = tests.rid('E') $$,
  '42501', 'member cannot delete questions directly');
select tests.login('c2800000-0000-4000-8000-000000000004', true);
select tests.expect_true($$ tests.visible_questions(tests.rid('E')) = 0 $$, 'outsider reads 0 questions');

-- 5. upsert_entry_answers validation.
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('E'),
  jsonb_build_object(tests.qid('E', 0), 'X')) $$, '42501', 'outsider cannot answer');
select tests.login('c2800000-0000-4000-8000-000000000002', true);
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('G'), '{}') $$,
  '22023', 'room without questions rejected');
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('E'), '["X"]') $$, '22023', 'non-object answers rejected');
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('E'), jsonb_build_object(
  tests.qid('E', 0), 'X', gen_random_uuid()::text, 'Y')) $$, '22023', 'unknown question id rejected');
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('E'), jsonb_build_object(
  tests.qid('E', 0), 'X', tests.qid('L1', 1), 'Y')) $$, '22023', 'another room''s question id rejected');
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('E'), '{}') $$,
  '22023', 'missing required answer rejected');
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('E'), jsonb_build_object(tests.qid('E', 0), '   ')) $$,
  '22023', 'blank required answer rejected');
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('E'), jsonb_build_object(tests.qid('E', 0), null)) $$,
  '22023', 'null required answer rejected');
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('E'), jsonb_build_object(tests.qid('E', 0), 5)) $$,
  '22023', 'number for a short answer rejected');
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('E'), jsonb_build_object(
  tests.qid('E', 0), 'X', tests.qid('E', 1), jsonb_build_array('a'))) $$, '22023', 'array for a long answer rejected');
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('E'), jsonb_build_object(
  tests.qid('E', 0), 'X', tests.qid('E', 2), 'https://a.example')) $$, '22023', 'string for a links answer rejected');
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('E'), jsonb_build_object(
  tests.qid('E', 0), 'X', tests.qid('E', 2), jsonb_build_array(1))) $$, '22023', 'non-string link rejected');
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('E'), jsonb_build_object(tests.qid('E', 0), repeat('s', 81))) $$,
  '22023', '81-char short answer rejected');
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('E'), jsonb_build_object(
  tests.qid('E', 0), 'X', tests.qid('E', 1), repeat('l', 301))) $$, '22023', '301-char long answer rejected');
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('E'), jsonb_build_object(
  tests.qid('E', 0), 'X', tests.qid('E', 2), jsonb_build_array('http://a.example'))) $$, '22023', 'http:// link rejected');
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('E'), jsonb_build_object(
  tests.qid('E', 0), 'X', tests.qid('E', 2), jsonb_build_array('HTTPS://a.example'))) $$, '22023', 'G1: uppercase HTTPS:// link rejected (case-sensitive)');
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('E'), jsonb_build_object(
  tests.qid('E', 0), 'X', tests.qid('E', 2), jsonb_build_array('https://a.example/x y'))) $$, '22023', 'link with a space rejected');
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('E'), jsonb_build_object(
  tests.qid('E', 0), 'X', tests.qid('E', 2), jsonb_build_array('https://' || repeat('a', 193)))) $$, '22023', '201-char link rejected');
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('E'), jsonb_build_object(
  tests.qid('E', 0), 'X', tests.qid('E', 2),
  jsonb_build_array('https://a.example', 'https://b.example', 'https://c.example', 'https://d.example'))) $$,
  '22023', '4 links rejected');
-- G2: a required links question answered only with blank strings. Questions are set for this check and put back.
select tests.login('c2800000-0000-4000-8000-000000000001', false);
select tests.expect_ok($$ select public.set_entry_questions(tests.rid('E'), jsonb_build_array(
  jsonb_build_object('kind', 'links', 'prompt', 'Portfolio', 'required', true))) $$, 'G2 setup: one required links question');
select tests.login('c2800000-0000-4000-8000-000000000002', true);
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('E'), jsonb_build_object(
  tests.qid('E', 0), jsonb_build_array('  '))) $$, '22023', 'G2: required links answered only with blanks rejected');
select tests.login('c2800000-0000-4000-8000-000000000001', false);
select tests.expect_ok($$ select public.set_entry_questions(tests.rid('E'), jsonb_build_array(
  jsonb_build_object('kind', 'short', 'prompt', '  What do you do?  ', 'required', true),
  jsonb_build_object('kind', 'long', 'prompt', 'Topics you want to talk about'),
  jsonb_build_object('kind', 'links', 'prompt', 'Portfolio', 'required', false),
  jsonb_build_object('kind', 'short', 'prompt', repeat('t', 120), 'id', 'client-key-ignored'))) $$,
  'G2 teardown: questions put back (G3: the 120-char prompt is accepted)');
select tests.login('c2800000-0000-4000-8000-000000000002', true);
select tests.expect_true($$ not exists (select 1 from public.entry_profiles where room_id = tests.rid('E')) $$,
  'no row written by any rejected call');

-- 6. Saves, normalization and the derived columns.
select tests.expect_ok($$ select public.upsert_entry_answers(tests.rid('E'), jsonb_build_object(
  tests.qid('E', 0), '  Founder  ', tests.qid('E', 1), repeat('l', 300),
  tests.qid('E', 2), jsonb_build_array(' https://a.example/me ', '  ', 'https://' || repeat('b', 192)),
  tests.qid('E', 3), '')) $$, 'A saves (300-char long, 200-char link, blank optional)');
select tests.expect_true($$ (select answers = jsonb_build_object(tests.qid('E', 0), 'Founder', tests.qid('E', 1), repeat('l', 300),
    tests.qid('E', 2), jsonb_build_array('https://a.example/me', 'https://' || repeat('b', 192)))
  and headline = 'Founder' and links = array['https://a.example/me', 'https://' || repeat('b', 192)]
  and interests = '' and looking_for = ''
  from public.entry_profiles where room_id = tests.rid('E') and user_id = 'c2800000-0000-4000-8000-000000000002') $$,
  'stored: trimmed, blanks left out, headline and links derived');
select tests.expect_ok($$ select public.upsert_entry_answers(tests.rid('E'), jsonb_build_object(tests.qid('E', 0), repeat('s', 80))) $$,
  'G3: 80-char short answer accepted');
select tests.expect_ok($$ select public.upsert_entry_answers(tests.rid('E'), jsonb_build_object(tests.qid('E', 0), 'Designer')) $$,
  'A updates with only the required answer');
select tests.expect_true($$ (select answers = jsonb_build_object(tests.qid('E', 0), 'Designer') and headline = 'Designer'
  and links = '{}' from public.entry_profiles where room_id = tests.rid('E') and user_id = 'c2800000-0000-4000-8000-000000000002') $$,
  'update replaces all answers');
-- F: the first short question is at position 2, and it is optional.
select tests.login('c2800000-0000-4000-8000-000000000003', true);
select tests.expect_ok($$ select public.upsert_entry_answers(tests.rid('F'), jsonb_build_object(tests.qid('F', 0), 'Hi')) $$,
  'B saves F without the optional short answer');
select tests.expect_true($$ (select headline = '' and links = '{}' from public.entry_profiles
  where room_id = tests.rid('F') and user_id = 'c2800000-0000-4000-8000-000000000003') $$, 'no short answer: headline is empty');
select tests.expect_ok($$ select public.upsert_entry_answers(tests.rid('F'), jsonb_build_object(
  tests.qid('F', 0), 'Hi', tests.qid('F', 1), jsonb_build_array('https://b.example'), tests.qid('F', 2), 'PM')) $$,
  'B saves F with all answers');
select tests.expect_true($$ (select headline = 'PM' and links = array['https://b.example'] from public.entry_profiles
  where room_id = tests.rid('F') and user_id = 'c2800000-0000-4000-8000-000000000003') $$,
  'headline from the first short question, links from the first links question');
-- Converted legacy room: answers keyed by the backfilled ids work, and the old RPC still works.
select tests.expect_ok($$ select public.upsert_entry_answers(tests.rid('L1'), jsonb_build_object(
  tests.qid('L1', 0), 'Student 2', tests.qid('L1', 3), jsonb_build_array('https://s.example'))) $$, 'B answers in a backfilled room');
select tests.expect_ok($$ select public.upsert_entry_profile(tests.rid('L2'), 'Legacy', '', '', '{}') $$,
  'old upsert_entry_profile stays callable');

-- 7. Lock after the first answer.
select tests.login('c2800000-0000-4000-8000-000000000001', false);
select tests.expect_state($$ select public.set_entry_questions(tests.rid('E'), '[{"kind":"short","prompt":"X"}]') $$,
  '55000', 'questions are locked after the first answer');
select tests.expect_true($$ tests.visible_questions(tests.rid('E')) = 4 $$, 'locked list unchanged');
reset role;
select tests.expect_state($$ update public.entry_profiles set answers = '[]' where room_id = tests.rid('E') $$,
  '23514', 'table: answers must be an object');
select tests.expect_state($$ update public.entry_profiles set headline = ' x' where room_id = tests.rid('E') $$,
  '23514', 'table: headline still trimmed');
select tests.expect_ok($$ update public.entry_profiles set headline = '' where room_id = tests.rid('E') $$,
  'table: empty headline allowed');

-- 8. Expiry and early end: no reads, no writes.
update public.rooms set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' where id = tests.rid('E');
set local role authenticated;
select tests.login('c2800000-0000-4000-8000-000000000002', true);
select tests.expect_true($$ tests.visible_questions(tests.rid('E')) = 0 $$, 'expired: member reads 0 questions');
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('E'), jsonb_build_object(tests.qid('E', 0), 'X')) $$,
  '42501', 'expired: member cannot answer');
select tests.login('c2800000-0000-4000-8000-000000000001', false);
select tests.expect_state($$ select public.set_entry_questions(tests.rid('E'), '[{"kind":"short","prompt":"X"}]') $$,
  '42501', 'expired: host cannot set questions');
select tests.expect_ok($$ select public.end_room(tests.rid('F')) $$, 'host ends F early (grace)');
select tests.login('c2800000-0000-4000-8000-000000000003', true);
select tests.expect_true($$ tests.visible_questions(tests.rid('F')) = 0 $$, 'grace: member reads 0 questions');
select tests.expect_state($$ select public.upsert_entry_answers(tests.rid('F'), jsonb_build_object(tests.qid('F', 0), 'X')) $$,
  '42501', 'grace: member cannot answer');
reset role;

-- 9. Room delete cascades the questions.
delete from public.rooms where id in (select room_id from tests.made);
select tests.expect_true($$ (select count(*) from public.entry_questions where room_id in (select room_id from tests.made))
  + (select count(*) from public.entry_profiles where room_id in (select room_id from tests.made)) = 0 $$,
  'room delete cascades questions and answers');

select 'ENTRY QUESTIONS TESTS PASSED' as result;
rollback;

-- Leftover check (run after the ROLLBACK): must return 0. The last three terms prove the migration rolled
-- back too (no entry_questions table, no answers column, set_qrewing_room is the 0027 body).
select (select count(*) from auth.users where id::text like 'c2800000-%')
     + (select count(*) from information_schema.schemata where schema_name = 'tests')
     + (select count(*) from pg_class where oid = to_regclass('public.entry_questions'))
     + (select count(*) from information_schema.columns where table_schema = 'public'
          and table_name = 'entry_profiles' and column_name = 'answers')
     + (select count(*) from pg_proc where proname = 'set_qrewing_room' and prosrc like '%entry question%') as leftovers;
