-- FM-Q A′-2 detect-copy storage policy. Requires migration 20261104000022 (face_detect_copies).
-- Single transaction ending in ROLLBACK. Run as the database owner (Supabase MCP execute_sql).
-- Any failed expectation raises `FAIL: <label>`. Success ends with the row 'FACE DETECT TESTS PASSED'.
-- Dry run before the migration is applied: prepend the migration body after `begin;` (still ROLLBACK).
--
-- Actors: A enrolled member, B other member (also enrolled), U uploader of the photo, O outsider.
-- Rooms:  R open; X a second open room (A is a member) for the cross-room checks.

begin;

create schema fdtests;
grant usage on schema fdtests to authenticated, anon;

create function fdtests.login(p_uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated', 'is_anonymous', true)::text, true);
$$;

create function fdtests.expect_denied(p_sql text, p_label text) returns void language plpgsql as $$
declare v_ok boolean := true;
begin
  begin
    execute p_sql;
  exception when others then
    v_ok := false;
  end;
  if v_ok then raise exception 'FAIL: % (statement succeeded but should have been denied)', p_label; end if;
end;
$$;

create function fdtests.expect_ok(p_sql text, p_label text) returns void language plpgsql as $$
begin
  execute p_sql;
exception when others then
  raise exception 'FAIL: % (% %)', p_label, sqlstate, sqlerrm;
end;
$$;

create function fdtests.expect_count(p_sql text, p_n bigint, p_label text) returns void language plpgsql as $$
declare v bigint;
begin
  execute 'select count(*) from (' || p_sql || ') s' into v;
  if v is distinct from p_n then
    raise exception 'FAIL: % (expected %, got %)', p_label, p_n, v;
  end if;
end;
$$;
grant execute on all functions in schema fdtests to authenticated, anon;

-- Ids. A=…01 B=…02 U=…03 O=…04; R=e1…01 X=e1…02; photo P=e2…01 in R, photo Q=e2…02 in X,
-- video V=e2…03 in R, not-ready photo N=e2…04 in R, photo Z=e2…05 in R without a job for A.
insert into auth.users (instance_id, id, aud, role, is_anonymous, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated', true, '{}', now(), now()
from unnest(array['e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002',
                  'e0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000004']::uuid[]) u;

insert into public.rooms (id, host_id, name, created_at, expires_at, code) values
  ('e1000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000003', 'detect R', now(), now() + interval '1 day', '90011'),
  ('e1000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000003', 'detect X', now(), now() + interval '1 day', '90012');
insert into public.room_members (room_id, user_id, role) values
  ('e1000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000003', 'host'),
  ('e1000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'member'),
  ('e1000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002', 'member'),
  ('e1000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000003', 'host'),
  ('e1000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001', 'member');

-- Media rows as owner (the upload path is covered by media_integrity_test). Integrity trigger off for setup only.
alter table public.media disable trigger media_integrity;
insert into public.media (id, room_id, uploader_id, kind, original_path, preview_path, file_name, mime_type, status)
select m, r, 'e0000000-0000-4000-8000-000000000003', k, r || '/' || m || '/original.jpg', r || '/' || m || '/preview.jpg', 'a.jpg', 'image/jpeg', s
from (values
  ('e2000000-0000-4000-8000-000000000001'::uuid, 'e1000000-0000-4000-8000-000000000001'::uuid, 'photo', 'ready'),
  ('e2000000-0000-4000-8000-000000000002'::uuid, 'e1000000-0000-4000-8000-000000000002'::uuid, 'photo', 'ready'),
  ('e2000000-0000-4000-8000-000000000003'::uuid, 'e1000000-0000-4000-8000-000000000001'::uuid, 'video', 'ready'),
  ('e2000000-0000-4000-8000-000000000004'::uuid, 'e1000000-0000-4000-8000-000000000001'::uuid, 'photo', 'uploading'),
  ('e2000000-0000-4000-8000-000000000005'::uuid, 'e1000000-0000-4000-8000-000000000001'::uuid, 'photo', 'ready')) v(m, r, k, s);
alter table public.media enable trigger media_integrity;
insert into storage.objects (bucket_id, name, owner_id)
select 'room-media', m.preview_path, m.uploader_id::text from public.media m where m.uploader_id = 'e0000000-0000-4000-8000-000000000003';

-- Enrollments: A in R (ea…01) and in X (ea…02); B in R (ea…03). Jobs: A×P, A×V, A×N, B×P, A(X)×Q. No job A×Z.
insert into public.face_enrollments (id, room_id, user_id, ref_path) values
  ('ea000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'x'),
  ('ea000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001', 'y'),
  ('ea000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002', 'z');
insert into public.face_jobs (enrollment_id, media_id, status) values
  ('ea000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'queued'),
  ('ea000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000003', 'queued'),
  ('ea000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000004', 'queued'),
  ('ea000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000001', 'queued'),
  ('ea000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000002', 'queued');

create function fdtests.put(p_name text) returns text language sql as $$
  select format('insert into storage.objects (bucket_id, name, owner_id) values (%L, %L, auth.uid()::text)', 'room-media', p_name)
$$;
grant execute on function fdtests.put(text) to authenticated;

-- A: the one allowed write.
select fdtests.login('e0000000-0000-4000-8000-000000000001');
set local role authenticated;
select fdtests.expect_ok(fdtests.put('e1000000-0000-4000-8000-000000000001/e2000000-0000-4000-8000-000000000001/detect/ea000000-0000-4000-8000-000000000001.jpg'),
  'A writes own detect copy for a queued job on a ready photo in the same room');
-- A retry of the same path is a duplicate (insert only; the app treats the existing copy as prepared).
select fdtests.expect_denied(fdtests.put('e1000000-0000-4000-8000-000000000001/e2000000-0000-4000-8000-000000000001/detect/ea000000-0000-4000-8000-000000000001.jpg'),
  'second insert of the same path fails (no overwrite)');
select fdtests.expect_denied(fdtests.put('e1000000-0000-4000-8000-000000000001/e2000000-0000-4000-8000-000000000001/detect/ea000000-0000-4000-8000-000000000003.jpg'),
  'A cannot write under B''s enrollment');
select fdtests.expect_denied(fdtests.put('e1000000-0000-4000-8000-000000000002/e2000000-0000-4000-8000-000000000001/detect/ea000000-0000-4000-8000-000000000002.jpg'),
  'cross-room: R photo under the X room prefix');
select fdtests.expect_denied(fdtests.put('e1000000-0000-4000-8000-000000000001/e2000000-0000-4000-8000-000000000002/detect/ea000000-0000-4000-8000-000000000001.jpg'),
  'cross-room: X photo under the R prefix with the R enrollment');
select fdtests.expect_denied(fdtests.put('e1000000-0000-4000-8000-000000000001/e2000000-0000-4000-8000-000000000003/detect/ea000000-0000-4000-8000-000000000001.jpg'),
  'not a photo (video)');
select fdtests.expect_denied(fdtests.put('e1000000-0000-4000-8000-000000000001/e2000000-0000-4000-8000-000000000004/detect/ea000000-0000-4000-8000-000000000001.jpg'),
  'photo not ready');
select fdtests.expect_denied(fdtests.put('e1000000-0000-4000-8000-000000000001/e2000000-0000-4000-8000-000000000005/detect/ea000000-0000-4000-8000-000000000001.jpg'),
  'no open job for this photo');
select fdtests.expect_denied(fdtests.put('e1000000-0000-4000-8000-000000000001/e2000000-0000-4000-8000-000000000001/detect/ea000000-0000-4000-8000-000000000001.png'),
  'wrong extension');
select fdtests.expect_denied(fdtests.put('e1000000-0000-4000-8000-000000000001/e2000000-0000-4000-8000-000000000001/detect/x/ea000000-0000-4000-8000-000000000001.jpg'),
  'extra folder');
select fdtests.expect_denied(fdtests.put('e1000000-0000-4000-8000-000000000001/e2000000-0000-4000-8000-000000000001/original.jpg'),
  'A (not the uploader) cannot write the original');
-- A cannot read or list the copy (or anyone's), but still reads the preview.
select fdtests.expect_count($q$ select 1 from storage.objects where bucket_id = 'room-media' and name like '%/detect/%' $q$, 0,
  'A cannot see detect copies (select/list)');
select fdtests.expect_count($q$ select 1 from storage.objects where bucket_id = 'room-media'
  and name = 'e1000000-0000-4000-8000-000000000001/e2000000-0000-4000-8000-000000000001/preview.jpg' $q$, 1,
  'A still reads the preview');
-- storage.protect_delete() rejects every direct SQL delete unless storage.allow_delete_query is 'true'.
-- Lift it for this block only (transaction-local) so RLS, not the trigger, decides A's delete.
do $$ begin
  update storage.objects set metadata = '{"size":1}' where bucket_id = 'room-media' and name like '%/detect/%';
  if found then raise exception 'FAIL: A updated a detect copy'; end if;
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects where bucket_id = 'room-media' and name like '%/detect/%';
  if found then raise exception 'FAIL: A deleted a detect copy'; end if;
  perform set_config('storage.allow_delete_query', 'false', true);
end $$;
reset role;

-- The job finishing closes the path: no new copy for a done job.
update public.face_jobs set status = 'done' where enrollment_id = 'ea000000-0000-4000-8000-000000000003';

-- B: own job is done now, so B cannot write; B cannot see A's copy.
select fdtests.login('e0000000-0000-4000-8000-000000000002');
set local role authenticated;
select fdtests.expect_denied(fdtests.put('e1000000-0000-4000-8000-000000000001/e2000000-0000-4000-8000-000000000001/detect/ea000000-0000-4000-8000-000000000003.jpg'),
  'B cannot write once the job is done');
select fdtests.expect_count($q$ select 1 from storage.objects where bucket_id = 'room-media' and name like '%/detect/%' $q$, 0,
  'B cannot see A''s detect copy');
reset role;

-- U (uploader, host): cannot see detect copies and cannot write detect/ through the uploader policy.
select fdtests.login('e0000000-0000-4000-8000-000000000003');
set local role authenticated;
select fdtests.expect_count($q$ select 1 from storage.objects where bucket_id = 'room-media' and name like '%/detect/%' $q$, 0,
  'uploader/host cannot see detect copies');
select fdtests.expect_denied(fdtests.put('e1000000-0000-4000-8000-000000000001/e2000000-0000-4000-8000-000000000004/detect/ea000000-0000-4000-8000-000000000001.jpg'),
  'uploader cannot write detect/ under a not-ready own photo');
select fdtests.expect_count($q$ select 1 from storage.objects where bucket_id = 'room-media'
  and name like 'e1000000-0000-4000-8000-000000000001/%/preview.jpg' $q$, 4, 'uploader still reads previews in R');
reset role;

-- O (outsider) sees nothing and writes nothing.
select fdtests.login('e0000000-0000-4000-8000-000000000004');
set local role authenticated;
select fdtests.expect_count($q$ select 1 from storage.objects where bucket_id = 'room-media' and name like 'e1000000-%' $q$, 0, 'outsider sees nothing');
select fdtests.expect_denied(fdtests.put('e1000000-0000-4000-8000-000000000001/e2000000-0000-4000-8000-000000000001/detect/ea000000-0000-4000-8000-000000000001.jpg'),
  'outsider cannot write detect copies');
reset role;

-- A after leaving the room: no write.
delete from public.face_jobs where enrollment_id = 'ea000000-0000-4000-8000-000000000001' and media_id = 'e2000000-0000-4000-8000-000000000001';
insert into public.face_jobs (enrollment_id, media_id, status) values
  ('ea000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000005', 'queued');
update public.rooms set created_at = now() - interval '2 hours', expires_at = now() - interval '1 second'
  where id = 'e1000000-0000-4000-8000-000000000001';
select fdtests.login('e0000000-0000-4000-8000-000000000001');
set local role authenticated;
select fdtests.expect_denied(fdtests.put('e1000000-0000-4000-8000-000000000001/e2000000-0000-4000-8000-000000000005/detect/ea000000-0000-4000-8000-000000000001.jpg'),
  'expired room: no detect write even with an open job');
reset role;

-- Janitor listing: service_role only; returns the copy with its time.
select fdtests.expect_count($q$ select 1 from public.janitor_detect_objects(1000)
  where name = 'e1000000-0000-4000-8000-000000000001/e2000000-0000-4000-8000-000000000001/detect/ea000000-0000-4000-8000-000000000001.jpg' $q$, 1,
  'janitor_detect_objects lists the copy');
set local role authenticated;
select fdtests.expect_denied($q$ select * from public.janitor_detect_objects(10) $q$, 'authenticated cannot call janitor_detect_objects');
reset role;
set local role anon;
select fdtests.expect_denied($q$ select * from public.janitor_detect_objects(10) $q$, 'anon cannot call janitor_detect_objects');
reset role;

select 'FACE DETECT TESTS PASSED';
rollback;
