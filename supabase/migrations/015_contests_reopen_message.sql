alter table contests
  add column if not exists reopen_message_id text;
-- Stores the "salon temporairement fermé" message ID so it can be deleted on reopen
