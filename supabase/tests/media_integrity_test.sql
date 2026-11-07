-- Media integrity and original-download access. Requires migration 20261104000015 (media_integrity).
-- Single transaction ending in ROLLBACK. Run as the database owner (Supabase MCP execute_sql).
-- Any failed expectation raises `FAIL: <label>`. Success ends with the row 'MEDIA INTEGRITY TESTS PASSED'.
--
-- Actors: U uploader (member), M member, L member who leaves, O outsider.
-- Rooms:  R open; E expired; D ended by the host (deleted_at set).

begin;

create schema mtests;
grant usage on schema mtests to authenticated;

create function mtests.login(p_uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated', 'is_anonymous', true)::text, true);
$$;

create function mtests.expect_error_like(p_sql text, p_pattern text, p_label text) returns void language plpgsql as $$
declare v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    v_msg := sqlerrm;
  end;
  if v_msg is null then
    raise exception 'FAIL: % (statement succeeded but should have failed)', p_label;
  elsif v_msg not like p_pattern then
    raise exception 'FAIL: % (wrong error: %)', p_label, v_msg;
  end if;
end;
$$;

create function mtests.expect_ok(p_sql text, p_label text) returns void language plpgsql as $$
begin
  execute p_sql;
exception when others then
  raise exception 'FAIL: % (% %)', p_label, sqlstate, sqlerrm;
end;
$$;

create function mtests.expect_count(p_sql text, p_n bigint, p_label text) returns void language plpgsql as $$
declare v bigint;
begin
  execute 'select count(*) from (' || p_sql || ') s' into v;
  if v is distinct from p_n then
    raise exception 'FAIL: % (expected %, got %)', p_label, p_n, v;
  end if;
end;
$$;
grant execute on all functions in schema mtests to authenticated;

insert into auth.users (instance_id, id, aud, role, is_anonymous, raw_user_meta_data, created_at, updated_at) values
  ('00000000-0000-0000-0000-000000000000', 'd0000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd0000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd0000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', true, '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd0000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', true, '{}', now(), now());

-- R open (host M), E expired, D ended. U, M, L are members of all three.
insert into public.rooms (id, host_id, name, created_at, expires_at, code, deleted_at) values
  ('d1000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', 'media R', now() - interval '1 hour', now() + interval '1 day', '90001', null),
  ('d1000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002', 'media E', now() - interval '2 days', now() + interval '1 day', '90002', null),
  ('d1000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000002', 'media D', now() - interval '1 hour', now() + interval '1 day', '90003', null);
insert into public.room_members (room_id, user_id, role)
select r, u, case when u = 'd0000000-0000-4000-8000-000000000002'::uuid then 'host' else 'member' end
from unnest(array['d1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000003']::uuid[]) r,
     unnest(array['d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000003']::uuid[]) u;

-- U creates a media row in each room while they are open.
select mtests.login('d0000000-0000-4000-8000-000000000001');
set local role authenticated;

select mtests.expect_error_like($q$ insert into public.media (id, room_id, uploader_id, kind, original_path, file_name, mime_type)
  values ('d2000000-0000-4000-8000-0000000000ff', 'd1000000-0000-4000-8000-000000000001', auth.uid(), 'photo',
          'd1000000-0000-4000-8000-000000000001/elsewhere/original.jpg', 'a.jpg', 'image/jpeg') $q$,
  'Media paths must be under%', 'path outside {room}/{media}/ is rejected');

select mtests.expect_ok($q$ insert into public.media (id, room_id, uploader_id, kind, original_path, preview_path, file_name, mime_type, content_sha256)
  select ('d2000000-0000-4000-8000-00000000000' || n)::uuid, r::uuid, auth.uid(), 'photo',
         r || '/d2000000-0000-4000-8000-00000000000' || n || '/original.jpg',
         r || '/d2000000-0000-4000-8000-00000000000' || n || '/preview.jpg', 'a.jpg', 'image/jpeg', repeat('ab', 32)
  from (values (1, 'd1000000-0000-4000-8000-000000000001'), (2, 'd1000000-0000-4000-8000-000000000002'),
               (3, 'd1000000-0000-4000-8000-000000000003')) v(n, r) $q$,
  'uploader creates uploading rows');

select mtests.expect_error_like($q$ update public.media set status = 'ready'
  where id = 'd2000000-0000-4000-8000-000000000001' $q$,
  'The original file is missing or empty', 'ready without a stored original is rejected');

-- Storage writes as the uploader. The API sets metadata after the upload; simulate that as owner below.
select mtests.expect_ok($q$ insert into storage.objects (bucket_id, name, owner_id)
  select 'room-media', m.original_path, auth.uid()::text from public.media m where m.uploader_id = auth.uid()
  union all
  select 'room-media', m.preview_path, auth.uid()::text from public.media m where m.uploader_id = auth.uid() $q$,
  'uploader writes original and preview objects');
reset role;
update storage.objects set metadata = jsonb_build_object('size', 0)
where bucket_id = 'room-media' and name like '%/d2000000-0000-4000-8000-00000000000_/%';

select mtests.login('d0000000-0000-4000-8000-000000000001');
set local role authenticated;
select mtests.expect_error_like($q$ update public.media set status = 'ready'
  where id = 'd2000000-0000-4000-8000-000000000001' $q$,
  'The original file is missing or empty', 'ready with an empty original is rejected');
reset role;
update storage.objects set metadata = jsonb_build_object('size', 1234567)
where bucket_id = 'room-media' and name like '%/d2000000-0000-4000-8000-00000000000_/original.jpg';

select mtests.login('d0000000-0000-4000-8000-000000000001');
set local role authenticated;
select mtests.expect_error_like($q$ update public.media set status = 'ready'
  where id = 'd2000000-0000-4000-8000-000000000001' $q$,
  'The preview file is missing or empty', 'ready with an empty preview is rejected');
reset role;
update storage.objects set metadata = jsonb_build_object('size', 2048)
where bucket_id = 'room-media' and name like '%/d2000000-0000-4000-8000-00000000000_/preview.jpg';

select mtests.login('d0000000-0000-4000-8000-000000000001');
set local role authenticated;
select mtests.expect_ok($q$ update public.media set status = 'ready', size_bytes = 1
  where id in ('d2000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000002',
               'd2000000-0000-4000-8000-000000000003') $q$,
  'ready with stored nonzero original and preview');
select mtests.expect_count($q$ select 1 from public.media where id = 'd2000000-0000-4000-8000-000000000001' and size_bytes = 1234567 $q$,
  1, 'size_bytes comes from storage, not the client');
select mtests.expect_error_like($q$ update public.media set original_path = original_path || 'x'
  where id = 'd2000000-0000-4000-8000-000000000001' $q$, 'A ready media item cannot be changed', 'ready original path is frozen');
select mtests.expect_error_like($q$ update public.media set status = 'uploading'
  where id = 'd2000000-0000-4000-8000-000000000001' $q$, 'A ready media item cannot be changed', 'ready status is frozen');
select mtests.expect_error_like($q$ update public.media set content_sha256 = repeat('cd', 32)
  where id = 'd2000000-0000-4000-8000-000000000001' $q$, 'A ready media item cannot be changed', 'ready hash is frozen');
-- Overwriting the stored original after ready (upsert) is denied by storage RLS.
select mtests.expect_count($q$ select 1 where private.can_write_room_media(
  'd1000000-0000-4000-8000-000000000001/d2000000-0000-4000-8000-000000000001/original.jpg') $q$, 0,
  'ready original cannot be rewritten');
do $$ begin
  update storage.objects set metadata = '{"size":1}'
  where bucket_id = 'room-media' and name = 'd1000000-0000-4000-8000-000000000001/d2000000-0000-4000-8000-000000000001/original.jpg';
  if found then raise exception 'FAIL: uploader updated a ready original object'; end if;
end $$;
reset role;

-- Read access to the original object (what the authenticated download endpoint checks).
-- M in the open room: allowed.
select mtests.login('d0000000-0000-4000-8000-000000000002');
set local role authenticated;
select mtests.expect_count($q$ select 1 from storage.objects where bucket_id = 'room-media'
  and name = 'd1000000-0000-4000-8000-000000000001/d2000000-0000-4000-8000-000000000001/original.jpg' $q$, 1,
  'member can read the original');
select mtests.expect_count($q$ select 1 from public.media where id = 'd2000000-0000-4000-8000-000000000001' $q$, 1, 'member sees the media row');
reset role;

-- O never joined: denied.
select mtests.login('d0000000-0000-4000-8000-000000000004');
set local role authenticated;
select mtests.expect_count($q$ select 1 from storage.objects where bucket_id = 'room-media' $q$, 0, 'outsider cannot read originals');
select mtests.expect_count($q$ select 1 from public.media $q$, 0, 'outsider sees no media rows');
reset role;

-- L reads, then leaves R: denied afterwards.
select mtests.login('d0000000-0000-4000-8000-000000000003');
set local role authenticated;
select mtests.expect_count($q$ select 1 from storage.objects where bucket_id = 'room-media'
  and name like 'd1000000-0000-4000-8000-000000000001/%' $q$, 2, 'member L reads R before leaving');
select public.leave_room('d1000000-0000-4000-8000-000000000001');
select mtests.expect_count($q$ select 1 from storage.objects where bucket_id = 'room-media'
  and name like 'd1000000-0000-4000-8000-000000000001/%' $q$, 0, 'member who left cannot read originals');
select mtests.expect_count($q$ select 1 from public.media where room_id = 'd1000000-0000-4000-8000-000000000001' $q$, 0,
  'member who left sees no media rows');
reset role;

-- E expires, D is ended by the host: every member is denied.
update public.rooms set expires_at = now() - interval '1 minute' where id = 'd1000000-0000-4000-8000-000000000002';
select mtests.login('d0000000-0000-4000-8000-000000000002');
set local role authenticated;
select public.end_room('d1000000-0000-4000-8000-000000000003');
reset role;
select mtests.login('d0000000-0000-4000-8000-000000000001');
set local role authenticated;
select mtests.expect_count($q$ select 1 from storage.objects where bucket_id = 'room-media'
  and (name like 'd1000000-0000-4000-8000-000000000002/%' or name like 'd1000000-0000-4000-8000-000000000003/%') $q$, 0,
  'uploader cannot read originals after expiry or end');
select mtests.expect_error_like($q$ insert into public.media (id, room_id, uploader_id, kind, original_path, file_name, mime_type)
  values ('d2000000-0000-4000-8000-0000000000ee', 'd1000000-0000-4000-8000-000000000002', auth.uid(), 'photo',
          'd1000000-0000-4000-8000-000000000002/d2000000-0000-4000-8000-0000000000ee/original.jpg', 'a.jpg', 'image/jpeg') $q$,
  '%row-level security%', 'no new media in an expired room');
reset role;

select 'MEDIA INTEGRITY TESTS PASSED' as result;
rollback;
