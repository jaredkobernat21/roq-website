create table market_preview_requests (
  id uuid primary key default gen_random_uuid(),
  market text,
  property_types text[] not null default '{}',
  strategy text,
  price_range text,
  most_valuable_info text,
  first_name text,
  email text,
  phone text,
  created_at timestamptz not null default now()
);

alter table market_preview_requests enable row level security;
-- No policies added -- same convention as market_ready_requests and
-- home_potential_interest. Only the service-role key (used inside the
-- Edge Function) can read or write this table.
