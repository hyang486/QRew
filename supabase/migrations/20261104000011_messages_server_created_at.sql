-- Checkpoint 4 (chat), review finding F7: messages.created_at must be server time.
-- The insert policy did not constrain created_at, so a member could insert a far-future
-- timestamp (pinning a message as newest forever) or backdate one, which also breaks
-- the created_at paging order. A BEFORE INSERT trigger overwrites any client value.

create or replace function private.set_created_at_now()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := now();
  return new;
end;
$$;

revoke all on function private.set_created_at_now() from public, anon, authenticated;

create trigger messages_set_created_at before insert on public.messages
  for each row execute function private.set_created_at_now();
