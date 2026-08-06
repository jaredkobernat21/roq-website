create table property_fingerprint_reports (
  id uuid primary key default gen_random_uuid(),
  address_input text not null,
  address_formatted text,
  apn text,
  raw_sources jsonb not null default '{}',
  report jsonb,
  fetched_at timestamptz,
  created_at timestamptz not null default now()
);

create index property_fingerprint_reports_address_idx
  on property_fingerprint_reports (lower(address_formatted));

alter table property_fingerprint_reports enable row level security;
-- No policies added -- same convention as market_ready_requests and
-- home_potential_interest. Only the service-role key (used inside the
-- Edge Function) can read or write this table.
