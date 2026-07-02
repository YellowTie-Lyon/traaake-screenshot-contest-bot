alter table contests
  add column if not exists original_ends_at timestamptz;

-- Backfill: use ends_at for existing contests (approximation)
update contests set original_ends_at = ends_at where original_ends_at is null;
