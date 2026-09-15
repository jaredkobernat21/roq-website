create table project_potential_requests (
  id uuid primary key default gen_random_uuid(),
  address text,
  project_type text,
  contact text,
  contact_method text,
  created_at timestamptz not null default now()
);

alter table project_potential_requests enable row level security;
-- No policies added -- same convention as groundbreakable_requests and the
-- other intake tables. Only the service-role key (used inside the Edge
-- Function) can read or write this table.
