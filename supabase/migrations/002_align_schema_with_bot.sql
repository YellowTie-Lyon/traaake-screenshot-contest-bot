-- Aligns the database schema with the bot's expectations.

-- participants: ensure unique constraint on discord_user_id
alter table participants
  add column if not exists discord_username      text,
  add column if not exists discord_display_name  text,
  add column if not exists avatar_url            text,
  add column if not exists updated_at            timestamptz default now();

-- Drop old columns if they were named differently
alter table participants
  drop column if exists username,
  drop column if exists display_name;

-- Unique constraint so upsert works on discord_user_id
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'participants_discord_user_id_key'
  ) then
    alter table participants add constraint participants_discord_user_id_key unique (discord_user_id);
  end if;
end $$;

-- participations: add message_id for vote tracking
alter table participations
  add column if not exists message_id   text,
  add column if not exists submitted_at timestamptz default now();

-- points_ledger: add contest_id reference
alter table points_ledger
  add column if not exists contest_id uuid references contests(id);

-- seasons: make sure is_active exists (not status)
alter table seasons
  add column if not exists is_active boolean not null default false;

alter table seasons
  drop column if exists status;
