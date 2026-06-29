create table if not exists contest_bans (
  id uuid primary key default gen_random_uuid(),
  environment_id uuid references environments(id) on delete cascade,
  discord_user_id text not null,
  discord_username text,
  reason text,
  banned_by text not null,
  banned_at timestamptz not null default now(),
  expires_at timestamptz null
);

create index if not exists contest_bans_lookup
  on contest_bans (environment_id, discord_user_id);
