create table groundbreakable_requests (
  id uuid primary key default gen_random_uuid(),
  location text,
  build_type text,
  build_type_other text,
  stage text,
  unsure_about text[] not null default '{}',
  name text,
  email text,
  phone text,
  created_at timestamptz not null default now()
);

alter table groundbreakable_requests enable row level security;
-- No policies added -- same convention as market_preview_requests and the
-- other intake tables. Only the service-role key (used inside the Edge
-- Function) can read or write this table.
