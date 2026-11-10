# Payment order state machine and implementation status

## Scope

This document describes the current Stripe Sandbox one-time MYR Credits-pack implementation and the safety requirements around it. It does not declare the billing system production-ready. A complete Stripe Sandbox end-to-end run against the preview deployment is still required.

## Current implementation

- Checkout authenticates a verified Firebase user and creates a pending order from a server-side active plan.
- Checkout creates a one-time Stripe Session and accepts only a `cs_test_` Session ID and HTTPS URL.
- The webhook verifies the raw-body signature, retrieves the canonical Stripe Session, requires Sandbox mode and paid status, checks MYR and order metadata, then applies the payment through the ledger.
- Ledger operations use Firestore transactions and idempotency controls for order creation, Checkout Session attachment, payment grants, Credit spending, refunds, and dispute observations.
- Stripe Customer Portal remains disabled (HTTP 503).
- The billing page remains a disabled preview and is not connected to Checkout or the Credit balance.
- Subscription lifecycle, automatic renewal, membership entitlements, and full refund/dispute webhook operations are not enabled.

## Canonical order states

- `pending`: internal order persisted; payment not yet verified.
- `paid`: canonical Stripe payment was retrieved and reconciled, and the ledger transaction committed.
- `failed`: a terminal payment failure was confirmed from canonical provider evidence.
- `expired`: the Checkout Session was canonically confirmed expired without successful payment.
- `review_required`: conflicting, late, or incomplete evidence requires manual investigation. This state must never grant Credits by itself.

A browser redirect, client callback, unsigned webhook, or client-supplied amount is never sufficient evidence for a state transition.

## Allowed transitions

| From | To | Required evidence |
|---|---|---|
| pending | paid | Verified webhook signature; canonical Stripe Session retrieval; exact order, owner, Sandbox mode, amount, and currency match; atomic ledger commit |
| pending | failed | Canonical provider evidence confirms terminal failure and no successful payment |
| pending | expired | Canonical Stripe Session confirms expiry and no successful payment |
| pending | review_required | Conflicting or incomplete provider evidence |
| failed | review_required | Later conflicting success or provider correction |
| expired | review_required | Late success or conflicting provider event |
| review_required | paid | Human-reviewed canonical evidence, followed by full deterministic verification and atomic ledger transaction |
| review_required | failed/expired | Human-reviewed canonical evidence and audited transition |

A paid order must never be downgraded by a later failure or expiry event. Refunds and disputes are separate financial adjustments; they must not rewrite the original payment event.

## Checkout and webhook invariants

- Derive the user from verified server-side authentication.
- Derive plan amount, currency, and Credits from the server-side plan catalog.
- Use a stable internal order ID and deterministic Stripe idempotency key.
- Persist the returned Checkout Session ID against the matching owner/order before returning the checkout URL.
- Verify the exact raw webhook body before parsing or acting on the event.
- Retrieve canonical Stripe objects server-to-server. Do not trust webhook metadata or amount fields alone.
- Require `livemode === false`, a `cs_test_` Session, paid status, MYR, and exact order reconciliation before granting Credits.
- Duplicate or concurrent event deliveries must converge on one order state and one grant.
- Unknown event types must never grant Credits.

## Credit ledger rules

- A successful one-time payment creates exactly one immutable grant per internal order/payment.
- Credit spending is atomic, idempotent, and must reject insufficient balance.
- Refunds must use separate immutable reversal entries referencing the original grant and canonical refund identity.
- Partial refunds require an explicit proportional-reversal policy and must never reverse more Credits than were granted.
- If Credits have already been spent and a reversal would overdraw the balance, require manual review; do not create a negative balance.
- Disputes are observations requiring review, not automatic proof of a final loss.

## Firestore client access

All browser/client SDK reads and writes are denied by `firestore.rules`. This includes user documents, payment orders, Credit balances, and the Credit ledger. Trusted server code uses Firebase Admin SDK with server-side authorization. Do not introduce per-user client read exceptions for payment or account data.

## Tests and release gates

Automated CI covers unit tests and Firestore Emulator ledger integration tests. A passing CI run is not equivalent to a real Stripe Sandbox end-to-end test.

Before enabling broader billing, verify:
1. Successful Sandbox Checkout from the approved preview origin.
2. Signed webhook delivery and canonical Session retrieval.
3. Exactly one order transition and one Credit grant.
4. Duplicate/replayed webhook does not grant twice.
5. Invalid signature, wrong mode, amount/currency mismatch, cancellation, expiry, and transient retry cases.
6. Refund and dispute handling, including spent Credits and manual-review cases.
7. Frontend balance/ledger integration with server-authorized APIs.

Subscriptions, automatic renewals, Customer Portal, Live mode, and production deployment remain out of scope.
