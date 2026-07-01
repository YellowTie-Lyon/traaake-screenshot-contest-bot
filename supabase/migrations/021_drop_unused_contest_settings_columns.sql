-- ============================================================
-- contest_settings: drop all columns unused by the bot
-- ============================================================

alter table contest_settings
  -- Replaced by node-cron schedules hardcoded in Paris timezone
  drop column if exists open_day,
  drop column if exists open_time,
  drop column if exists close_day,
  drop column if exists close_time,
  drop column if exists timezone,
  drop column if exists reminder_day,
  drop column if exists reminder_hour,
  drop column if exists reminder_minutes_before_end,
  -- Replaced by promo_after_3_sent flag + daily cron
  drop column if exists promo_interval,
  -- Bot hardcodes ❤️ as vote emoji
  drop column if exists allowed_reaction,
  -- Auto-mode is always on; no toggle in code
  drop column if exists auto_mode_enabled,
  -- Bot enforces 1 entry per user in code, not via this column
  drop column if exists max_entries_per_user,
  -- Duplicate of allow_videos (bot reads allow_videos)
  drop column if exists allow_video,
  -- Bot reads points_1st/2nd/3rd and participation_points instead
  drop column if exists top_3_points,
  drop column if exists winner_points,
  -- Removed with testModeTickClose dead code
  drop column if exists warning_minutes,
  drop column if exists reminder_message,
  -- Never read in code
  drop column if exists delete_invalid_reactions,
  drop column if exists announcement_message,
  -- Duplicated in discord_guild_configs; bot reads from there
  drop column if exists guild_id,
  drop column if exists contest_channel_id,
  drop column if exists admin_role_id;

-- ============================================================
-- contests: drop columns unused by the bot
-- ============================================================

alter table contests
  -- Bot uses opening_message_id instead
  drop column if exists discord_announcement_message_id,
  -- Only set in removed testModeTickClose, never read in production
  drop column if exists reminder_sent,
  -- Never read or written by the bot
  drop column if exists total_participations,
  drop column if exists total_votes;
