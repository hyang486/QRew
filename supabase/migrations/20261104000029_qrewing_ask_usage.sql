-- 0029 qrewing ask usage (spec planning/QREWING_AI_SPEC_EN.md 10.2). Human approval needed before the live apply.
--
-- private.qrewing_usage gains action 'ask' and a nullable user_id (no FK, no content) so the Edge Function can cap
-- asks per user per room (30) and per room (300) over 24 h. log_qrewing_usage gains an optional p_user_id; the
-- 5-argument version is dropped so named-argument RPC calls stay unambiguous (the deployed function's 5-argument
-- call still resolves through the default). Both functions: SECURITY DEFINER, search_path '', service_role only.

alter table private.qrewing_usage drop constraint qrewing_usage_action_check;
alter table private.qrewing_usage
  add constraint qrewing_usage_action_check check (action in ('triage', 'recap', 'match', 'ask'));
alter table private.qrewing_usage add column user_id uuid;
create index qrewing_usage_ask_idx on private.qrewing_usage (room_id, user_id, created_at) where action = 'ask';

drop function public.log_qrewing_usage(uuid, text, text, integer, integer);
create function public.log_qrewing_usage(
  p_room_id uuid, p_action text, p_model text, p_input_tokens integer, p_output_tokens integer, p_user_id uuid default null
) returns void
language sql security definer
set search_path = ''
as $$
  insert into private.qrewing_usage (room_id, action, model, input_tokens, output_tokens, user_id)
  values (p_room_id, p_action, p_model, coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0), p_user_id);
$$;

-- Rows of the room with this action at or after p_since; only p_user_id's rows when it is given.
create function public.qrewing_usage_count(
  p_room_id uuid, p_action text, p_since timestamptz, p_user_id uuid default null
) returns integer
language sql stable security definer
set search_path = ''
as $$
  select count(*)::integer from private.qrewing_usage
  where room_id = p_room_id and action = p_action and created_at >= p_since
    and (p_user_id is null or user_id = p_user_id);
$$;

revoke execute on function public.log_qrewing_usage(uuid, text, text, integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.log_qrewing_usage(uuid, text, text, integer, integer, uuid) to service_role;
revoke execute on function public.qrewing_usage_count(uuid, text, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.qrewing_usage_count(uuid, text, timestamptz, uuid) to service_role;
