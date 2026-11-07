-- Cleanup queueing for face references (janitor checkpoint). Requires migration 20261104000012.
-- Single transaction, ends with ROLLBACK. Run as postgres (Supabase MCP execute_sql).
-- Success ends with the row 'CLEANUP ENQUEUE TESTS PASSED'.
begin;

insert into auth.users (instance_id, id, aud, role, email, is_anonymous, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'c0000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'cleanup-host@test.invalid', false, '{"display_name":"Host"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c0000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', null, true, '{}', now(), now());

select set_config('request.jwt.claims', json_build_object('sub', 'c0000000-0000-4000-8000-000000000001', 'role', 'authenticated', 'is_anonymous', false)::text, true);
set local role authenticated;
do $$
declare r public.rooms;
begin
  r := public.create_room('Cleanup', 'general', now() + interval '1 day', false, null);
  perform set_config('t.r', r.id::text, true);
  perform set_config('t.tok', r.invite_token, true);
end $$;
reset role;

select set_config('request.jwt.claims', json_build_object('sub', 'c0000000-0000-4000-8000-000000000002', 'role', 'authenticated', 'is_anonymous', true)::text, true);
set local role authenticated;
select public.join_room(null, current_setting('t.tok'));
select public.enroll_face(current_setting('t.r')::uuid, current_setting('t.r') || '/c0000000-0000-4000-8000-000000000002/ref-old.jpg');
-- Re-enroll with a new reference.
select public.enroll_face(current_setting('t.r')::uuid, current_setting('t.r') || '/c0000000-0000-4000-8000-000000000002/ref-new.jpg');
reset role;

do $$
declare r text := current_setting('t.r'); u text := 'c0000000-0000-4000-8000-000000000002';
begin
  if not exists (select 1 from public.cleanup_jobs where bucket = 'face-refs' and prefix = r || '/' || u || '/ref-old.jpg') then
    raise exception 'FAIL: re-enroll did not queue the exact old ref path';
  end if;
  if exists (select 1 from public.cleanup_jobs where bucket = 'face-refs' and prefix = r || '/' || u || '/') then
    raise exception 'FAIL: re-enroll queued the whole user prefix (would delete the new reference)';
  end if;
  if (select ref_path from public.face_enrollments where room_id = r::uuid and user_id = u::uuid) <> r || '/' || u || '/ref-new.jpg' then
    raise exception 'FAIL: enrollment does not point at the new reference';
  end if;
  if current_setting('app.face_reenroll', true) = 'on' then
    raise exception 'FAIL: re-enroll flag leaked past enroll_face';
  end if;
end $$;

-- Explicit removal queues the prefix, and a repeat refreshes created_at.
select set_config('request.jwt.claims', json_build_object('sub', 'c0000000-0000-4000-8000-000000000002', 'role', 'authenticated', 'is_anonymous', true)::text, true);
set local role authenticated;
select public.remove_face_enrollment(current_setting('t.r')::uuid);
reset role;
do $$
declare r text := current_setting('t.r'); u text := 'c0000000-0000-4000-8000-000000000002'; t1 timestamptz; t2 timestamptz;
begin
  select created_at into t1 from public.cleanup_jobs where bucket = 'face-refs' and prefix = r || '/' || u || '/';
  if t1 is null then raise exception 'FAIL: remove_face_enrollment did not queue the prefix'; end if;
  update public.cleanup_jobs set created_at = t1 - interval '1 hour', verified_empty_at = now() where bucket = 'face-refs' and prefix = r || '/' || u || '/';
  perform private.enqueue_cleanup('face-refs', r || '/' || u || '/', 'again');
  select created_at into t2 from public.cleanup_jobs where bucket = 'face-refs' and prefix = r || '/' || u || '/';
  if t2 < t1 - interval '1 minute' or (select verified_empty_at from public.cleanup_jobs where bucket = 'face-refs' and prefix = r || '/' || u || '/') is not null then
    raise exception 'FAIL: re-queue did not refresh created_at / reset verified_empty_at';
  end if;
end $$;

-- Room delete queues both bucket prefixes.
delete from public.rooms where id = current_setting('t.r')::uuid;
do $$
begin
  if (select count(*) from public.cleanup_jobs where prefix = current_setting('t.r') || '/' and bucket in ('room-media', 'face-refs')) <> 2 then
    raise exception 'FAIL: room delete did not queue both prefixes';
  end if;
end $$;

select 'CLEANUP ENQUEUE TESTS PASSED' as result;
rollback;
