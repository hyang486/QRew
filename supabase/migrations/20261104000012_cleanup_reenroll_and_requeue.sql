-- Cleanup precision for face references (supervisor ruling, janitor checkpoint).
--
-- 1. enqueue_cleanup refreshes created_at on conflict. A prefix job removes only objects that
--    existed when it was (last) queued, so a later re-join and re-enroll is never swept by an old job.
-- 2. Re-enrolling replaces the enrollment (delete + insert). The delete trigger would queue the whole
--    `room/user/` prefix, which also holds the new reference. During enroll_face the trigger queues
--    only the exact old ref_path instead. Leave and room end still queue the prefix.

create or replace function private.enqueue_cleanup(p_bucket text, p_prefix text, p_reason text)
returns void language sql security definer
set search_path = ''
as $$
  insert into public.cleanup_jobs (bucket, prefix, reason)
  values (p_bucket, p_prefix, p_reason)
  on conflict (bucket, prefix) do update
    set verified_empty_at = null, attempts = 0, last_error = null, reason = excluded.reason, created_at = now()
$$;

create or replace function private.on_face_enrollment_deleted()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('app.face_reenroll', true), '') = 'on' then
    perform private.enqueue_cleanup('face-refs', old.ref_path, 'face_enrollment_replaced');
  else
    perform private.enqueue_cleanup('face-refs', old.room_id::text || '/' || old.user_id::text || '/', 'face_enrollment_deleted');
  end if;
  return old;
end;
$$;

create or replace function public.enroll_face(p_room_id uuid, p_ref_path text)
returns uuid language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not private.is_room_member(p_room_id) then
    raise exception 'Not a member of this room' using errcode = '42501';
  end if;
  if p_ref_path not like p_room_id::text || '/' || auth.uid()::text || '/%' then
    raise exception 'Invalid reference path' using errcode = '22023';
  end if;
  perform set_config('app.face_reenroll', 'on', true);
  delete from public.face_enrollments where room_id = p_room_id and user_id = auth.uid();
  perform set_config('app.face_reenroll', 'off', true);
  insert into public.face_enrollments (room_id, user_id, ref_path)
  values (p_room_id, auth.uid(), p_ref_path) returning id into v_id;
  insert into public.face_jobs (enrollment_id, media_id)
  select v_id, m.id from public.media m
  where m.room_id = p_room_id and m.kind = 'photo' and m.status = 'ready'
  on conflict do nothing;
  return v_id;
end;
$$;
