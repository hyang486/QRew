-- J2: janitor run failure detection. Requires migration 20261104000014. Single transaction, ends with ROLLBACK.
-- Success ends with the row 'JANITOR HEALTH TESTS PASSED'.
begin;
-- Synthetic runs with ids far above real pg_net ids.
insert into private.janitor_runs (request_id, requested_at) values
  (900000001, now() - interval '1 minute'),   -- ok
  (900000002, now() - interval '2 minutes'),  -- HTTP 500
  (900000003, now() - interval '3 minutes'),  -- transport error
  (900000004, now() - interval '10 minutes'), -- no response after 5 minutes
  (900000005, now()),                         -- still pending
  (900000006, now() - interval '7 hours'),    -- response expired from pg_net, never captured
  (900000007, now() - interval '8 hours');    -- response captured below, then expired from pg_net
insert into net._http_response (id, status_code, content, error_msg, created) values
  (900000001, 200, '{}', null, now()),
  (900000002, 500, '{"error":"janitor_failed"}', null, now()),
  (900000003, null, null, 'Timeout of 30000 ms reached', now()),
  (900000007, 200, '{}', null, now() - interval '8 hours');
-- J2a: capture copies responses into janitor_runs; then pg_net's TTL removes the response row.
do $$ begin
  if private.janitor_capture_responses() < 4 then raise exception 'FAIL: capture count'; end if;
end $$;
delete from net._http_response where id = 900000007;
insert into public.cleanup_jobs (bucket, prefix, reason, attempts) values ('room-media', 'janitor-health-test/', 'test', 5);
do $$
declare s text;
begin
  select string_agg(request_id::text || '=' || state, ',' order by request_id) into s
  from private.janitor_health() where request_id >= 900000001;
  if s <> '900000001=ok,900000002=failed,900000003=failed,900000004=missing_response,900000005=pending,900000006=unknown_expired,900000007=ok' then
    raise exception 'FAIL: states %', s;
  end if;
  if (select min(stuck_jobs) from private.janitor_health()) < 1 then
    raise exception 'FAIL: stuck job not counted';
  end if;
end $$;
set local role authenticated;
do $$ begin
  perform private.janitor_health();
  raise exception 'FAIL: authenticated can read janitor_health';
exception when insufficient_privilege then null; end $$;
reset role;
select 'JANITOR HEALTH TESTS PASSED' as result;
rollback;
