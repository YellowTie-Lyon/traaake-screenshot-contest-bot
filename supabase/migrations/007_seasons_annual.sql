-- Rename existing active season to its calendar year
update seasons
set
  name       = extract(year from starts_at)::text,
  starts_at  = date_trunc('year', starts_at),
  ends_at    = (date_trunc('year', starts_at) + interval '1 year - 1 second')
where is_active = true;
