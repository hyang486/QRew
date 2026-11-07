-- Chat paging over more than one page (supervisor note N10).
-- Replays the client's paging (mobile/src/lib/chat.ts fetchMessages + loadOlder) as a room member:
--   order by created_at desc, id desc, limit 50; next page uses created_at <= oldest seen; de-duplicate by id;
--   stop when a page returns fewer than 50 rows (hasMore = false).
-- Seeds 130 text messages, with tie groups straddling the first two page boundaries.
-- Runs inside one transaction and ends with ROLLBACK, so it leaves no data behind.
-- Requires migrations through messages_server_created_at (20261104000011).
-- Run as the database owner (postgres), e.g. Supabase MCP `execute_sql` with this file's contents.
-- Success ends with the row 'CHAT PAGING TESTS PASSED'.

begin;

-- Fixed identities (prefix b0000000 so they never collide with rls_test.sql).
insert into auth.users (instance_id, id, aud, role, email, is_anonymous, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'b0000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'paging-host@test.invalid', false, '{"display_name":"Host"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b0000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', null, true, '{}', now(), now());

select set_config('request.jwt.claims',
  json_build_object('sub', 'b0000000-0000-4000-8000-000000000001', 'role', 'authenticated', 'is_anonymous', false)::text, true);
set local role authenticated;
do $$
declare r public.rooms;
begin
  r := public.create_room('Paging', 'general', now() + interval '1 day', false, null);
  perform set_config('t.r', r.id::text, true);
  perform set_config('t.r_token', r.invite_token, true);
end $$;
reset role;

select set_config('request.jwt.claims',
  json_build_object('sub', 'b0000000-0000-4000-8000-000000000002', 'role', 'authenticated', 'is_anonymous', true)::text, true);
set local role authenticated;
select public.join_room(null, current_setting('t.r_token'));
reset role;

-- Seed with explicit, distinct timestamps. The F7 trigger would set every row to the same now(),
-- so it is disabled for the seed only (inside this transaction; ROLLBACK restores it).
-- Message n (1 = newest) is n seconds old, except the tie groups:
--   n 48..53 share one timestamp (straddles the page-1 boundary at row 50),
--   n 97..101 share one timestamp (straddles the page-2 boundary).
alter table public.messages disable trigger messages_set_created_at;
insert into public.messages (room_id, sender_id, kind, body, created_at)
select current_setting('t.r')::uuid, 'b0000000-0000-4000-8000-000000000002', 'text', 'm' || n,
       now() - make_interval(secs => case when n between 48 and 53 then 48
                                          when n between 97 and 101 then 97
                                          else n end)
from generate_series(1, 130) n;
alter table public.messages enable trigger messages_set_created_at;

-- Replay the client paging as the member.
select set_config('request.jwt.claims',
  json_build_object('sub', 'b0000000-0000-4000-8000-000000000002', 'role', 'authenticated', 'is_anonymous', true)::text, true);
set local role authenticated;
do $$
declare
  v_room uuid := current_setting('t.r')::uuid;
  v_before timestamptz;
  v_seen uuid[] := '{}';
  v_rows int;
  v_new int;
  v_pages int := 0;
  v_oldest timestamptz;
  v_expected uuid[];
  v_total int;
  r record;
begin
  loop
    v_pages := v_pages + 1;
    if v_pages > 20 then
      raise exception 'FAIL: paging did not terminate';
    end if;
    v_rows := 0; v_new := 0;
    for r in
      select id, created_at from public.messages
      where room_id = v_room and (v_before is null or created_at <= v_before)
      order by created_at desc, id desc
      limit 50
    loop
      v_rows := v_rows + 1;
      v_oldest := r.created_at;
      if not (r.id = any(v_seen)) then
        v_seen := v_seen || r.id;
        v_new := v_new + 1;
      end if;
    end loop;
    exit when v_rows < 50;                 -- hasMore = false
    if v_new = 0 then
      raise exception 'FAIL: page % added no new rows (paging stuck)', v_pages;
    end if;
    v_before := v_oldest;
  end loop;

  select count(*), array_agg(id order by created_at desc, id desc)
    into v_total, v_expected
    from public.messages where room_id = v_room;

  if v_total < 131 then
    raise exception 'FAIL: member should see 130 seeded texts plus the join notice, saw %', v_total;
  end if;
  if cardinality(v_seen) <> v_total then
    raise exception 'FAIL: paging collected % distinct rows, expected % (rows skipped)', cardinality(v_seen), v_total;
  end if;
  if v_seen <> v_expected then
    raise exception 'FAIL: paged rows are not in newest-first order';
  end if;
  if v_pages < 3 then
    raise exception 'FAIL: expected at least 3 pages, got %', v_pages;
  end if;
  perform set_config('t.summary', v_total || ' rows over ' || v_pages || ' pages', true);
end $$;
reset role;

-- The trigger is active again: a client-supplied timestamp is still replaced.
select set_config('request.jwt.claims',
  json_build_object('sub', 'b0000000-0000-4000-8000-000000000002', 'role', 'authenticated', 'is_anonymous', true)::text, true);
set local role authenticated;
insert into public.messages (room_id, sender_id, body, created_at)
values (current_setting('t.r')::uuid, auth.uid(), 'after seed', '2099-01-01');
do $$ begin
  if not exists (select 1 from public.messages where body = 'after seed' and created_at = now()) then
    raise exception 'FAIL: created_at trigger not re-enabled after the seed';
  end if;
end $$;
reset role;

select 'CHAT PAGING TESTS PASSED' as result, current_setting('t.summary') as summary;
rollback;
