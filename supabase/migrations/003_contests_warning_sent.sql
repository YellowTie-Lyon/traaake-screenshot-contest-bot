alter table contests
  add column if not exists warning_sent boolean not null default false,
  add column if not exists winner_discord_user_id text;
