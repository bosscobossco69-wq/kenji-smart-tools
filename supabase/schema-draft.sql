-- KENJI AI Workspace database schema DRAFT.
-- NOT APPLIED to any Supabase project.
-- Review and run only on a new, dedicated KENJI Workspace project.
-- Do not apply to Cardora or Pokémon Treasure.
--
-- Design rules:
-- * All monetary values are integer MYR sen; no floating-point amounts.
-- * Prices/Credit allocations are server-owned, never client supplied.
-- * Orders and ledger are read-only to end users.
-- * Payment provider secrets and callback payloads are server-only.
-- * No balance column: available Credits are SUM(ledger.delta_credits).

begin;

create table if not exists public.workspace_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_products (
  id text primary key,
  product_type text not null check (product_type in ('subscription', 'credit_pack')),
  display_name text not null,
  currency char(3) not null default 'MYR' check (currency = 'MYR'),
  amount_sen integer not null check (amount_sen > 0),
  credits_granted integer not null default 0 check (credits_granted >= 0),
  billing_interval text check (billing_interval in ('month', 'year')),
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_product_interval_check check (
    (product_type = 'subscription' and billing_interval is not null)
    or (product_type = 'credit_pack' and billing_interval is null)
  )
);

create table if not exists public.payment_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  product_id text not null references public.billing_products(id) on delete restrict,
  provider text not null default 'toyyibpay' check (provider = 'toyyibpay'),
  provider_bill_code text unique,
  external_reference text not null unique,
  provider_transaction_ref text unique,
  currency char(3) not null default 'MYR' check (currency = 'MYR'),
  expected_amount_sen integer not null check (expected_amount_sen > 0),
  credits_expected integer not null check (credits_expected >= 0),
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'failed', 'cancelled', 'expired', 'review')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_orders_user_created_idx
  on public.payment_orders (user_id, created_at desc);
create index if not exists payment_orders_status_created_idx
  on public.payment_orders (status, created_at);

create table if not exists public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  order_id uuid references public.payment_orders(id) on delete restrict,
  delta_credits bigint not null check (delta_credits <> 0),
  entry_type text not null check (
    entry_type in ('purchase', 'subscription_grant', 'usage', 'refund', 'adjustment', 'expiry')
  ),
  idempotency_key text not null unique,
  description text,
  created_at timestamptz not null default now(),
  constraint credit_ledger_order_type_check check (
    (entry_type in ('purchase', 'subscription_grant', 'refund') and order_id is not null)
    or entry_type in ('usage', 'adjustment', 'expiry')
  )
);

create index if not exists credit_ledger_user_created_idx
  on public.credit_ledger (user_id, created_at desc);
create unique index if not exists credit_ledger_one_purchase_per_order_idx
  on public.credit_ledger (order_id)
  where order_id is not null and entry_type in ('purchase', 'subscription_grant');

create table if not exists public.workspace_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  product_id text not null references public.billing_products(id) on delete restrict,
  latest_order_id uuid references public.payment_orders(id) on delete restrict,
  status text not null check (status in ('pending', 'active', 'past_due', 'cancelled', 'expired')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workspace_subscriptions_user_status_idx
  on public.workspace_subscriptions (user_id, status);

-- RLS is enabled on every table in the exposed public schema.
alter table public.workspace_profiles enable row level security;
alter table public.billing_products enable row level security;
alter table public.payment_orders enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.workspace_subscriptions enable row level security;

-- Profiles: users can read and update only their own profile.
drop policy if exists "workspace_profiles_select_own" on public.workspace_profiles;
create policy "workspace_profiles_select_own"
  on public.workspace_profiles for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "workspace_profiles_insert_own" on public.workspace_profiles;
create policy "workspace_profiles_insert_own"
  on public.workspace_profiles for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "workspace_profiles_update_own" on public.workspace_profiles;
create policy "workspace_profiles_update_own"
  on public.workspace_profiles for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Active product catalog can be read; only trusted server/admin may modify it.
drop policy if exists "billing_products_read_active" on public.billing_products;
create policy "billing_products_read_active"
  on public.billing_products for select to authenticated
  using (active = true);

-- Users can inspect their own orders, but cannot create/update payment status.
drop policy if exists "payment_orders_select_own" on public.payment_orders;
create policy "payment_orders_select_own"
  on public.payment_orders for select to authenticated
  using ((select auth.uid()) = user_id);

-- Users can inspect their own Credit history, but cannot write ledger entries.
drop policy if exists "credit_ledger_select_own" on public.credit_ledger;
create policy "credit_ledger_select_own"
  on public.credit_ledger for select to authenticated
  using ((select auth.uid()) = user_id);

-- Users can inspect their own subscriptions; no client-side status changes.
drop policy if exists "workspace_subscriptions_select_own" on public.workspace_subscriptions;
create policy "workspace_subscriptions_select_own"
  on public.workspace_subscriptions for select to authenticated
  using ((select auth.uid()) = user_id);

commit;

-- IMPORTANT IMPLEMENTATION NOTES:
-- 1. This draft intentionally does not GRANT Data API access. Supabase's 2026
--    change means new public tables are not automatically exposed by default.
--    Add only the minimum grants after reviewing Data API settings.
-- 2. Do not grant INSERT/UPDATE/DELETE on payment_orders or credit_ledger to
--    anon/authenticated. A trusted server-side service handles these writes.
-- 3. Service role/secret key must never be sent to a browser.
-- 4. The callback handler must verify ToyyibPay's callback hash, then call
--    Get Bill Transactions, match bill code + external_reference + exact
--    amount + successful status, and atomically insert a unique ledger row.
-- 5. Available balance is SUM(delta_credits) per user; never trust a balance
--    supplied by the browser.
-- 6. Product prices and credits_granted must be seeded only after commercial
--    pricing/currency decisions are approved. Existing UI shows provisional USD
--    pricing, while ToyyibPay settlement is MYR; do not silently convert.
-- 7. Subscription renewal/expiry and usage deduction require separate,
--    idempotent server-side workflows before subscriptions are sold.
