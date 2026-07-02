-- Extends contest_settings with all configurable bot parameters
-- so they can be managed from the dashboard instead of hardcoded

alter table contest_settings
  -- Points
  add column if not exists participation_points   int  not null default 20,
  add column if not exists points_1st             int  not null default 100,
  add column if not exists points_2nd             int  not null default 60,
  add column if not exists points_3rd             int  not null default 30,

  -- Contest timing
  add column if not exists tiebreak_duration_hours int not null default 24,
  add column if not exists warning_minutes         int not null default 5,
  add column if not exists reopen_delay_minutes    int not null default 60,

  -- Reminder
  add column if not exists reminder_day            int  not null default 1, -- 0=Sun … 6=Sat
  add column if not exists reminder_hour           int  not null default 18,
  add column if not exists reminder_message        text,

  -- Participation rules
  add column if not exists promo_interval          int  not null default 5,
  add column if not exists allow_text              bool not null default false,
  add column if not exists allow_videos            bool not null default false,
  add column if not exists delete_invalid_messages bool not null default true,
  add column if not exists delete_invalid_reactions bool not null default true;
