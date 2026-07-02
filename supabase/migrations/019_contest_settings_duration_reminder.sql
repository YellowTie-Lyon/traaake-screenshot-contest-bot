alter table contest_settings
  add column if not exists contest_duration_minutes  integer,       -- null = next Wednesday 18h
  add column if not exists reminder_minutes_before_end integer default 60; -- minutes before end to send reminder
