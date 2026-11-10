-- Running-crew #4 test: "<name> is OK (Emergency resolved)" is posted when the caller's Emergency ends, by
-- clear_my_status (I'm OK) or set_my_status (switching to another status), and only while a member of an open room. Requires migrations through 0023 (emergency_resolved_line).
-- One transaction, ends with ROLLBACK: leaves no data behind. Run as postgres (Supabase MCP execute_sql).
-- Success ends with the row 'EMERGENCY RESOLVED TESTS PASSED'.
--
-- Actors: H host, G guest member, O outsider (never joins).

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

grant execute on all functions in schema tests to authenticated;

insert into auth.users (instance_id, id, aud, role, email, is_anonymous, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'c2300000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'er-host@test.invalid', false, '{"display_name":"Host"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c2300000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', null, true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c2300000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', null, true, '{}', now(), now());

-- t.r room, t.token invite token, t.emg Emergency status id, t.rest 'Resting' status id.
select tests.login('c2300000-0000-4000-8000-000000000001', false);
set local role authenticated;
do $$
declare r public.rooms;
begin
  r := public.create_room('Emergency test', 'sports', now() + interval '1 day', false, array['Resting']);
  perform set_config('t.r', r.id::text, true);
  perform set_config('t.token', r.invite_token, true);
end $$;
reset role;

select set_config('t.emg', (select id::text from public.status_definitions
                             where room_id = current_setting('t.r')::uuid and is_emergency), true);
select set_config('t.rest', (select id::text from public.status_definitions
                              where room_id = current_setting('t.r')::uuid and label = 'Resting'), true);
select tests.expect(current_setting('t.emg') <> '' and current_setting('t.rest') <> '', 'room has Emergency and Resting');

select tests.login('c2300000-0000-4000-8000-000000000002', true);
set local role authenticated;
select public.join_room(null, current_setting('t.token'));
reset role;

create function tests.resolved_lines() returns bigint language sql as $$
  select count(*) from public.messages
   where room_id = current_setting('t.r')::uuid and kind = 'status' and body like '% is OK (Emergency resolved)%';
$$;

-- 1. Clearing with no status set posts nothing.
select tests.login('c2300000-0000-4000-8000-000000000002', true);
set local role authenticated;
select public.clear_my_status(current_setting('t.r')::uuid);
reset role;
select tests.expect(tests.resolved_lines() = 0, 'no line when no status was set');

-- 2. Emergency, then I'm OK: exactly one resolved line, from G, and the status row is gone.
select tests.login('c2300000-0000-4000-8000-000000000002', true);
set local role authenticated;
select public.set_my_status(current_setting('t.r')::uuid, current_setting('t.emg')::uuid);
select public.clear_my_status(current_setting('t.r')::uuid);
reset role;
select tests.expect(tests.resolved_lines() = 1, 'one resolved line after I''m OK');
select tests.expect((select sender_id from public.messages
                      where room_id = current_setting('t.r')::uuid and body like '% is OK (Emergency resolved)')
                    = 'c2300000-0000-4000-8000-000000000002', 'resolved line is from the Emergency sender');
select tests.expect(not exists (select 1 from public.member_status
                                 where room_id = current_setting('t.r')::uuid
                                   and user_id = 'c2300000-0000-4000-8000-000000000002'), 'status row deleted');

-- 3. A second clear (double tap) posts nothing more.
select tests.login('c2300000-0000-4000-8000-000000000002', true);
set local role authenticated;
select public.clear_my_status(current_setting('t.r')::uuid);
reset role;
select tests.expect(tests.resolved_lines() = 1, 'no second line on a repeated clear');

-- 4. Clearing an ordinary status posts nothing.
select tests.login('c2300000-0000-4000-8000-000000000002', true);
set local role authenticated;
select public.set_my_status(current_setting('t.r')::uuid, current_setting('t.rest')::uuid);
select public.clear_my_status(current_setting('t.r')::uuid);
reset role;
select tests.expect(tests.resolved_lines() = 1, 'no line when clearing a non-Emergency status');

-- 5. An outsider calling it for this room posts nothing and changes nothing.
select tests.login('c2300000-0000-4000-8000-000000000002', true);
set local role authenticated;
select public.set_my_status(current_setting('t.r')::uuid, current_setting('t.emg')::uuid);
reset role;
select tests.login('c2300000-0000-4000-8000-000000000003', true);
set local role authenticated;
select public.clear_my_status(current_setting('t.r')::uuid);
reset role;
select tests.expect(tests.resolved_lines() = 1, 'outsider posts no line');
select tests.expect(exists (select 1 from public.member_status
                             where room_id = current_setting('t.r')::uuid
                               and user_id = 'c2300000-0000-4000-8000-000000000002'), 'outsider cannot clear G''s Emergency');

-- set_my_status. G's Emergency from case 5 is still open here.
create function tests.my_lines() returns bigint language sql as $$
  select count(*) from public.messages
   where room_id = current_setting('t.r')::uuid and sender_id = 'c2300000-0000-4000-8000-000000000002';
$$;
-- 6. Emergency → Resting: one status line that says both.
select set_config('t.n', tests.my_lines()::text, true);
select tests.login('c2300000-0000-4000-8000-000000000002', true);
set local role authenticated;
select public.set_my_status(current_setting('t.r')::uuid, current_setting('t.rest')::uuid);
reset role;
select tests.expect(tests.my_lines() = current_setting('t.n')::bigint + 1, 'Emergency to Resting posts 1 line');
select tests.expect(exists (select 1 from public.messages
                             where room_id = current_setting('t.r')::uuid and kind = 'status'
                               and body like '% is OK (Emergency resolved) · Resting'),
                    'Emergency to Resting line says resolved and the new status');

-- 7. Resting → Resting: one status line, no resolved line.
select set_config('t.n', tests.my_lines()::text, true);
select tests.login('c2300000-0000-4000-8000-000000000002', true);
set local role authenticated;
select public.set_my_status(current_setting('t.r')::uuid, current_setting('t.rest')::uuid);
reset role;
select tests.expect(tests.my_lines() = current_setting('t.n')::bigint + 1, 'Resting to Resting posts 1 line');
select tests.expect(tests.resolved_lines() = 2, 'Resting to Resting posts no resolved line');

-- 8. Emergency → Emergency: no resolved line (each Emergency posts its own needs-help line, as before).
select tests.login('c2300000-0000-4000-8000-000000000002', true);
set local role authenticated;
select public.set_my_status(current_setting('t.r')::uuid, current_setting('t.emg')::uuid);
select public.set_my_status(current_setting('t.r')::uuid, current_setting('t.emg')::uuid);
reset role;
select tests.expect(tests.resolved_lines() = 2, 'Emergency to Emergency posts no resolved line');

-- 9. Expired room with G's Emergency still set: I'm OK deletes the row and posts nothing.
update public.rooms set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'
 where id = current_setting('t.r')::uuid;
select set_config('t.n', tests.my_lines()::text, true);
select tests.login('c2300000-0000-4000-8000-000000000002', true);
set local role authenticated;
select public.clear_my_status(current_setting('t.r')::uuid);
reset role;
select tests.expect(not exists (select 1 from public.member_status
                                 where room_id = current_setting('t.r')::uuid
                                   and user_id = 'c2300000-0000-4000-8000-000000000002'), 'expired room: row deleted');
select tests.expect(tests.my_lines() = current_setting('t.n')::bigint, 'expired room: no message posted');

-- 10. anon cannot call either function.
select tests.expect(not has_function_privilege('anon', 'public.clear_my_status(uuid)', 'execute'), 'anon: no clear_my_status');
select tests.expect(not has_function_privilege('anon', 'public.set_my_status(uuid, uuid)', 'execute'), 'anon: no set_my_status');

select 'EMERGENCY RESOLVED TESTS PASSED';

rollback;
