alter table discord_guild_configs
  add column if not exists log_channel_id text;
