-- Adds bot connection fields to the environments table.
-- Run this once in the Supabase SQL editor (or via supabase db push).

alter table environments
  add column if not exists discord_bot_token  text,
  add column if not exists discord_app_id     text,
  add column if not exists is_active          boolean not null default false;

-- Only one environment should be active at a time.
-- This partial unique index enforces it at DB level.
create unique index if not exists environments_one_active
  on environments (is_active)
  where is_active = true;

comment on column environments.discord_bot_token is
  'Discord bot token for this environment. Read by the VPS bot process at startup and on activation. Never exposed to the frontend.';

comment on column environments.discord_app_id is
  'Discord application (client) ID. Used to register slash commands on the correct app.';

comment on column environments.is_active is
  'When true, the bot process for this environment connects to Discord. Toggled by the dashboard.';
