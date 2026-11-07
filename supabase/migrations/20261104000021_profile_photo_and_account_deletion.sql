-- Profile photo and account deletion.
--
-- avatars bucket (private): {user_id}/{uuid}.jpg, one JPEG of at most 2 MB.
--   read:   the owner, or anyone who shares an open room with the owner (same rule as profiles).
--   write:  only the owner, inside their own folder. Clients never delete objects.
--   A replaced or cleared photo is queued for the room-janitor by exact path.
--   This is a display photo only. It is never used as a face-matching reference
--   (face references stay room-scoped in face-refs).
--
-- Account deletion runs in the delete-account Edge Function (service role):
--   1. public.prepare_account_deletion(user) ends the rooms the user hosts (members get the
--      normal "room ended" notice), queues Storage cleanup for the user's media in other rooms
--      and for their avatar folder, and removes their live positions.
--   2. auth.admin.deleteUser(user) then cascades: profile, memberships (with face enrollments,
--      which queue their own cleanup), media rows, status, arrivals, presence, emergencies, acks,
--      push tokens and reminders; hosted rooms are deleted and queue their folders. Chat messages
--      the user sent in other rooms stay with sender_id null, like messages from a member who left.
--   3. The room-janitor removes the queued Storage objects and verifies them gone.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 2097152, array['image/jpeg'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- True when the name is {caller}/{uuid}.jpg.
create or replace function private.is_own_avatar_path(p_name text)
returns boolean language sql stable
set search_path = ''
as $$
  select auth.uid() is not null
     and p_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$'
     and split_part(p_name, '/', 1) = auth.uid()::text
     and private.try_uuid(split_part(split_part(p_name, '/', 2), '.', 1)) is not null
$$;

revoke all on function private.is_own_avatar_path(text) from public, anon, authenticated;
grant execute on function private.is_own_avatar_path(text) to authenticated;

create policy avatars_select on storage.objects for select to authenticated
  using (bucket_id = 'avatars'
         and ((storage.foldername(name))[1] = (select auth.uid())::text
              or private.shares_open_room(private.try_uuid((storage.foldername(name))[1]))));

create policy avatars_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and private.is_own_avatar_path(name));

create policy avatars_update on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and owner_id = (select auth.uid())::text and private.is_own_avatar_path(name))
  with check (bucket_id = 'avatars' and private.is_own_avatar_path(name));

-- profiles.avatar_path may only point into the owner's folder; a replaced path is queued for cleanup.
create or replace function private.on_profile_avatar()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  if new.avatar_path is not null
     and (new.avatar_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$'
          or split_part(new.avatar_path, '/', 1) <> new.id::text) then
    raise exception 'Invalid profile photo path' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' and old.avatar_path is not null and old.avatar_path is distinct from new.avatar_path then
    perform private.enqueue_cleanup('avatars', old.avatar_path, 'avatar_replaced');
  end if;
  return new;
end;
$$;

create trigger profile_avatar before insert or update of avatar_path on public.profiles
  for each row execute function private.on_profile_avatar();

-- Step 1 of account deletion. Service role only (called by the delete-account Edge Function).
create or replace function public.prepare_account_deletion(p_user_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_rooms integer;
  v_media integer := 0;
  r record;
begin
  if p_user_id is null or not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'Unknown user' using errcode = '22023';
  end if;

  update public.rooms set deleted_at = now()
  where host_id = p_user_id and deleted_at is null;
  get diagnostics v_rooms = row_count;

  -- Hosted rooms queue their whole folder when they are deleted; queue the rest by media folder.
  for r in
    select m.room_id, m.id from public.media m
    join public.rooms ro on ro.id = m.room_id
    where m.uploader_id = p_user_id and ro.host_id <> p_user_id
  loop
    perform private.enqueue_cleanup('room-media', r.room_id::text || '/' || r.id::text || '/', 'account_deleted');
    v_media := v_media + 1;
  end loop;

  perform private.enqueue_cleanup('avatars', p_user_id::text || '/', 'account_deleted');

  update public.room_members set share_location = false where user_id = p_user_id;
  delete from public.live_presence where user_id = p_user_id;

  return jsonb_build_object('rooms_ended', v_rooms, 'media_folders_queued', v_media);
end;
$$;

revoke all on function public.prepare_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.prepare_account_deletion(uuid) to service_role;
