-- Optional homeowner-supplied bed/bath/sqft corrections, carried alongside
-- a purchase so a cache hit or "Refresh data" can reapply the same
-- overrides without the browser having to resend them. Nullable: most
-- purchases won't set these, since public records are usually good enough.
alter table property_fingerprint_purchases
  add column if not exists override_bedrooms integer,
  add column if not exists override_bathrooms numeric,
  add column if not exists override_square_footage integer;
