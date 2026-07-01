alter table contests
  add column if not exists reminder_sent boolean not null default false;
