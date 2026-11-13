-- Qrewing AI (human decision 2026-11-12; contract: planning/QREWING_AI_SPEC_EN.md section 1).
--
-- Five room-scoped tables plus one private usage log:
--   public.qrewing_rooms     host switch per room (AI on, entry info required)
--   public.qrewing_members   per-member consent (ai_ok_at) and "mute small talk"
--   public.entry_profiles    event entry info (headline, interests, looking for, links)
--   public.message_triage    per-message "important" result (one result serves every muted member)
--   public.room_recaps       one end-of-room recap per room
--   public.qrewing_matches   per-member "people to meet" list
--   private.qrewing_usage    token counts only (no content, no FK), so the human can check cost
--
-- Deletion: every public table cascades from rooms or room_members, so the existing end/expiry path
-- (room-janitor hard delete of the room row) removes them, and leaving a room removes the leaver's rows.
-- Access: every read policy goes through private.is_room_member, which already denies once the room has
-- expired or ended; the only exception is room_recaps during an early-end grace period (end of file).
-- Clients never write directly: the three RPCs below handle client writes; triage,
-- recaps and matches are written by the qrewing Edge Function with the service role.

-- Tables --------------------------------------------------------------------

create table public.qrewing_rooms (
  room_id uuid primary key references public.rooms (id) on delete cascade,
  ai_enabled boolean not null default false,
  entry_required boolean not null default false,
  updated_at timestamptz not null default now(),
  check (not entry_required or ai_enabled)
);

create table public.qrewing_members (
  room_id uuid not null,
  user_id uuid not null,
  ai_ok_at timestamptz,
  mute_small_talk boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (room_id, user_id),
  foreign key (room_id, user_id) references public.room_members (room_id, user_id) on delete cascade,
  check (not mute_small_talk or ai_ok_at is not null)
);

-- Links: at most 3, each https:// with no whitespace, at most 200 characters. Shown only, never fetched.
create or replace function private.entry_links_ok(p_links text[])
returns boolean language sql immutable
set search_path = ''
as $$
  select coalesce(cardinality(p_links), 0) <= 3
     and array_position(p_links, null) is null
     and not exists (
       select 1 from unnest(p_links) l
       where l !~ '^https://[^[:space:]]+$' or char_length(l) > 200
     )
$$;

create table public.entry_profiles (
  room_id uuid not null,
  user_id uuid not null,
  headline text not null check (headline = btrim(headline) and char_length(headline) between 1 and 80),
  interests text not null default '' check (char_length(interests) <= 300),
  looking_for text not null default '' check (char_length(looking_for) <= 300),
  links text[] not null default '{}' check (private.entry_links_ok(links)),
  updated_at timestamptz not null default now(),
  primary key (room_id, user_id),
  foreign key (room_id, user_id) references public.room_members (room_id, user_id) on delete cascade
);

create table public.message_triage (
  message_id uuid primary key references public.messages (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  state text not null check (state in ('pending', 'done', 'skipped')),
  important boolean,
  reason text check (char_length(reason) <= 140),
  -- 'rule' = the Edge Function's prefilter decided it with no model call (spec 8.8); only 'model' rows count
  -- toward the 300-a-day cap.
  source text not null default 'model' check (source in ('model', 'rule')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- pending has no result yet; only a done row can be important (skipped rows may say false).
  check (state <> 'pending' or (important is null and reason is null)),
  check (important is not true or state = 'done'),
  check (source = 'model' or state = 'done')
);
create index message_triage_room_created_idx on public.message_triage (room_id, created_at);

-- Highlights: at most 5, each at most 140 characters.
create or replace function private.recap_highlights_ok(p_items text[])
returns boolean language sql immutable
set search_path = ''
as $$
  select p_items is null or (
    cardinality(p_items) <= 5
    and array_position(p_items, null) is null
    and not exists (select 1 from unnest(p_items) h where char_length(h) > 140)
  )
$$;

create table public.room_recaps (
  room_id uuid primary key references public.rooms (id) on delete cascade,
  state text not null check (state in ('pending', 'done', 'failed')),
  title text check (char_length(title) <= 80),
  summary text check (char_length(summary) <= 700),
  highlights text[] check (private.recap_highlights_ok(highlights)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Set by the one allowed recap refresh (spec 7.2); null = not refreshed yet.
  refreshed_at timestamptz,
  check (state <> 'done' or (title is not null and summary is not null))
);

create table public.qrewing_matches (
  room_id uuid not null,
  user_id uuid not null,
  input_hash text not null,
  matches jsonb not null check (jsonb_typeof(matches) = 'array'),
  created_at timestamptz not null default now(),
  primary key (room_id, user_id),
  foreign key (room_id, user_id) references public.room_members (room_id, user_id) on delete cascade
);

-- Counts only. No FK, so a row may outlive its room (it holds no content). Not exposed to clients.
create table private.qrewing_usage (
  id bigint generated always as identity primary key,
  room_id uuid,
  action text not null check (action in ('triage', 'recap', 'match')),
  model text not null,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  created_at timestamptz not null default now()
);
create index qrewing_usage_room_created_idx on private.qrewing_usage (room_id, created_at);
alter table private.qrewing_usage enable row level security;
revoke all on table private.qrewing_usage from public, anon, authenticated;

-- updated_at maintenance (same trigger function as profiles and face_jobs, 0005).
create trigger qrewing_rooms_set_updated_at before update on public.qrewing_rooms
  for each row execute function private.set_updated_at();
create trigger qrewing_members_set_updated_at before update on public.qrewing_members
  for each row execute function private.set_updated_at();
create trigger entry_profiles_set_updated_at before update on public.entry_profiles
  for each row execute function private.set_updated_at();
create trigger message_triage_set_updated_at before update on public.message_triage
  for each row execute function private.set_updated_at();
create trigger room_recaps_set_updated_at before update on public.room_recaps
  for each row execute function private.set_updated_at();

-- RLS and grants --------------------------------------------------------------

alter table public.qrewing_rooms enable row level security;
alter table public.qrewing_members enable row level security;
alter table public.entry_profiles enable row level security;
alter table public.message_triage enable row level security;
alter table public.room_recaps enable row level security;
alter table public.qrewing_matches enable row level security;

-- Clients read only; every write goes through an RPC below or the service role.
revoke all on table public.qrewing_rooms, public.qrewing_members, public.entry_profiles,
  public.message_triage, public.room_recaps, public.qrewing_matches from public, anon, authenticated;
grant select on table public.qrewing_rooms, public.qrewing_members, public.entry_profiles,
  public.message_triage, public.room_recaps, public.qrewing_matches to authenticated;

create policy qrewing_rooms_select on public.qrewing_rooms for select to authenticated
  using (private.is_room_member(room_id));
create policy qrewing_members_select_own on public.qrewing_members for select to authenticated
  using (user_id = (select auth.uid()) and private.is_room_member(room_id));
-- Attendees see each other's entry info (the entry form says so).
create policy entry_profiles_select on public.entry_profiles for select to authenticated
  using (private.is_room_member(room_id));
create policy message_triage_select on public.message_triage for select to authenticated
  using (private.is_room_member(room_id));
create policy room_recaps_select on public.room_recaps for select to authenticated
  using (private.is_room_member(room_id));
create policy qrewing_matches_select_own on public.qrewing_matches for select to authenticated
  using (user_id = (select auth.uid()) and private.is_room_member(room_id));

-- RPCs ------------------------------------------------------------------------

-- Host switch. entry_required needs ai_enabled and an event room.
create or replace function public.set_qrewing_room(p_room_id uuid, p_ai_enabled boolean, p_entry_required boolean)
returns public.qrewing_rooms
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row public.qrewing_rooms;
  v_ai boolean := coalesce(p_ai_enabled, false);
  v_entry boolean := coalesce(p_entry_required, false);
begin
  if not private.is_room_host(p_room_id) then
    raise exception 'Only the host of an open room can change Qrewing AI' using errcode = '42501';
  end if;
  if v_entry and (not v_ai or (select r.type from public.rooms r where r.id = p_room_id) <> 'event') then
    raise exception 'Entry info can be required only in an event room with Qrewing AI on' using errcode = '22023';
  end if;

  insert into public.qrewing_rooms as q (room_id, ai_enabled, entry_required)
  values (p_room_id, v_ai, v_entry)
  on conflict (room_id) do update
    set ai_enabled = excluded.ai_enabled, entry_required = excluded.entry_required
  returning q.* into v_row;
  return v_row;
end;
$$;

-- The caller's own consent and mute setting. Agreeing needs Qrewing AI on in the room; withdrawing
-- (p_ai_ok false) is always allowed, clears ai_ok_at and turns mute off. Mute needs consent.
create or replace function public.set_qrewing_member(p_room_id uuid, p_ai_ok boolean, p_mute boolean)
returns public.qrewing_members
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row public.qrewing_members;
  v_ok boolean := coalesce(p_ai_ok, false);
  v_mute boolean := coalesce(p_mute, false);
begin
  if not private.is_room_member(p_room_id) then
    raise exception 'Not a member of an open room' using errcode = '42501';
  end if;
  if v_mute and not v_ok then
    raise exception 'Mute small talk needs Qrewing AI consent' using errcode = '22023';
  end if;
  if v_ok and not coalesce((select q.ai_enabled from public.qrewing_rooms q where q.room_id = p_room_id), false) then
    raise exception 'Qrewing AI is off in this room' using errcode = '22023';
  end if;

  insert into public.qrewing_members as m (room_id, user_id, ai_ok_at, mute_small_talk)
  values (p_room_id, auth.uid(), case when v_ok then now() end, v_mute)
  on conflict (room_id, user_id) do update
    set ai_ok_at = case when v_ok then coalesce(m.ai_ok_at, now()) end,
        mute_small_talk = excluded.mute_small_talk
  returning m.* into v_row;
  return v_row;
end;
$$;

-- The caller's own entry info. Text is trimmed; limits as in the table (raised as 22023 here).
create or replace function public.upsert_entry_profile(
  p_room_id uuid, p_headline text, p_interests text, p_looking_for text, p_links text[]
) returns public.entry_profiles
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row public.entry_profiles;
  v_headline text := btrim(coalesce(p_headline, ''));
  v_interests text := btrim(coalesce(p_interests, ''));
  v_looking text := btrim(coalesce(p_looking_for, ''));
  v_links text[] := coalesce(p_links, array[]::text[]);
begin
  if not private.is_room_member(p_room_id) then
    raise exception 'Not a member of an open room' using errcode = '42501';
  end if;
  if char_length(v_headline) not between 1 and 80 then
    raise exception 'Headline must be 1 to 80 characters' using errcode = '22023';
  end if;
  if char_length(v_interests) > 300 or char_length(v_looking) > 300 then
    raise exception 'Interests and looking for must be at most 300 characters each' using errcode = '22023';
  end if;
  if not private.entry_links_ok(v_links) then
    raise exception 'Up to 3 links, each starting with https:// and at most 200 characters' using errcode = '22023';
  end if;

  insert into public.entry_profiles as e (room_id, user_id, headline, interests, looking_for, links)
  values (p_room_id, auth.uid(), v_headline, v_interests, v_looking, v_links)
  on conflict (room_id, user_id) do update
    set headline = excluded.headline, interests = excluded.interests,
        looking_for = excluded.looking_for, links = excluded.links
  returning e.* into v_row;
  return v_row;
end;
$$;

-- Usage log for the Edge Function (service_role only): counts, never content.
create or replace function public.log_qrewing_usage(
  p_room_id uuid, p_action text, p_model text, p_input_tokens integer, p_output_tokens integer
) returns void
language sql security definer
set search_path = ''
as $$
  insert into private.qrewing_usage (room_id, action, model, input_tokens, output_tokens)
  values (p_room_id, p_action, p_model, coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0));
$$;

revoke execute on function public.set_qrewing_room(uuid, boolean, boolean) from public, anon;
grant execute on function public.set_qrewing_room(uuid, boolean, boolean) to authenticated;
revoke execute on function public.set_qrewing_member(uuid, boolean, boolean) from public, anon;
grant execute on function public.set_qrewing_member(uuid, boolean, boolean) to authenticated;
revoke execute on function public.upsert_entry_profile(uuid, text, text, text, text[]) from public, anon;
grant execute on function public.upsert_entry_profile(uuid, text, text, text, text[]) to authenticated;
revoke execute on function public.log_qrewing_usage(uuid, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.log_qrewing_usage(uuid, text, text, integer, integer) to service_role;
revoke all on function private.entry_links_ok(text[]) from public, anon;
grant execute on function private.entry_links_ok(text[]) to authenticated, service_role;
revoke all on function private.recap_highlights_ok(text[]) from public, anon;
grant execute on function private.recap_highlights_ok(text[]) to authenticated, service_role;

-- Recap broadcast: when a recap row is done, members who are online get the existing minimal room
-- notice {table:'room_recaps', op} on room:<id> (0017/0018 rules: only while the room is live) and
-- re-read the row through RLS. Pending and failed rows are not announced.
create trigger broadcast_room_change after insert or update on public.room_recaps
  for each row when (new.state = 'done') execute function private.broadcast_room_change();

-- Early-end grace period (human decision 2026-11-12 (b); spec 7.1) -------------------------------
--
-- When the host ends a room early, the room stays on the server for 30 minutes (grace_until) so members
-- can read the AI recap, Photos of me and download originals. The room is closed for everything else:
-- private.is_room_member / is_room_host / room_is_open are unchanged (they require deleted_at is null),
-- so every existing write RPC, write policy and read policy keeps denying. Grace adds SELECT-only
-- policies for exactly: own rooms row, own room_members row, media rows, room-media originals and
-- previews in Storage (never detect/ copies), own face_enrollments and face_matches, and room_recaps.
-- No messages, member list, locations, statuses, emergencies, triage, matches or entry profiles.
-- An expiry (expires_at passing) has no grace, and neither does the account-deletion end (0021 sets only
-- deleted_at). room-janitor deletes a room once (expired or ended) and (no grace or grace over).

alter table public.rooms add column grace_until timestamptz;

create or replace function public.end_room(p_room_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not private.is_room_host(p_room_id) then
    raise exception 'Only the host can end this room.' using errcode = '42501';
  end if;
  update public.rooms
     set deleted_at = now(), grace_until = now() + interval '30 minutes'
   where id = p_room_id;
end;
$$;
revoke execute on function public.end_room(uuid) from public, anon;
grant execute on function public.end_room(uuid) to authenticated;

-- The caller is a member of a room the host ended early whose grace period has not run out.
create or replace function private.is_grace_member(p_room_id uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.room_members m
    join public.rooms r on r.id = m.room_id
    where m.room_id = p_room_id and m.user_id = auth.uid()
      and r.deleted_at is not null and r.grace_until > now()
  )
$$;
revoke all on function private.is_grace_member(uuid) from public, anon;
grant execute on function private.is_grace_member(uuid) to authenticated;

-- SELECT-only grace policies (permissive, so they add to the open-room policies; never for writes).
create policy rooms_select_grace on public.rooms for select to authenticated
  using (private.is_grace_member(id));
create policy members_select_own_grace on public.room_members for select to authenticated
  using (user_id = (select auth.uid()) and private.is_grace_member(room_id));
create policy media_select_grace on public.media for select to authenticated
  using (private.is_grace_member(room_id));
create policy room_media_select_grace on storage.objects for select to authenticated
  using (bucket_id = 'room-media'
         and not private.is_detect_path(name)
         and private.is_grace_member(private.try_uuid((storage.foldername(name))[1])));
create policy face_enrollments_own_grace on public.face_enrollments for select to authenticated
  using (user_id = (select auth.uid()) and private.is_grace_member(room_id));
create policy face_matches_own_grace on public.face_matches for select to authenticated
  using (exists (select 1 from public.face_enrollments e
                 where e.id = enrollment_id and e.user_id = (select auth.uid())
                   and private.is_grace_member(e.room_id)));
create policy room_recaps_select_grace on public.room_recaps for select to authenticated
  using (private.is_grace_member(room_id));

-- Realtime during grace: only the room_recaps notice is sent (0018 rule plus one exception), and a grace
-- member may receive only that event on room:<id>.
create or replace function private.broadcast_room_change()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_room uuid;
begin
  if tg_table_name = 'rooms' then
    if tg_op = 'DELETE' then
      return null;
    end if;
    v_row := to_jsonb(new);
    v_room := new.id;
    if tg_op = 'UPDATE' and not (old.deleted_at is null and old.expires_at > now()) then
      return null;
    end if;
    if tg_op = 'INSERT' and not (new.deleted_at is null and new.expires_at > now()) then
      return null;
    end if;
  else
    if tg_table_name = 'emergency_acks' then
      -- No room_id column; when the event itself is being deleted (cascade) there is nobody to tell.
      select e.room_id into v_room from public.emergency_events e where e.id = (v_row ->> 'event_id')::uuid;
    else
      v_room := (v_row ->> 'room_id')::uuid;
    end if;
    if v_room is null or not exists (
      select 1 from public.rooms r
      where r.id = v_room
        and ((r.deleted_at is null and r.expires_at > now())
             or (tg_table_name = 'room_recaps' and r.deleted_at is not null and r.grace_until > now()))
    ) then
      return null;
    end if;
  end if;
  perform realtime.send(
    jsonb_strip_nulls(jsonb_build_object('table', tg_table_name, 'op', tg_op, 'id', v_row ->> 'id')),
    tg_table_name,
    'room:' || v_room::text,
    true
  );
  return null;
end;
$$;
revoke all on function private.broadcast_room_change() from public, anon, authenticated;

create policy room_topic_receive_grace on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and realtime.messages.event = 'room_recaps'
    and private.is_grace_member(private.room_topic_id((select realtime.topic())))
  );

-- room-janitor cadence: every 5 minutes (was 15; human decision 2026-11-12). cron.schedule with an
-- existing job name updates that job in place, so there is never a second job.
select cron.schedule('room-janitor', '*/5 * * * *', 'select private.invoke_janitor()');

notify pgrst, 'reload schema';
