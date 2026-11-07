-- Profile photo + account deletion test. Requires migrations through 0021.
-- One transaction, ends with ROLLBACK: leaves no data behind. Run as postgres (Supabase MCP execute_sql).
-- Success ends with the row 'ACCOUNT DELETION TESTS PASSED'.
--
-- Actors: A the account that is deleted (hosts room R1, member of R2), B host of R2, O outsider.
-- The auth.users delete stands in for auth.admin.deleteUser (same cascade).

begin;

create schema tests;
grant usage on schema tests to authenticated, anon;

create function tests.login(p_uid uuid, p_anon boolean) returns void language sql as $$
  select set_config('request.jwt.claims',
           json_build_object('sub', p_uid, 'role', 'authenticated', 'is_anonymous', p_anon)::text, true);
$$;

create function tests.expect(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then
    raise exception 'FAIL: %', p_label;
  end if;
end;
$$;

create function tests.expect_count(p_sql text, p_n bigint, p_label text) returns void language plpgsql as $$
declare v bigint;
begin
  execute 'select count(*) from (' || p_sql || ') s' into v;
  if v is distinct from p_n then
    raise exception 'FAIL: % (expected %, got %)', p_label, p_n, v;
  end if;
end;
$$;

create function tests.expect_sqlstate(p_sql text, p_state text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_state then
      return;
    end if;
    raise exception 'FAIL: % (expected SQLSTATE %, got %: %)', p_label, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: % (statement succeeded but should have failed)', p_label;
end;
$$;

create function tests.expect_error(p_sql text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    return;
  end;
  raise exception 'FAIL: % (statement succeeded but should have failed)', p_label;
end;
$$;

grant execute on all functions in schema tests to authenticated, anon;

insert into auth.users (instance_id, id, aud, role, email, is_anonymous, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e0000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'ad-a@test.invalid', false, '{"display_name":"Ann"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e0000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'ad-b@test.invalid', false, '{"display_name":"Ben"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e0000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', null, true, '{}', now(), now());

-- A hosts R1; B hosts R2 and A joins it.
select tests.login('e0000000-0000-4000-8000-000000000001', false);
set local role authenticated;
do $$
declare r public.rooms;
begin
  r := public.create_room('A room', 'general', now() + interval '1 day', false, array['Resting']);
  perform set_config('t.r1', r.id::text, true);
end $$;
reset role;

select tests.login('e0000000-0000-4000-8000-000000000002', false);
set local role authenticated;
do $$
declare r public.rooms;
begin
  r := public.create_room('B room', 'general', now() + interval '1 day', false, array['Resting']);
  perform set_config('t.r2', r.id::text, true);
  perform set_config('t.token2', r.invite_token, true);
end $$;
reset role;

-- Profile photo -----------------------------------------------------------------
select set_config('t.av1', 'e0000000-0000-4000-8000-000000000001/a1000000-0000-4000-8000-000000000001.jpg', true);
select set_config('t.av2', 'e0000000-0000-4000-8000-000000000001/a1000000-0000-4000-8000-000000000002.jpg', true);

select tests.login('e0000000-0000-4000-8000-000000000001', false);
set local role authenticated;
select public.join_room(null, current_setting('t.token2'));
-- Storage: own folder only, JPEG name pattern only.
insert into storage.objects (bucket_id, name, owner_id)
values ('avatars', current_setting('t.av1'), auth.uid()::text),
       ('avatars', current_setting('t.av2'), auth.uid()::text);
select tests.expect_error($q$ insert into storage.objects (bucket_id, name, owner_id)
  values ('avatars', 'e0000000-0000-4000-8000-000000000002/a1000000-0000-4000-8000-000000000009.jpg', auth.uid()::text) $q$,
  'cannot write into another user''s avatar folder');
select tests.expect_error($q$ insert into storage.objects (bucket_id, name, owner_id)
  values ('avatars', 'e0000000-0000-4000-8000-000000000001/../x.jpg', auth.uid()::text) $q$,
  'cannot write a malformed avatar name');
-- profiles.avatar_path: own folder and pattern only.
select tests.expect_sqlstate($q$ update public.profiles set avatar_path = 'e0000000-0000-4000-8000-000000000002/a1000000-0000-4000-8000-000000000001.jpg'
  where id = auth.uid() $q$, '22023', 'avatar_path into another folder refused');
select tests.expect_sqlstate($q$ update public.profiles set avatar_path = 'x.jpg' where id = auth.uid() $q$,
  '22023', 'malformed avatar_path refused');
update public.profiles set avatar_path = current_setting('t.av1') where id = auth.uid();
update public.profiles set avatar_path = current_setting('t.av2') where id = auth.uid();
reset role;

select tests.expect_count($q$ select 1 from public.cleanup_jobs where bucket = 'avatars' and prefix = current_setting('t.av1') $q$,
  1, 'replaced avatar queued for cleanup by exact path');

-- B shares R2 with A: sees the photo. O shares nothing: sees neither the object nor the profile.
select tests.login('e0000000-0000-4000-8000-000000000002', false);
set local role authenticated;
select tests.expect_count($q$ select 1 from storage.objects where bucket_id = 'avatars' and name = current_setting('t.av2') $q$,
  1, 'co-member reads the avatar');
-- B cannot change A's photo (RLS: own profile only; the update matches no row).
update public.profiles set avatar_path = null where id = 'e0000000-0000-4000-8000-000000000001';
select tests.expect_error($q$ insert into storage.objects (bucket_id, name, owner_id)
  values ('avatars', 'e0000000-0000-4000-8000-000000000001/a1000000-0000-4000-8000-000000000003.jpg', auth.uid()::text) $q$,
  'co-member cannot write into another user''s avatar folder');
reset role;
select tests.expect((select avatar_path = current_setting('t.av2') from public.profiles
  where id = 'e0000000-0000-4000-8000-000000000001'), 'co-member cannot clear another user''s photo');
select tests.login('e0000000-0000-4000-8000-000000000003', true);
set local role authenticated;
select tests.expect_count($q$ select 1 from storage.objects where bucket_id = 'avatars' $q$, 0, 'outsider reads no avatar');
select tests.expect_count($q$ select 1 from public.profiles where id = 'e0000000-0000-4000-8000-000000000001' $q$,
  0, 'outsider reads no profile');
reset role;

-- A's content in B's room: one media item and one chat message.
select tests.login('e0000000-0000-4000-8000-000000000001', false);
set local role authenticated;
insert into public.media (id, room_id, uploader_id, kind, original_path, preview_path, file_name, mime_type, status)
values ('a2000000-0000-4000-8000-000000000001', current_setting('t.r2')::uuid, auth.uid(), 'photo',
        current_setting('t.r2') || '/a2000000-0000-4000-8000-000000000001/original.jpg', null, 'p.jpg', 'image/jpeg', 'uploading');
insert into public.messages (room_id, sender_id, kind, body) values (current_setting('t.r2')::uuid, auth.uid(), 'text', 'hello');
-- Clients cannot run the deletion step.
select tests.expect_sqlstate($q$ select public.prepare_account_deletion(auth.uid()) $q$, '42501',
  'authenticated cannot call prepare_account_deletion');
reset role;
set local role anon;
select tests.expect_sqlstate($q$ select public.prepare_account_deletion('e0000000-0000-4000-8000-000000000001') $q$, '42501',
  'anon cannot call prepare_account_deletion');
reset role;

-- Fixture (as postgres): A shares location in R2 and has a live position.
update public.room_members set share_location = true
where room_id = current_setting('t.r2')::uuid and user_id = 'e0000000-0000-4000-8000-000000000001';
insert into public.live_presence (room_id, user_id, lat, lng)
values (current_setting('t.r2')::uuid, 'e0000000-0000-4000-8000-000000000001', 37.77, -122.48);

-- Deletion step 1 (service role path).
select tests.expect_sqlstate($q$ select public.prepare_account_deletion('e0000000-0000-4000-8000-0000000000ff') $q$, '22023',
  'unknown user refused');
select tests.expect(
  public.prepare_account_deletion('e0000000-0000-4000-8000-000000000001') = '{"rooms_ended": 1, "media_folders_queued": 1}'::jsonb,
  'one hosted room ended, one media folder queued');
select tests.expect((select deleted_at is not null from public.rooms where id = current_setting('t.r1')::uuid),
  'hosted room ended (members lose access now)');
select tests.expect((select deleted_at is null from public.rooms where id = current_setting('t.r2')::uuid),
  'other host''s room untouched');
select tests.expect_count($q$ select 1 from public.cleanup_jobs where bucket = 'room-media'
  and prefix = current_setting('t.r2') || '/a2000000-0000-4000-8000-000000000001/' $q$, 1, 'media folder in other room queued');
select tests.expect_count($q$ select 1 from public.cleanup_jobs where bucket = 'avatars'
  and prefix = 'e0000000-0000-4000-8000-000000000001/' $q$, 1, 'avatar folder queued');
select tests.expect_count($q$ select 1 from public.room_members where user_id = 'e0000000-0000-4000-8000-000000000001'
  and share_location $q$, 0, 'location sharing stopped');
select tests.expect_count($q$ select 1 from public.live_presence where user_id = 'e0000000-0000-4000-8000-000000000001' $q$,
  0, 'live position removed');

-- Deletion step 2: the auth user (stands in for auth.admin.deleteUser).
delete from auth.users where id = 'e0000000-0000-4000-8000-000000000001';
select tests.expect_count($q$ select 1 from public.profiles where id = 'e0000000-0000-4000-8000-000000000001' $q$, 0, 'profile deleted');
select tests.expect_count($q$ select 1 from public.rooms where id = current_setting('t.r1')::uuid $q$, 0, 'hosted room deleted');
select tests.expect_count($q$ select 1 from public.cleanup_jobs where bucket = 'room-media' and prefix = current_setting('t.r1') || '/' $q$,
  1, 'hosted room folder queued');
select tests.expect_count($q$ select 1 from public.room_members where user_id = 'e0000000-0000-4000-8000-000000000001' $q$, 0, 'memberships deleted');
select tests.expect_count($q$ select 1 from public.media where id = 'a2000000-0000-4000-8000-000000000001' $q$, 0, 'media row deleted');
select tests.expect_count($q$ select 1 from public.messages where room_id = current_setting('t.r2')::uuid and body = 'hello' and sender_id is null $q$,
  1, 'chat message kept without sender');
select tests.expect_count($q$ select 1 from public.room_members where room_id = current_setting('t.r2')::uuid $q$, 1, 'B still in R2');

select 'ACCOUNT DELETION TESTS PASSED' as result;

rollback;
