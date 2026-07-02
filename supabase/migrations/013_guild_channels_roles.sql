-- Stores available Discord channels and roles per guild
-- Populated by the bot every 5 minutes via syncGuilds
-- Used by the dashboard to display dropdowns instead of raw ID fields

create table if not exists guild_channels (
  guild_id     text not null,
  channel_id   text not null,
  channel_name text not null,
  channel_type text not null default 'text', -- 'text', 'announcement', 'voice', etc.
  updated_at   timestamptz not null default now(),
  primary key (guild_id, channel_id)
);

create table if not exists guild_roles (
  guild_id   text not null,
  role_id    text not null,
  role_name  text not null,
  role_color int  not null default 0,
  position   int  not null default 0,
  updated_at timestamptz not null default now(),
  primary key (guild_id, role_id)
);
