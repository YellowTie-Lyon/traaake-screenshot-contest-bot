-- ============================================================
-- RLS: enable on all tables, allow only service role
-- The bot uses the service role key which bypasses RLS,
-- so these policies block all anonymous / authenticated access
-- from the Supabase client-side dashboard or leaked keys.
-- ============================================================

alter table environments             enable row level security;
alter table discord_guild_configs    enable row level security;
alter table contest_settings         enable row level security;
alter table contests                 enable row level security;
alter table participants             enable row level security;
alter table participations           enable row level security;
alter table seasons                  enable row level security;
alter table contest_bans             enable row level security;
alter table bot_logs                 enable row level security;
alter table bot_commands             enable row level security;

-- No policies = no access for anon/authenticated roles.
-- Service role bypasses RLS entirely (Supabase behaviour).

-- ============================================================
-- Indexes on hot query paths
-- ============================================================

-- Contests: most queries filter by environment_id + status
create index if not exists idx_contests_env_status
  on contests (environment_id, status);

-- Contests: cron close check queries ends_at on open/tiebreak contests
create index if not exists idx_contests_ends_at
  on contests (ends_at)
  where status in ('active', 'tiebreak');

-- Participations: vote reaction handler hits (message_id, contest_id)
create index if not exists idx_participations_message_contest
  on participations (message_id, contest_id);

-- Participations: duplicate submission check and ranking
create index if not exists idx_participations_contest_participant
  on participations (contest_id, participant_id);

-- Participations: leaderboard sort by votes
create index if not exists idx_participations_vote_count
  on participations (contest_id, vote_count desc);

-- Participants: looked up by discord_user_id on every submission
create index if not exists idx_participants_discord_user_id
  on participants (discord_user_id);

-- Contest bans: checked on every message submission
create index if not exists idx_contest_bans_env_user
  on contest_bans (environment_id, discord_user_id);

-- Bot logs: queried by environment_id for audit
create index if not exists idx_bot_logs_env_created
  on bot_logs (environment_id, created_at desc);

-- Discord guild configs: looked up by guild_id on every event
create index if not exists idx_discord_guild_configs_guild_id
  on discord_guild_configs (guild_id);
