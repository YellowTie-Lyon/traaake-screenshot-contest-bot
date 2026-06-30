alter table contests
  add column if not exists opening_message_id text,
  add column if not exists rules_message_id text;
