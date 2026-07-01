alter table contests
  add column if not exists countdown_sent integer not null default 0;
-- 0 = nothing sent, 1 = "3 min" sent, 2 = "2 min" sent, 3 = "1 min" sent
