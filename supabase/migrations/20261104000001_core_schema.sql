-- Core schema for Moment rooms.
-- Access rule: a room is usable only while now() < expires_at and deleted_at is null.
-- That is enforced on every read/write here, independent of when cleanup runs.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Guest' check (char_length(display_name) between 1 and 40),
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  type text not null default 'general' check (type in ('sports', 'event', 'waiting', 'general')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  expiry_version integer not null default 1,
  deleted_at timestamptz,
  location_allowed boolean not null default false,
  activity_state text not null default 'idle' check (activity_state in ('idle', 'active', 'ended')),
  activity_started_at timestamptz,
  activity_ended_at timestamptz,
  route jsonb not null default '[]'::jsonb,
  code text not null unique check (code ~ '^[0-9]{5}$'),
  invite_token text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  max_members integer not null default 30,
  check (expires_at > created_at)
);
create index rooms_expires_at_idx on public.rooms (expires_at);

create table public.room_members (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('host', 'member')),
  joined_at timestamptz not null default now(),
  share_location boolean not null default false,
  primary key (room_id, user_id)
);
create index room_members_user_idx on public.room_members (user_id);

create table public.media (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  uploader_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('photo', 'video', 'file')),
  original_path text not null,
  preview_path text,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint,
  width integer,
  height integer,
  duration_ms integer,
  status text not null default 'uploading' check (status in ('uploading', 'ready', 'failed')),
  created_at timestamptz not null default now()
);
create index media_room_idx on public.media (room_id, created_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  sender_id uuid references auth.users (id) on delete set null,
  kind text not null default 'text' check (kind in ('text', 'media', 'system', 'arrival', 'emergency', 'status')),
  body text check (char_length(body) <= 4000),
  media_id uuid references public.media (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index messages_room_idx on public.messages (room_id, created_at desc);

create table public.status_definitions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 30),
  is_emergency boolean not null default false,
  sort integer not null default 0
);
create unique index status_definitions_one_emergency on public.status_definitions (room_id) where is_emergency;

create table public.member_status (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  status_id uuid not null references public.status_definitions (id) on delete cascade,
  updated_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table public.arrivals (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  arrived_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table public.live_presence (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  speed_mps double precision,
  accuracy_m double precision,
  heading double precision,
  updated_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table public.emergency_events (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  push_requested_at timestamptz,
  push_result jsonb
);

create table public.emergency_acks (
  event_id uuid not null references public.emergency_events (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  acked_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create table public.push_tokens (
  token text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  platform text not null default 'ios',
  updated_at timestamptz not null default now()
);
create index push_tokens_user_idx on public.push_tokens (user_id);

create table public.expiry_reminders (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  expiry_version integer not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'no_token', 'failed')),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  detail jsonb,
  primary key (room_id, user_id, expiry_version)
);

-- Face matching: everything hangs off a per-room, per-member enrollment.
-- Deleting the enrollment cascades to matches and jobs, so late API results have nothing to attach to.
create table public.face_enrollments (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null,
  user_id uuid not null,
  ref_path text not null,
  created_at timestamptz not null default now(),
  unique (room_id, user_id),
  foreign key (room_id, user_id) references public.room_members (room_id, user_id) on delete cascade
);

create table public.face_matches (
  enrollment_id uuid not null references public.face_enrollments (id) on delete cascade,
  media_id uuid not null references public.media (id) on delete cascade,
  similarity real,
  matched boolean not null,
  excluded boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (enrollment_id, media_id)
);

create table public.face_jobs (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.face_enrollments (id) on delete cascade,
  media_id uuid not null references public.media (id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (enrollment_id, media_id)
);

-- Storage prefixes that must be removed through the Storage API (service role).
create table public.cleanup_jobs (
  id uuid primary key default gen_random_uuid(),
  bucket text not null,
  prefix text not null,
  reason text not null,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  verified_empty_at timestamptz,
  unique (bucket, prefix)
);

create table public.join_attempts (
  user_id uuid not null references auth.users (id) on delete cascade,
  attempted_at timestamptz not null default now(),
  succeeded boolean not null
);
create index join_attempts_user_idx on public.join_attempts (user_id, attempted_at desc);
