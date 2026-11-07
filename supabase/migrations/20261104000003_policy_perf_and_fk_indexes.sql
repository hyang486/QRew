-- Advisor fixes (performance): evaluate auth.uid() once per statement in policies,
-- index foreign keys, and give join_attempts a primary key.

drop policy profiles_select on public.profiles;
drop policy profiles_insert on public.profiles;
drop policy profiles_update on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.shares_open_room(id));
create policy profiles_insert on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy media_insert on public.media;
drop policy media_update_own on public.media;
create policy media_insert on public.media for insert to authenticated
  with check (uploader_id = (select auth.uid()) and private.is_room_member(room_id)
              and original_path like room_id::text || '/%');
create policy media_update_own on public.media for update to authenticated
  using (uploader_id = (select auth.uid()) and private.is_room_member(room_id))
  with check (uploader_id = (select auth.uid()) and private.is_room_member(room_id)
              and original_path like room_id::text || '/%');

drop policy messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (sender_id = (select auth.uid()) and kind in ('text', 'media')
              and private.is_room_member(room_id)
              and (media_id is null or exists (
                select 1 from public.media m
                where m.id = media_id and m.room_id = messages.room_id
                  and m.uploader_id = (select auth.uid()))));

drop policy push_tokens_own on public.push_tokens;
create policy push_tokens_own on public.push_tokens for select to authenticated
  using (user_id = (select auth.uid()));

drop policy face_enrollments_own on public.face_enrollments;
drop policy face_matches_own on public.face_matches;
drop policy face_matches_exclude on public.face_matches;
drop policy face_jobs_own on public.face_jobs;
create policy face_enrollments_own on public.face_enrollments for select to authenticated
  using (user_id = (select auth.uid()) and private.is_room_member(room_id));
create policy face_matches_own on public.face_matches for select to authenticated
  using (exists (select 1 from public.face_enrollments e
                 where e.id = enrollment_id and e.user_id = (select auth.uid())
                   and private.is_room_member(e.room_id)));
create policy face_matches_exclude on public.face_matches for update to authenticated
  using (exists (select 1 from public.face_enrollments e
                 where e.id = enrollment_id and e.user_id = (select auth.uid())
                   and private.is_room_member(e.room_id)))
  with check (exists (select 1 from public.face_enrollments e
                 where e.id = enrollment_id and e.user_id = (select auth.uid())
                   and private.is_room_member(e.room_id)));
create policy face_jobs_own on public.face_jobs for select to authenticated
  using (exists (select 1 from public.face_enrollments e
                 where e.id = enrollment_id and e.user_id = (select auth.uid())));

-- Foreign key indexes (also speed up the cascades that run on room/user deletion).
create index if not exists arrivals_user_idx on public.arrivals (user_id);
create index if not exists emergency_acks_user_idx on public.emergency_acks (user_id);
create index if not exists emergency_events_room_idx on public.emergency_events (room_id, created_at desc);
create index if not exists emergency_events_user_idx on public.emergency_events (user_id);
create index if not exists expiry_reminders_user_idx on public.expiry_reminders (user_id);
create index if not exists face_jobs_media_idx on public.face_jobs (media_id);
create index if not exists face_matches_media_idx on public.face_matches (media_id);
create index if not exists live_presence_user_idx on public.live_presence (user_id);
create index if not exists media_uploader_idx on public.media (uploader_id);
create index if not exists member_status_status_idx on public.member_status (status_id);
create index if not exists member_status_user_idx on public.member_status (user_id);
create index if not exists messages_media_idx on public.messages (media_id) where media_id is not null;
create index if not exists messages_sender_idx on public.messages (sender_id);
create index if not exists rooms_host_idx on public.rooms (host_id);

alter table public.join_attempts add column id bigint generated always as identity primary key;
