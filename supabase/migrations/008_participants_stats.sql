alter table participants
  add column if not exists win_count            integer not null default 0,
  add column if not exists participation_count  integer not null default 0;
