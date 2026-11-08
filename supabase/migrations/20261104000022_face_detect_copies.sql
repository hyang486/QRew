-- FM-Q A′-2 (human decision 2026-11-07): temporary face-detection copies.
-- NOT APPLIED. Apply only after the human's OK (see docs/implementation-status.md).
--
-- Path: room-media/{room_id}/{media_id}/detect/{enrollment_id}.jpg
--   write:  only the enrolled member, for their own enrollment in that room, for a ready photo of the same
--           room that has an open (queued/running) face job for that enrollment, while a room member.
--           Insert only: no client update, upsert or delete. A copy left by an interrupted run is reused as
--           is (same member, same immutable ready photo) and is deleted by face-match or the janitor TTL.
--   read:   nobody but the service role. room_media_select no longer covers detect/, so members cannot
--           read, download or list these objects.
--   delete: face-match removes the copy in `finally` through the Storage API; room-janitor removes copies
--           older than 15 minutes (it lists them through public.janitor_detect_objects and deletes through the
--           Storage API) and the room purge removes the whole {room_id}/ prefix.
-- Original/preview reads and writes are unchanged, except that they can no longer target detect/.

-- True when the object is in a detect folder (third path segment).
create or replace function private.is_detect_path(p_name text)
returns boolean language sql stable
set search_path = ''
as $$
  select coalesce((storage.foldername(p_name))[3] = 'detect', false)
$$;

create or replace function private.can_write_face_detect(p_name text)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/detect/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'
    and exists (
      select 1
      from public.face_enrollments e
      join public.media m on m.room_id = e.room_id
      join public.face_jobs j on j.enrollment_id = e.id and j.media_id = m.id
      where e.id = private.try_uuid(left(split_part(p_name, '/', 4), 36))
        and e.room_id = private.try_uuid(split_part(p_name, '/', 1))
        and m.id = private.try_uuid(split_part(p_name, '/', 2))
        and e.user_id = (select auth.uid())
        and m.kind = 'photo'
        and m.status = 'ready'
        and j.status in ('queued', 'running')
    )
    and private.is_room_member(private.try_uuid(split_part(p_name, '/', 1)))
$$;

revoke all on function private.is_detect_path(text) from public, anon, authenticated;
revoke all on function private.can_write_face_detect(text) from public, anon, authenticated;
grant execute on function private.is_detect_path(text) to authenticated;
grant execute on function private.can_write_face_detect(text) to authenticated;

-- Members read originals and previews, never detect copies.
drop policy room_media_select on storage.objects;
create policy room_media_select on storage.objects for select to authenticated
  using (bucket_id = 'room-media'
         and not private.is_detect_path(name)
         and private.is_room_member(private.try_uuid((storage.foldername(name))[1])));

-- Uploader writes (original/preview) cannot target detect/.
drop policy room_media_insert on storage.objects;
create policy room_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'room-media'
              and not private.is_detect_path(name)
              and private.can_write_room_media(name));

drop policy room_media_update on storage.objects;
create policy room_media_update on storage.objects for update to authenticated
  using (bucket_id = 'room-media' and owner_id = (select auth.uid())::text
         and not private.is_detect_path(name)
         and private.can_write_room_media(name))
  with check (bucket_id = 'room-media'
              and not private.is_detect_path(name)
              and private.can_write_room_media(name));

create policy room_media_detect_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'room-media' and private.can_write_face_detect(name));

-- Janitor listing (service_role only). Deletion stays with the Storage API, never a row delete here.
create or replace function public.janitor_detect_objects(p_limit integer default 1000)
returns table (name text, created_at timestamptz)
language sql stable security definer
set search_path = ''
as $$
  select o.name, o.created_at
  from storage.objects o
  where o.bucket_id = 'room-media'
    and o.name ~ '^[^/]+/[^/]+/detect/[^/]+$'
  order by o.created_at
  limit least(greatest(coalesce(p_limit, 1000), 1), 1000)
$$;
revoke execute on function public.janitor_detect_objects(integer) from public, anon, authenticated;
grant execute on function public.janitor_detect_objects(integer) to service_role;
