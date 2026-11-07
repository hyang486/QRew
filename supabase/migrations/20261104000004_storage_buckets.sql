-- Private storage buckets and storage RLS.
--
-- room-media: {room_id}/{media_id}/original.<ext> and {room_id}/{media_id}/preview.jpg
--   read:   any active member of the room (room open, not left).
--   write:  only the uploader of the matching public.media row, while a member.
-- face-refs: {room_id}/{user_id}/<file>
--   read/write: only that user, while a member of that room. The host cannot read it.
-- Clients never delete objects. The room-janitor Edge Function (service role) removes
-- prefixes queued in public.cleanup_jobs on leave, enrollment removal, expiry and deletion.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('room-media', 'room-media', false, null, null),
  ('face-refs', 'face-refs', false, 10485760, array['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Cast a path segment to uuid without raising on malformed input.
create or replace function private.try_uuid(p text)
returns uuid language plpgsql immutable
set search_path = ''
as $$
begin
  return p::uuid;
exception when others then
  return null;
end;
$$;

-- True when the object name is {room_id}/{media_id}/... and the caller uploaded that media row
-- in that room and is still an active member.
create or replace function private.can_write_room_media(p_name text)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.media m
    where m.id = private.try_uuid((storage.foldername(p_name))[2])
      and m.room_id = private.try_uuid((storage.foldername(p_name))[1])
      and m.uploader_id = auth.uid()
  ) and private.is_room_member(private.try_uuid((storage.foldername(p_name))[1]))
$$;

revoke all on function private.try_uuid(text) from public, anon, authenticated;
revoke all on function private.can_write_room_media(text) from public, anon, authenticated;
grant execute on function private.try_uuid(text) to authenticated;
grant execute on function private.can_write_room_media(text) to authenticated;

create policy room_media_select on storage.objects for select to authenticated
  using (bucket_id = 'room-media'
         and private.is_room_member(private.try_uuid((storage.foldername(name))[1])));

create policy room_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'room-media' and private.can_write_room_media(name));

create policy room_media_update on storage.objects for update to authenticated
  using (bucket_id = 'room-media' and owner_id = (select auth.uid())::text
         and private.can_write_room_media(name))
  with check (bucket_id = 'room-media' and private.can_write_room_media(name));

create policy face_refs_select on storage.objects for select to authenticated
  using (bucket_id = 'face-refs'
         and (storage.foldername(name))[2] = (select auth.uid())::text
         and private.is_room_member(private.try_uuid((storage.foldername(name))[1])));

create policy face_refs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'face-refs'
              and (storage.foldername(name))[2] = (select auth.uid())::text
              and private.is_room_member(private.try_uuid((storage.foldername(name))[1])));

create policy face_refs_update on storage.objects for update to authenticated
  using (bucket_id = 'face-refs' and owner_id = (select auth.uid())::text
         and (storage.foldername(name))[2] = (select auth.uid())::text
         and private.is_room_member(private.try_uuid((storage.foldername(name))[1])))
  with check (bucket_id = 'face-refs'
              and (storage.foldername(name))[2] = (select auth.uid())::text
              and private.is_room_member(private.try_uuid((storage.foldername(name))[1])));
