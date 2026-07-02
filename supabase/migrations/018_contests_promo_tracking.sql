alter table contests
  add column if not exists promo_after_3_sent  boolean not null default false,
  add column if not exists promo_last_sent_date text; -- 'YYYY-MM-DD', tracks daily promo
