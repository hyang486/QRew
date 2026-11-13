-- Host-defined entry questions (human decision 2026-11-12 ~09:45; contract: planning/QREWING_AI_SPEC_EN.md
-- section 9.2).
--
-- The host of an event room sets the entry question list (1 to 8 questions) before turning "entry info
-- required" on. Attendees answer exactly those questions; the answers live in entry_profiles.answers
-- (keyed by question id), so the row keeps its RLS, expiry gating, cascade and the match rule "has an
-- entry_profiles row". headline and links are still written, derived from the answers (People to meet
-- reads them). The old columns (interests, looking_for) stay for rollback; upsert_entry_answers clears
-- them so they never disagree with answers.
--
-- Kinds: short (answer at most 80 chars), long (at most 300), links (up to 3 https:// links, each at
-- most 200 chars). Prompts are 1 to 120 chars, trimmed.
--
-- Concurrency: set_entry_questions takes an exclusive per-room advisory lock and upsert_entry_answers a
-- shared one, so answers are always validated against the list that is current when they are written,
-- and the list cannot be replaced while an answer is being saved.

-- Table ---------------------------------------------------------------------

create table public.entry_questions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  position smallint not null check (position between 0 and 7),
  kind text not null check (kind in ('short', 'long', 'links')),
  prompt text not null check (prompt = btrim(prompt) and char_length(prompt) between 1 and 120),
  required boolean not null default false,
  created_at timestamptz not null default now(),
  unique (room_id, position)
);

alter table public.entry_questions enable row level security;
revoke all on table public.entry_questions from public, anon, authenticated;
grant select on table public.entry_questions to authenticated;

-- Same gate as entry_profiles: members of an open room (no grace, no reads after expiry or end).
create policy entry_questions_select on public.entry_questions for select to authenticated
  using (private.is_room_member(room_id));

-- entry_profiles: answers, and headline may now be empty ------------------------

alter table public.entry_profiles
  add column answers jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object');
alter table public.entry_profiles drop constraint entry_profiles_headline_check;
alter table public.entry_profiles
  add constraint entry_profiles_headline_check check (headline = btrim(headline) and char_length(headline) <= 80);

-- Helpers ---------------------------------------------------------------------

create or replace function private.entry_room_lock_key(p_room_id uuid)
returns bigint language sql immutable
set search_path = ''
as $$
  select hashtextextended('entry_questions:' || p_room_id::text, 0)
$$;
revoke all on function private.entry_room_lock_key(uuid) from public, anon, authenticated;

-- RPCs ------------------------------------------------------------------------

-- Replace the room's question list. p_questions: [{"kind": "short"|"long"|"links", "prompt": text,
-- "required": boolean (optional, default false)}, ...] in display order; other keys are ignored.
-- Errors: 42501 not the host of an open room; 22023 not an event room or an invalid list;
-- 55000 the list is locked because an attendee has already saved entry info in the room (any
-- entry_profiles row counts, including one written by the old upsert_entry_profile).
create or replace function public.set_entry_questions(p_room_id uuid, p_questions jsonb)
returns setof public.entry_questions
language plpgsql security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_kind text;
  v_prompt text;
  v_required jsonb;
  v_pos integer := 0;
begin
  if not private.is_room_host(p_room_id) then
    raise exception 'Only the host of an open room can set entry questions' using errcode = '42501';
  end if;
  if (select r.type from public.rooms r where r.id = p_room_id) is distinct from 'event' then
    raise exception 'Entry questions are only for event rooms' using errcode = '22023';
  end if;
  if p_questions is null or jsonb_typeof(p_questions) <> 'array'
     or jsonb_array_length(p_questions) not between 1 and 8 then
    raise exception 'Add 1 to 8 questions' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(private.entry_room_lock_key(p_room_id));
  if exists (select 1 from public.entry_profiles e where e.room_id = p_room_id) then
    raise exception 'Questions are locked after the first answer' using errcode = '55000';
  end if;

  delete from public.entry_questions q where q.room_id = p_room_id;

  for v_item in select value from jsonb_array_elements(p_questions) loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Each question must be an object' using errcode = '22023';
    end if;
    v_kind := case when jsonb_typeof(v_item -> 'kind') = 'string' then v_item ->> 'kind' end;
    if v_kind is null or v_kind not in ('short', 'long', 'links') then
      raise exception 'Question kind must be short, long or links' using errcode = '22023';
    end if;
    v_prompt := case when jsonb_typeof(v_item -> 'prompt') = 'string' then btrim(v_item ->> 'prompt') end;
    if v_prompt is null or char_length(v_prompt) not between 1 and 120 then
      raise exception 'Each question needs 1 to 120 characters' using errcode = '22023';
    end if;
    v_required := coalesce(v_item -> 'required', 'false'::jsonb);
    if jsonb_typeof(v_required) <> 'boolean' then
      raise exception 'required must be true or false' using errcode = '22023';
    end if;

    insert into public.entry_questions (room_id, position, kind, prompt, required)
    values (p_room_id, v_pos, v_kind, v_prompt, v_required::text::boolean);
    v_pos := v_pos + 1;
  end loop;

  return query
    select q.* from public.entry_questions q where q.room_id = p_room_id order by q.position;
end;
$$;

-- Host switch (0027) plus: entry_required needs at least one entry question in the room.
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
  if v_entry and not exists (select 1 from public.entry_questions q where q.room_id = p_room_id) then
    raise exception 'Add at least one entry question first' using errcode = '22023';
  end if;

  insert into public.qrewing_rooms as q (room_id, ai_enabled, entry_required)
  values (p_room_id, v_ai, v_entry)
  on conflict (room_id) do update
    set ai_enabled = excluded.ai_enabled, entry_required = excluded.entry_required
  returning q.* into v_row;
  return v_row;
end;
$$;

-- The caller's own answers. p_answers: {"<question id>": "text" (short/long) or ["https://...", ...]
-- (links)}. Text is trimmed; blank text, blank links and empty link lists count as "no answer" and are
-- not stored. Errors: 42501 not a member of an open room; 22023 no questions in the room, an unknown
-- question id, a wrong value type, an over-cap answer, a non-https link, or a missing required answer.
-- Writes answers, headline (first short question's answer, else ''), links (first links question's
-- answer, else '{}'), and clears interests and looking_for.
create or replace function public.upsert_entry_answers(p_room_id uuid, p_answers jsonb)
returns public.entry_profiles
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row public.entry_profiles;
  v_in jsonb := coalesce(p_answers, '{}'::jsonb);
  v_out jsonb := '{}'::jsonb;
  v_key text;
  v_val jsonb;
  v_q public.entry_questions;
  v_text text;
  v_links text[];
  v_cap integer;
  v_headline text := '';
  v_first_links text[] := array[]::text[];
  v_seen_short boolean := false;
  v_seen_links boolean := false;
begin
  if not private.is_room_member(p_room_id) then
    raise exception 'Not a member of an open room' using errcode = '42501';
  end if;
  if jsonb_typeof(v_in) <> 'object' then
    raise exception 'Answers must be an object keyed by question id' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock_shared(private.entry_room_lock_key(p_room_id));
  if not exists (select 1 from public.entry_questions q where q.room_id = p_room_id) then
    raise exception 'This room has no entry questions' using errcode = '22023';
  end if;

  for v_key in select jsonb_object_keys(v_in) loop
    if not exists (select 1 from public.entry_questions q where q.room_id = p_room_id and q.id::text = v_key) then
      raise exception 'Unknown question' using errcode = '22023';
    end if;
  end loop;

  for v_q in select * from public.entry_questions q where q.room_id = p_room_id order by q.position loop
    v_val := v_in -> v_q.id::text;
    v_text := null;
    v_links := null;
    if v_val is not null and jsonb_typeof(v_val) <> 'null' then
      if v_q.kind in ('short', 'long') then
        if jsonb_typeof(v_val) <> 'string' then
          raise exception 'A text answer must be a string' using errcode = '22023';
        end if;
        v_text := btrim(v_val #>> '{}');
        v_cap := case v_q.kind when 'short' then 80 else 300 end;
        if char_length(v_text) > v_cap then
          raise exception 'Answer is too long' using errcode = '22023';
        end if;
        if v_text = '' then
          v_text := null;
        end if;
      else
        if jsonb_typeof(v_val) <> 'array'
           or exists (select 1 from jsonb_array_elements(v_val) x where jsonb_typeof(x) <> 'string') then
          raise exception 'A links answer must be a list of strings' using errcode = '22023';
        end if;
        select coalesce(array_agg(btrim(x) order by o), array[]::text[]) into v_links
          from jsonb_array_elements_text(v_val) with ordinality as t(x, o)
         where btrim(x) <> '';
        if not private.entry_links_ok(v_links) then
          raise exception 'Up to 3 links, each starting with https:// and at most 200 characters' using errcode = '22023';
        end if;
        if cardinality(v_links) = 0 then
          v_links := null;
        end if;
      end if;
    end if;

    if v_q.required and v_text is null and v_links is null then
      raise exception 'Answer every required question' using errcode = '22023';
    end if;

    if v_text is not null then
      v_out := v_out || jsonb_build_object(v_q.id::text, v_text);
    elsif v_links is not null then
      v_out := v_out || jsonb_build_object(v_q.id::text, to_jsonb(v_links));
    end if;

    if v_q.kind = 'short' and not v_seen_short then
      v_seen_short := true;
      v_headline := coalesce(v_text, '');
    elsif v_q.kind = 'links' and not v_seen_links then
      v_seen_links := true;
      v_first_links := coalesce(v_links, array[]::text[]);
    end if;
  end loop;

  insert into public.entry_profiles as e (room_id, user_id, headline, interests, looking_for, links, answers)
  values (p_room_id, auth.uid(), v_headline, '', '', v_first_links, v_out)
  on conflict (room_id, user_id) do update
    set headline = excluded.headline, interests = '', looking_for = '',
        links = excluded.links, answers = excluded.answers
  returning e.* into v_row;
  return v_row;
end;
$$;

revoke execute on function public.set_entry_questions(uuid, jsonb) from public, anon;
grant execute on function public.set_entry_questions(uuid, jsonb) to authenticated;
revoke execute on function public.set_qrewing_room(uuid, boolean, boolean) from public, anon;
grant execute on function public.set_qrewing_room(uuid, boolean, boolean) to authenticated;
revoke execute on function public.upsert_entry_answers(uuid, jsonb) from public, anon;
grant execute on function public.upsert_entry_answers(uuid, jsonb) to authenticated;

-- Backfill ----------------------------------------------------------------------
--
-- Every room that requires entry info or already has entry info gets the default four questions
-- (Headline short required, Interests long, Looking for long, Links links), and each existing profile is
-- converted to answers keyed by those question ids. Blank values are left out, as upsert_entry_answers
-- does. The conversion runs with the updated_at trigger disabled, so updated_at keeps its old value.

insert into public.entry_questions (room_id, position, kind, prompt, required)
select r.room_id, d.position, d.kind, d.prompt, d.required
from (
  select q.room_id from public.qrewing_rooms q where q.entry_required
  union
  select e.room_id from public.entry_profiles e
) r
cross join (values
  (0::smallint, 'short', 'Headline', true),
  (1::smallint, 'long', 'Interests', false),
  (2::smallint, 'long', 'Looking for', false),
  (3::smallint, 'links', 'Links', false)
) d(position, kind, prompt, required)
where not exists (select 1 from public.entry_questions x where x.room_id = r.room_id);

alter table public.entry_profiles disable trigger entry_profiles_set_updated_at;
update public.entry_profiles e
   set answers = jsonb_strip_nulls(jsonb_build_object(
         (select q.id::text from public.entry_questions q where q.room_id = e.room_id and q.position = 0),
         nullif(e.headline, ''),
         (select q.id::text from public.entry_questions q where q.room_id = e.room_id and q.position = 1),
         nullif(e.interests, ''),
         (select q.id::text from public.entry_questions q where q.room_id = e.room_id and q.position = 2),
         nullif(e.looking_for, ''),
         (select q.id::text from public.entry_questions q where q.room_id = e.room_id and q.position = 3),
         case when cardinality(e.links) > 0 then to_jsonb(e.links) end
       ))
 where exists (select 1 from public.entry_questions q where q.room_id = e.room_id);
alter table public.entry_profiles enable trigger entry_profiles_set_updated_at;

notify pgrst, 'reload schema';
