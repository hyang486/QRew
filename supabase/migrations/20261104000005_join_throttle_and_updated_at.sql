-- Checkpoint 3 fixes.
-- F1 (supervisor review, security): join_room recorded a failed attempt and then raised,
-- so the raise rolled the join_attempts row back and the 10-per-10-minutes limit never
-- triggered. An invalid invite now returns null (the failure row is kept); the client maps
-- null to "This invite is invalid or the room has ended."
-- Also: profiles.updated_at (and face_jobs.updated_at) are maintained by a trigger.

create or replace function public.join_room(p_code text default null, p_token text default null)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_recent int;
  v_count int;
begin
  if auth.uid() is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  select count(*) into v_recent from public.join_attempts
  where user_id = auth.uid() and not succeeded and attempted_at > now() - interval '10 minutes';
  if v_recent >= 10 then
    raise exception 'Too many attempts. Try again in a few minutes.' using errcode = '54000';
  end if;

  select * into v_room from public.rooms r
  where r.deleted_at is null and r.expires_at > now()
    and ((p_code is not null and r.code = p_code) or (p_token is not null and r.invite_token = p_token))
  limit 1
  for update;

  if v_room.id is null then
    -- Do not raise here: a raise would roll back this row and disable the throttle.
    insert into public.join_attempts (user_id, succeeded) values (auth.uid(), false);
    return null;
  end if;

  if exists (select 1 from public.room_members where room_id = v_room.id and user_id = auth.uid()) then
    return v_room.id;
  end if;

  select count(*) into v_count from public.room_members where room_id = v_room.id;
  if v_count >= v_room.max_members then
    raise exception 'This room is full.' using errcode = '54000';
  end if;

  insert into public.room_members (room_id, user_id, role) values (v_room.id, auth.uid(), 'member');
  insert into public.join_attempts (user_id, succeeded) values (auth.uid(), true);
  insert into public.messages (room_id, sender_id, kind, body)
  values (v_room.id, auth.uid(), 'system',
          coalesce((select display_name from public.profiles where id = auth.uid()), 'Someone') || ' joined');
  return v_room.id;
end;
$$;

comment on function public.join_room(text, text) is
  'Joins a room by code or token. Returns the room id, or null when the invite is invalid or the room has ended (the failed attempt is recorded for throttling).';

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.set_updated_at() from public, anon, authenticated;

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();

create trigger face_jobs_set_updated_at before update on public.face_jobs
  for each row execute function private.set_updated_at();
