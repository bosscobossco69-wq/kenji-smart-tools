# KENJI AI Workspace — payment ledger design

## Decision status

**Design prepared; database provider is not provisioned.** Do not set `PAYMENT_LEDGER_READY=true` and do not enable checkout.

The project currently has Firebase Authentication scaffolding, but this does not mean Firestore is provisioned or that a durable payment ledger exists. Do not assume a Firebase project/database is available. Do not reuse the Pokémon Treasure / Cardora Supabase projects.

Before implementation, provision a dedicated KENJI Workspace database with backups, server-only credentials, access controls, and a tested restore path. The provider choice must be confirmed before writing provider-specific migrations.

## Required logical records

### plans
- `id` (stable server-side plan key)
- `name`
- `currency` (MYR)
- `unit_amount_minor` (integer sen; never floating point)
- `billing_interval` (month or year; null for one-time)
- `credits_grant` (non-negative integer)
- `active`
- `created_at`, `updated_at`

Browser requests may send only a plan key. Price, currency, interval, and Credits are always loaded from this server-side catalog.

### payment_customers
- `user_id` (unique authenticated Firebase UID)
- `provider` (stripe)
- `provider_customer_id` (unique per provider)
- `created_at`, `updated_at`

Never accept a customer ID from the browser as proof of ownership.

### payment_orders
- `id` (unguessable internal order ID)
- `user_id`
- `plan_id`
- `provider`
- `provider_checkout_session_id` (unique when present)
- `provider_payment_intent_id` (unique when present)
- `expected_amount_minor`
- `currency`
- `status` (pending, paid, failed, expired, refunded, disputed)
- `idempotency_key` (unique)
- `created_at`, `updated_at`, `paid_at`

Create the pending order before requesting a provider Checkout Session. The server owns the amount and currency.

### subscriptions
- `user_id`
- `provider_subscription_id` (unique)
- `provider_customer_id`
- `plan_id`
- `status` (incomplete, trialing, active, past_due, canceled, unpaid)
- `current_period_start`, `current_period_end`
- `cancel_at_period_end`
- `created_at`, `updated_at`

### payment_events
- `provider_event_id` (unique)
- `event_type`
- `payload_digest` (store a digest / minimal necessary metadata, not card data)
- `processing_status` (received, processed, ignored, failed)
- `received_at`, `processed_at`

A duplicate provider event must not create a second entitlement or Credit grant.

### credit_ledger
- `id`
- `user_id`
- `order_id` or `subscription_id`
- `source_event_id` (unique for each grant/reversal)
- `entry_type` (grant, spend, refund_reversal, adjustment)
- `amount` (signed integer)
- `created_at`

Append-only. Never update a previous ledger row to rewrite history. Enforce unique source event and update the user's materialized balance in the same database transaction.

### entitlements
- `user_id`
- `plan_id`
- `status`
- `starts_at`, `ends_at`
- `source_order_id` or `source_subscription_id`
- `updated_at`

Entitlements are granted only after server-to-server verified payment / signed webhook reconciliation and a successful atomic ledger transaction.

## Webhook processing contract

1. Read the exact raw HTTP request body.
2. Verify Stripe signature with the endpoint-specific test webhook secret.
3. Insert `provider_event_id` under a unique constraint; safely return success for an already-processed duplicate.
4. Retrieve the associated order/subscription from the database, never from browser parameters.
5. Verify provider object ID, expected amount, currency, customer, metadata order ID, and paid status.
6. In one database transaction, update order/subscription state, append the unique Credit ledger entry, and update entitlement.
7. Record processing outcome. Retry transient database failures; do not grant access on partial failure.
8. Process refunds, disputes, cancellation, failed renewals, and late events as explicit compensating state transitions.

Never trust a redirect to a success page as payment proof. Never use a screenshot as payment proof.

## Required security boundaries

- Firebase ID token must be verified server-side using Firebase Admin before any user-scoped payment operation.
- All provider secret keys and database credentials stay in Vercel server-side environment variables.
- Do not expose service-role/database credentials in browser code.
- Enforce per-user ownership checks for orders, subscriptions, and Customer Portal sessions.
- Use integer minor currency units (MYR sen), not floating-point arithmetic.
- Use idempotency keys for Checkout creation and unique constraints for provider events and ledger grants.
- Do not store card numbers, CVC, or raw payment credentials.

## Provisioning checklist

- [ ] Confirm the dedicated KENJI database provider and project.
- [ ] Create isolated development/test database; do not reuse other projects.
- [ ] Apply provider-specific migrations and access policies.
- [ ] Configure server-only database credentials in Vercel Preview.
- [ ] Verify Firebase UID mapping and database access rules.
- [ ] Run duplicate-webhook and concurrent-grant tests.
- [ ] Run backup/restore test.
- [ ] Only then set `PAYMENT_LEDGER_READY=true` in Preview.

## Stripe account eligibility note

The onboarding screenshot showed the business location selector set to United States. Keep this account in Sandbox while testing. Before enabling Live payments, the Stripe account country, legal identity, business details, and settlement bank must accurately reflect the merchant's real eligibility. Do not use a false country or address to bypass eligibility checks.
