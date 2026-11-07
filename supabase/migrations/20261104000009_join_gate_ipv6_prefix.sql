-- F6 (supervisor review of F1b): an IPv6 subscriber usually holds a whole /64 and can rotate
-- source addresses inside it, which bypassed the per-IP budgets. The per-IP key is now:
--   IPv6                 -> its /64 prefix (e.g. 2001:db8:1:2::/64)
--   IPv4-mapped IPv6     -> the plain IPv4 address (::ffff:203.0.113.7 -> 203.0.113.7)
--   IPv4                 -> the address itself (unchanged)
--   unparseable value    -> the raw string (never fails the request)
-- Only the HMAC of this key is stored, as before.

create or replace function private.normalize_ip(p_ip text)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v inet;
begin
  if p_ip is null or btrim(p_ip) = '' then
    return null;
  end if;
  begin
    v := btrim(p_ip)::inet;
  exception when others then
    return btrim(p_ip);
  end;
  if family(v) = 6 then
    if v <<= '::ffff:0.0.0.0/96'::inet then
      return host('0.0.0.0'::inet + (v - '::ffff:0.0.0.0'::inet));
    end if;
    return network(set_masklen(v, 64))::text;
  end if;
  return host(v);
end;
$$;

create or replace function private.request_ip()
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_headers json := nullif(current_setting('request.headers', true), '')::json;
  v_ip text;
begin
  if v_headers is null then
    return null;
  end if;
  -- For list-valued headers take the LAST hop (the one our gateway appended).
  v_ip := coalesce(
    nullif(btrim(v_headers ->> 'cf-connecting-ip'), ''),
    nullif(btrim(reverse(split_part(reverse(coalesce(v_headers ->> 'sb-forwarded-for', '')), ',', 1))), ''),
    nullif(btrim(reverse(split_part(reverse(coalesce(v_headers ->> 'x-forwarded-for', '')), ',', 1))), ''));
  return private.normalize_ip(v_ip);
end;
$$;

revoke all on function private.normalize_ip(text) from public, anon, authenticated;
revoke all on function private.request_ip() from public, anon, authenticated;
