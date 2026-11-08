# Stripe Sandbox integration — safe preparation

## Current status

This branch prepares the Stripe test-mode integration only. It does not enable checkout, create subscriptions, activate memberships, or issue Credits.

The Stripe Dashboard account currently shown in the user's screenshots is in Sandbox/Test mode. The earlier onboarding screen showed the business location as United States; before any Live activation, confirm that the actual Stripe account country and legal business details accurately match the merchant's real eligibility. Do not use false country, address, entity, or tax details.

## Required environment variables (Vercel server-side only)

- `STRIPE_SECRET_KEY` — test secret key beginning `sk_test_`; never expose to browser or commit to Git.
- `STRIPE_PUBLISHABLE_KEY` — test publishable key beginning `pk_test_`; safe for browser only if/when needed.
- `STRIPE_WEBHOOK_SECRET` — test webhook signing secret, created only after registering the test endpoint.
- `STRIPE_CHECKOUT_ENABLED` — keep unset or `false` until the dedicated order/entitlement ledger and payment verification are implemented.
- `PAYMENT_LEDGER_READY` — keep unset or `false` until the dedicated KENJI Workspace database and atomic ledger are verified.

Do not paste any secret into chat, source code, HTML, client-side JavaScript, or GitHub. Never mix test keys with live endpoints or live webhook secrets.

## Planned server routes

- `POST /api/stripe/create-checkout-session` — create a Checkout Session only after authenticated user identity, server-side plan pricing, pending-order persistence, and idempotency are implemented.
- `POST /api/stripe/webhook` — verify Stripe's signature using the raw request body and `STRIPE_WEBHOOK_SECRET`; reconcile the event with a pending order; atomically post a single entitlement/Credit ledger event.
- `POST /api/stripe/portal` — create a customer portal session only for the authenticated owner of the Stripe customer record.

Until those prerequisites exist, routes must fail closed with HTTP 503 and must not call Stripe or grant access.

## Blocking prerequisites

1. Provision a dedicated KENJI AI Workspace database. Do not reuse Cardora or Pokémon Treasure Supabase projects.
2. Implement authenticated user-to-customer mapping and server-side plan catalog/pricing in MYR.
3. Add pending orders with unique internal IDs, Stripe Checkout Session IDs, expected amount/currency, user ID, plan ID, status, and timestamps.
4. Add an append-only entitlement/Credit ledger with unique payment/event constraints and atomic writes.
5. Verify webhook signatures and reconcile paid status, amount, currency, customer, and order reference before activation.
6. Handle duplicate events, delayed events, refunds, disputes, cancellations, failed renewals, and subscription lifecycle changes.
7. Test success, decline, expired Checkout Session, forged webhook, duplicate webhook, amount/currency mismatch, unknown order, refund, and renewal failure.
8. Only after Sandbox tests and Stripe merchant approval, separately configure Live credentials and complete a reviewed Live activation.

## Current deployment boundary

- Work on `feature/stripe-sandbox-integration-preview`.
- Open a review PR into `feature/kenji-ai-workspace-foundation`; do not merge without explicit user approval.
- Keep the existing ToyyibPay PR #12 separate.
- Do not enable live payments or modify `main`.
