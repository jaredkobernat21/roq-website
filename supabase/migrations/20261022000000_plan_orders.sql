-- Paid plan orders (Home Value Potential first; Renovation Plan later).
-- roq-plan-checkout saves the intake answers here as a pending order before
-- sending the customer to Stripe; roq-plan-webhook marks it paid when
-- Stripe confirms checkout.session.completed. A pending row with no paid_at
-- is an abandoned checkout, which still leaves the answers on record.
create table plan_orders (
  id uuid primary key default gen_random_uuid(),
  plan text not null,
  status text not null default 'pending' check (status in ('pending', 'paid')),
  address text,
  email text,
  summary text,
  intake jsonb,
  stripe_session_id text unique,
  stripe_payment_intent_id text,
  amount_cents integer,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

alter table plan_orders enable row level security;
-- No policies added -- same convention as the other intake tables. Only the
-- service-role key (used inside the Edge Functions) can read or write it.
