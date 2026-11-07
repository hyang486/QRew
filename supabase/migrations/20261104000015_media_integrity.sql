-- Media upload integrity.
--
-- A media row can only become 'ready' when its original object exists in room-media with
-- a nonzero size. The server copies that size into size_bytes, so the client cannot claim
-- a ready upload that was never stored (or stored empty). Once ready, the stored paths
-- and the original object are frozen: the uploader cannot overwrite the original.
-- content_sha256 is the uploader's hash of the original, used by downloaders to check
-- that the bytes they received are the bytes that were uploaded.

alter table public.media
  add column content_sha256 text check (content_sha256 ~ '^[0-9a-f]{64}$');

-- Explicit per-file cap (equals the Free plan global limit) so oversize uploads fail clearly.
update storage.buckets set file_size_limit = 52428800 where id = 'room-media';

create index if not exists media_room_uploader_idx on public.media (room_id, uploader_id, created_at desc);

create or replace function private.media_integrity()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare
  v_prefix text := new.room_id::text || '/' || new.id::text || '/';
  v_size bigint;
begin
  if new.original_path not like v_prefix || '%'
     or (new.preview_path is not null and new.preview_path not like v_prefix || '%') then
    raise exception 'Media paths must be under {room_id}/{media_id}/' using errcode = '22023';
  end if;

  if tg_op = 'UPDATE' and old.status = 'ready' then
    if new.status is distinct from 'ready'
       or new.original_path is distinct from old.original_path
       or new.preview_path is distinct from old.preview_path
       or new.content_sha256 is distinct from old.content_sha256
       or new.uploader_id is distinct from old.uploader_id
       or new.room_id is distinct from old.room_id then
      raise exception 'A ready media item cannot be changed' using errcode = '42501';
    end if;
    new.size_bytes := old.size_bytes;
    return new;
  end if;

  if new.status = 'ready' then
    select (o.metadata ->> 'size')::bigint into v_size
    from storage.objects o
    where o.bucket_id = 'room-media' and o.name = new.original_path;
    if v_size is null or v_size <= 0 then
      raise exception 'The original file is missing or empty' using errcode = '22023';
    end if;
    if new.preview_path is not null and not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'room-media' and o.name = new.preview_path
        and coalesce((o.metadata ->> 'size')::bigint, 0) > 0) then
      raise exception 'The preview file is missing or empty' using errcode = '22023';
    end if;
    new.size_bytes := v_size;
  end if;
  return new;
end;
$$;
revoke all on function private.media_integrity() from public, anon, authenticated;

create trigger media_integrity before insert or update on public.media
  for each row execute function private.media_integrity();

-- Storage writes are allowed only while the matching media row is not ready yet
-- (initial upload and retry); a ready original cannot be replaced.
create or replace function private.can_write_room_media(p_name text)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.media m
    where m.id = private.try_uuid((storage.foldername(p_name))[2])
      and m.room_id = private.try_uuid((storage.foldername(p_name))[1])
      and m.uploader_id = auth.uid()
      and m.status <> 'ready'
  ) and private.is_room_member(private.try_uuid((storage.foldername(p_name))[1]))
$$;
