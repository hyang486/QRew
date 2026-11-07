-- J2: make janitor run failures detectable.
-- invoke_janitor records each pg_net request id in private.janitor_runs. Because pg_net deletes
-- net._http_response rows after ~6 hours (J2a), each invoke first copies any response it can see into
-- janitor_runs (private.janitor_capture_responses), so older results survive.
-- A run has failed when its response has a status other than 200 or a transport error; it is
-- 'missing_response' with no response after 5 minutes, and 'unknown_expired' if it is older than the
-- pg_net TTL and its response was never captured.
-- J1 (stuck jobs) is handled in the function: claim order is attempts, then created_at; jobs with attempts >= 5 are counted as stuck.

create table if not exists private.janitor_runs (
  request_id bigint primary key,
  requested_at timestamptz not null default now(),
  responded_at timestamptz,
  status_code integer,
  error_msg text
);
alter table private.janitor_runs enable row level security;
revoke all on private.janitor_runs from public, anon, authenticated;

create or replace function private.janitor_capture_responses()
returns integer language sql security definer
set search_path = ''
as $$
  with u as (
    update private.janitor_runs r
       set responded_at = coalesce(h.created, now()), status_code = h.status_code, error_msg = h.error_msg
      from net._http_response h
     where h.id = r.request_id and r.responded_at is null
    returning 1
  ) select count(*)::integer from u
$$;
revoke execute on function private.janitor_capture_responses() from public, anon, authenticated;

create or replace function private.invoke_janitor()
returns bigint language plpgsql security definer
set search_path = ''
as $$
declare
  v_secret text;
  v_id bigint;
begin
  perform private.janitor_capture_responses();
  select secret into v_secret from private.janitor_config where id = 1;
  v_id := net.http_post(
    url := 'https://wuhkyjksiiqzoxvonfuy.supabase.co/functions/v1/room-janitor',
    headers := jsonb_build_object('content-type', 'application/json', 'x-janitor-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  insert into private.janitor_runs (request_id) values (v_id);
  delete from private.janitor_runs where requested_at < now() - interval '14 days';
  return v_id;
end;
$$;
revoke execute on function private.invoke_janitor() from public, anon, authenticated;

-- One row per recent run with a derived state: ok | failed | pending | missing_response | unknown_expired.
create or replace function private.janitor_health()
returns table (request_id bigint, requested_at timestamptz, state text, status_code int, error_msg text, stuck_jobs bigint)
language sql stable security definer
set search_path = ''
as $$
  select r.request_id, r.requested_at,
    case
      when r.responded_at is null and h.id is null and r.requested_at < now() - interval '6 hours' then 'unknown_expired'
      when r.responded_at is null and h.id is null and r.requested_at < now() - interval '5 minutes' then 'missing_response'
      when r.responded_at is null and h.id is null then 'pending'
      when coalesce(r.status_code, h.status_code) = 200 and coalesce(r.error_msg, h.error_msg) is null then 'ok'
      else 'failed'
    end,
    coalesce(r.status_code, h.status_code), coalesce(r.error_msg, h.error_msg),
    (select count(*) from public.cleanup_jobs j where j.verified_empty_at is null and j.attempts >= 5)
  from private.janitor_runs r
  left join net._http_response h on h.id = r.request_id and r.responded_at is null
  order by r.requested_at desc
  limit 20
$$;
revoke execute on function private.janitor_health() from public, anon, authenticated;
