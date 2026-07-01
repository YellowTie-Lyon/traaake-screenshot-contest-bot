alter table discord_guild_configs
  add column if not exists ai_alert_channel_id text;
