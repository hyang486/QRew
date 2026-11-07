-- Emergency acknowledgements must reach other room members live.
-- RLS (emergency_acks_select: member of the event's room) limits who receives INSERT/UPDATE events.
-- DELETE events carry only the primary key and skip RLS, so clients must never read content from them.
alter publication supabase_realtime add table public.emergency_acks;
