-- Remove columns no longer used by the bot
-- reminder_day/reminder_hour: replaced by node-cron schedules with Paris timezone
-- promo_interval: replaced by promo_after_3_sent flag + daily cron
-- delete_invalid_reactions: never referenced in code
-- reminder_minutes_before_end: replaced by the Wednesday 17h48 cron
-- warning_minutes/reminder_message: only referenced in removed testModeTickClose, not in production path

alter table contest_settings
  drop column if exists reminder_day,
  drop column if exists reminder_hour,
  drop column if exists reminder_message,
  drop column if exists promo_interval,
  drop column if exists delete_invalid_reactions,
  drop column if exists reminder_minutes_before_end;
