-- Checkpoint 4 (chat): a text message must carry a non-blank body.
-- The core schema only capped the length, so a client could insert a text row with a null or blank body.
-- Other kinds (media, system, arrival, emergency, status) keep their own rules.

alter table public.messages
  add constraint messages_text_body_present
  check (kind <> 'text' or (body is not null and char_length(btrim(body)) > 0));
