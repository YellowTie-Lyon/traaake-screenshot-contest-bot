alter table contests
  add column if not exists tiebreak_participants text;
-- Stores comma-separated discord_user_ids of currently tied participants
-- Used to detect changes and update the tiebreak message accordingly
