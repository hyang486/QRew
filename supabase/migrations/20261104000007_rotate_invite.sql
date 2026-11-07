-- Supervisor finding F5 (spec 234): the host can revoke and reissue the invite.
-- A new 5-digit code and a new token replace the old ones, so the old QR, link and code stop working.
-- Existing members are unaffected.

create or replace function public.rotate_invite(p_room_id uuid)
returns table (code text, invite_token text)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_code text;
  v_token text;
begin
  if not private.is_room_host(p_room_id) then
    raise exception 'Only the host can reissue the invite.' using errcode = '42501';
  end if;
  v_code := private.generate_room_code();
  v_token := encode(extensions.gen_random_bytes(18), 'hex');
  update public.rooms r set code = v_code, invite_token = v_token
  where r.id = p_room_id and r.deleted_at is null and r.expires_at > now();
  if not found then
    raise exception 'This room has ended.' using errcode = 'P0002';
  end if;
  return query select v_code, v_token;
end;
$$;

revoke execute on function public.rotate_invite(uuid) from public, anon;
grant execute on function public.rotate_invite(uuid) to authenticated;
