-- Qrewing ask usage test (migration 0029; spec planning/QREWING_AI_SPEC_EN.md 10.2).
-- Rollback test: run on a database at 0028 (0029 NOT applied). The local runner pastes the 0029 migration at the
-- @@MIGRATION@@ marker line below. One transaction, ends with ROLLBACK. Success prints 'ASK USAGE TESTS PASSED';
-- the statement after ROLLBACK must then return leftovers = 0 (no test rows, no tests schema, no 0029 objects).
-- Rooms are plain uuids (qrewing_usage has no FK); users U1, U2 are plain uuids (user_id has no FK).

begin;
set local lock_timeout = '3s';

create schema tests;
grant usage on schema tests to authenticated, anon, service_role;
create function tests.expect_true(p_sql text, p_label text) returns void language plpgsql as $$
declare v boolean;
begin
  execute 'select (' || p_sql || ')' into v;
  if v is not true then
    raise exception 'FAIL: % (got %)', p_label, v;
  end if;
end;
$$;
create function tests.expect_state(p_sql text, p_state text, p_label text) returns void language plpgsql as $$
declare v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  if v_state is distinct from p_state then
    raise exception 'FAIL: % (expected %, got %)', p_label, p_state, coalesce(v_state, 'no error');
  end if;
end;
$$;
grant execute on all functions in schema tests to authenticated, anon, service_role;

-- 0. Before 0029: the 0027 check rejects 'ask'.
select tests.expect_state($$ select public.log_qrewing_usage('c2900000-0000-4000-8000-0000000000a1', 'ask', 'm', 1, 1) $$,
  '23514', 'before 0029: ask rejected');

-- @@MIGRATION supabase/migrations/20261104000029_qrewing_ask_usage.sql@@

-- 1. Logging: ask with user id, legacy 5-argument call (deployed v3), bad action rejected.
set local role service_role;
select public.log_qrewing_usage('c2900000-0000-4000-8000-0000000000a1', 'ask', 'm', 10, 2, 'c2900000-0000-4000-8000-000000000001');
select public.log_qrewing_usage('c2900000-0000-4000-8000-0000000000a1', 'ask', 'm', 10, 2, 'c2900000-0000-4000-8000-000000000001');
select public.log_qrewing_usage('c2900000-0000-4000-8000-0000000000a1', 'ask', 'm', 10, 2, 'c2900000-0000-4000-8000-000000000002');
select public.log_qrewing_usage(p_room_id => 'c2900000-0000-4000-8000-0000000000a1', p_action => 'triage', p_model => 'm',
  p_input_tokens => 5, p_output_tokens => 1);
select public.log_qrewing_usage('c2900000-0000-4000-8000-0000000000a2', 'ask', 'm', null, null, 'c2900000-0000-4000-8000-000000000001');
select tests.expect_state($$ select public.log_qrewing_usage('c2900000-0000-4000-8000-0000000000a1', 'chat', 'm', 1, 1) $$,
  '23514', 'unknown action rejected');
reset role;
-- an old ask row, outside a 24 h window
insert into private.qrewing_usage (room_id, action, model, user_id, created_at)
values ('c2900000-0000-4000-8000-0000000000a1', 'ask', 'm', 'c2900000-0000-4000-8000-000000000001', now() - interval '25 hours');

-- 2. Counting: per room, per user, by action, by window; null tokens stored as 0.
set local role service_role;
select tests.expect_true($$ public.qrewing_usage_count('c2900000-0000-4000-8000-0000000000a1', 'ask', now() - interval '24 hours') = 3 $$,
  'room count, window excludes the old row');
select tests.expect_true($$ public.qrewing_usage_count('c2900000-0000-4000-8000-0000000000a1', 'ask', now() - interval '24 hours',
  'c2900000-0000-4000-8000-000000000001') = 2 $$, 'user count in the room');
select tests.expect_true($$ public.qrewing_usage_count(p_room_id => 'c2900000-0000-4000-8000-0000000000a1', p_action => 'ask',
  p_since => now() - interval '48 hours', p_user_id => 'c2900000-0000-4000-8000-000000000001') = 3 $$, 'named args, wider window');
select tests.expect_true($$ public.qrewing_usage_count('c2900000-0000-4000-8000-0000000000a1', 'triage', now() - interval '1 hour') = 1 $$,
  'other action counted apart');
select tests.expect_true($$ public.qrewing_usage_count('c2900000-0000-4000-8000-0000000000a2', 'ask', now() - interval '1 hour',
  'c2900000-0000-4000-8000-000000000002') = 0 $$, 'other room, other user: 0');
reset role;
select tests.expect_true($$ (select input_tokens + output_tokens from private.qrewing_usage
  where room_id = 'c2900000-0000-4000-8000-0000000000a2') = 0 $$, 'null tokens stored as 0');

-- 3. Clients cannot call either function or read the table.
set local role authenticated;
select tests.expect_state($$ select public.qrewing_usage_count('c2900000-0000-4000-8000-0000000000a1', 'ask', now()) $$,
  '42501', 'authenticated cannot count');
select tests.expect_state($$ select public.log_qrewing_usage('c2900000-0000-4000-8000-0000000000a1', 'ask', 'm', 1, 1, null) $$,
  '42501', 'authenticated cannot log');
select tests.expect_state($$ select count(*) from private.qrewing_usage $$, '42501', 'authenticated cannot read usage');
reset role;
set local role anon;
select tests.expect_state($$ select public.qrewing_usage_count('c2900000-0000-4000-8000-0000000000a1', 'ask', now()) $$,
  '42501', 'anon cannot count');
reset role;
select tests.expect_true($$ (select count(*) from pg_proc where proname = 'log_qrewing_usage') = 1 $$, 'one log_qrewing_usage overload');
select tests.expect_true($$ (select bool_and(prosecdef and proconfig @> array['search_path=""'])
  from pg_proc where proname in ('log_qrewing_usage', 'qrewing_usage_count')) $$, 'security definer, empty search_path');

select 'ASK USAGE TESTS PASSED' as result;
rollback;

-- Leftover check (run after the ROLLBACK): must return 0 (no test rows, no tests schema, 0029 rolled back).
select (select count(*) from private.qrewing_usage where room_id::text like 'c2900000-%')
     + (select count(*) from information_schema.schemata where schema_name = 'tests')
     + (select count(*) from pg_proc where proname = 'qrewing_usage_count')
     + (select count(*) from information_schema.columns where table_schema = 'private'
          and table_name = 'qrewing_usage' and column_name = 'user_id') as leftovers;
