# Stripe Sandbox integration — implementation status

## Current status

This branch contains a server-side Stripe Sandbox Checkout and webhook implementation for one-time MYR Credits packs. It is not a production billing launch and has not been proven by a complete live Stripe Sandbox end-to-end payment run.

Implemented in code:
- `POST /api/stripe/create-checkout-session` authenticates a verified Firebase user, loads an active plan on the server, creates a pending order, and requests a one-time Stripe Checkout Session.
- Checkout is restricted to server-validated MYR order data and accepts only a returned `cs_test_` Session. The response explicitly reports `mode: "test"`.
- `POST /api/stripe/webhook` verifies the signature against the raw request body, retrieves the canonical Checkout Session from Stripe, requires `livemode === false` and `payment_status === "paid"`, and delegates the grant to the transactional ledger.
- The payment ledger uses Firestore transactions and idempotency protections for orders, payment grants, Credit spending, refunds, and dispute observations.
- `POST /api/stripe/portal` remains disabled and returns HTTP 503.
- The billing page remains a disabled product-design preview. It does not start checkout, display a verified balance, or issue Credits.

Not yet established:
- A full end-to-end run using actual Stripe Sandbox credentials, a configured Sandbox webhook endpoint, and the deployed preview environment.
- A complete automated refund/dispute webhook ingestion and operational review workflow.
- Customer Portal, subscriptions, recurring renewals, membership entitlements, and frontend balance/ledger integration.
- Production readiness, merchant approval, or any Live-mode payment capability.

## Security boundaries

- Use Stripe Sandbox/Test mode only. Never configure or use Live credentials for this branch.
- `STRIPE_SECRET_KEY` must be a server-only `sk_test_` value. `STRIPE_WEBHOOK_SECRET` must be a Sandbox webhook signing secret. Never paste either secret into chat, HTML, browser JavaScript, or Git.
- The browser must never choose the amount, currency, user ID, or Credits grant. The server derives these from the authenticated identity and active Firestore plan.
- Firestore client SDK access is denied for every document and operation by `firestore.rules`. Trusted server operations use the Firebase Admin SDK; server-side authorization must remain explicit.
- Payment orders, Credit balances, and ledger entries are server-managed. Do not add client write exceptions.
- Checkout is one-time payment only. Do not enable subscription, automatic renewal, or ongoing membership entitlements.
- A successful CI run validates automated tests; it does not prove a real Stripe Sandbox checkout/webhook round trip.

## Required server-side environment

- `STRIPE_SECRET_KEY`: Sandbox secret beginning `sk_test_`.
- `STRIPE_WEBHOOK_SECRET`: Sandbox endpoint signing secret.
- `APP_BASE_URL`: approved HTTPS KENJI preview origin.
- Firebase Admin credentials/configuration: server-side only.

Do not add secrets to source control. Keep payment feature flags and plan activation decisions separately reviewed.

## Data and event handling

- Plan price, currency, and Credits are loaded by the server from the active plan catalog.
- A pending internal order is created before a Checkout Session is returned.
- The webhook verifies the signature, retrieves the canonical Session server-to-server, and checks Sandbox mode, paid status, MYR amount/currency, and order metadata before ledger application.
- Duplicate event/order processing must not create duplicate grants.
- Refund handling uses immutable reversal entries and may require manual review if Credits have already been spent.
- Disputes are recorded for review; a dispute observation is not by itself proof of a final loss or authorization to claw back Credits.

## Validation still required before enabling broader billing

1. Run a controlled Stripe Sandbox checkout from the approved preview origin.
2. Confirm the signed webhook reaches the preview endpoint and canonical Session retrieval succeeds.
3. Verify exactly one pending order, one paid transition, one grant, and the expected materialized balance.
4. Replay the same event and verify no second grant is created.
5. Test cancellation, expiry, mismatched amount/currency, invalid signature, and transient webhook retry behavior.
6. Separately validate refund and dispute workflows, including insufficient-balance/manual-review cases.
7. Review account country, legal business details, tax obligations, and merchant eligibility before any future Live-mode proposal.

## Branch and deployment boundary

- Work only on `feature/stripe-sandbox-integration-preview`.
- Review through PR #13 into `feature/kenji-ai-workspace-foundation`.
- Keep PR #13 Draft until explicitly approved.
- Keep ToyyibPay PR #12 separate.
- Do not merge, deploy production, modify `main`, or enable Live payments without explicit approval.
- Do not modify Cardora or Pokémon Treasure projects.
