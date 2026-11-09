# Payment order state machine and retry policy

## Scope and status

Design contract for the first Stripe Sandbox billing release. This document does not enable Checkout or process webhook events. The current Checkout endpoint remains fail-closed (HTTP 503), and the current webhook verifies signatures then returns HTTP 503.

The first release should support one-time Credit packs only. Monthly/yearly subscriptions require a separate subscription lifecycle design and are out of scope for the first release.

## Canonical order states

- `pending`: internal order persisted; payment not yet verified.
- `paid`: canonical Stripe payment was retrieved and reconciled, and the ledger transaction committed.
- `failed`: a terminal payment failure was confirmed from the canonical Stripe object and safely reconciled.
- `expired`: the Checkout Session reached its canonical expiry without a successful payment, verified against Stripe.
- `review_required`: conflicting, late, or incomplete evidence needs manual investigation. This state must never grant Credits.

Do not treat a browser redirect, client callback, model score, or unsigned webhook as a state transition.

## Allowed transitions

| From | To | Required evidence |
|---|---|---|
| pending | paid | Verified webhook signature; canonical Stripe Session/PaymentIntent retrieval; exact order, owner, mode, amount and currency match; atomic ledger commit |
| pending | failed | Canonical Stripe payment object confirms terminal failure; no successful payment exists |
| pending | expired | Canonical Stripe Checkout Session is expired and canonical retrieval confirms no successful payment |
| pending | review_required | Contradictory or incomplete provider evidence |
| failed | review_required | A later conflicting success or provider correction is received |
| expired | review_required | A late success or conflicting provider event is received |
| review_required | paid | Human-reviewed canonical evidence, followed by the same full deterministic verification and atomic ledger transaction |
| review_required | failed/expired | Human-reviewed canonical evidence and audited transition |

Terminal `paid` must not be downgraded by a later failure or expiry event. A refund or dispute is a separate financial adjustment and ledger reversal workflow; it must not rewrite the original payment event.

No other transition is allowed. In particular, do not transition `failed` or `expired` directly to `paid` based only on a delayed event. Route it to `review_required` and reconcile the canonical Stripe object first.

## Checkout expiry

- Use Stripe's canonical Checkout Session `expires_at` as the source of truth.
- Do not invent or hardcode an independent local expiry that conflicts with the Session.
- Persist the requested expiry and Stripe's returned `expires_at` when Checkout is implemented.
- A local scheduled job may identify candidates, but it must retrieve the canonical Session before marking an order expired.
- If Stripe is unavailable, leave the order pending and retry later; do not guess expiry.
- If payment succeeded before expiry but the event arrived late, reconcile the canonical payment object and route conflicting state to review rather than discarding a real payment.

## Idempotency and retries

- One client idempotency key maps to one internal order and one immutable request fingerprint.
- Reusing the key with changed plan, amount, currency, or Credits is rejected.
- A retry with the same key returns the same order; it must not create another order or a second Checkout Session.
- A new payment attempt after a terminal failed/expired order must use a new client idempotency key and create a new internal order. The old order and events remain auditable.
- The Checkout creation operation must have its own deterministic Stripe idempotency key derived from the internal order ID and operation version.
- Persist the Stripe Session ID before returning its URL. If the process crashes after Stripe creates a Session but before persistence, retry with the same Stripe idempotency key and reconcile the returned Session before proceeding.
- Never create a replacement Session merely because the browser retries or the client times out.

## Webhook ordering and replay

- Verify signature against the exact raw body first.
- Persist an event receipt with unique Stripe event ID and payload fingerprint.
- Retrieve the canonical Stripe object server-to-server; do not trust amount, currency, customer, payment status, or metadata solely from the webhook JSON.
- Make event handling idempotent and safe under concurrent delivery.
- A duplicate event ID with a different fingerprint is an integrity incident.
- Different events describing the same order must converge on one canonical order state and one Credit grant.
- A failure event arriving after paid must be recorded for audit but must not downgrade paid state.
- Unknown event types should be acknowledged only after safe receipt persistence and otherwise ignored; they must never grant Credits.

## Credit ledger rules

- A successful one-time payment creates exactly one immutable grant entry per internal order/payment.
- Use a unique deterministic ledger key tied to the internal order/payment identity, not merely a webhook delivery attempt.
- Do not edit or delete a grant to implement a refund. Add a separate immutable reversal entry referencing the original grant and canonical Stripe Refund ID.
- Partial refunds require an explicit proportional-reversal policy and must not reverse more Credits than were granted or silently claw back already-spent Credits.
- Disputes require a separate hold/review policy; do not automatically make a permanent ban or assume a dispute is a final loss.

## Required tests before enabling Checkout

1. Every allowed and forbidden state transition.
2. Expired Session confirmed by Stripe; Stripe unavailable; late successful payment after local expiry candidate.
3. Failure event after paid does not downgrade order.
4. Duplicate event ID with same and different payload fingerprints.
5. Out-of-order success/failure/expiry events.
6. Concurrent different events for one order still produce one Credit grant.
7. Crash/retry around Stripe Session creation using the same Stripe idempotency key.
8. New attempt after failed/expired order uses a new internal order and new idempotency key.
9. Refund and dispute reversal entries remain append-only and idempotent.

## Current implementation gaps

- No Stripe SDK or Checkout Session creation call.
- No canonical Stripe object retrieval.
- No webhook event receipt/processing pipeline; webhook remains fail-closed.
- No expiry worker or canonical expiry reconciliation.
- No failure/expired/review_required transition functions.
- No refund/dispute ledger reversal implementation.
- No subscription lifecycle.

Do not enable payment environment flags or expose purchasable plans until these gaps are implemented and Sandbox end-to-end tests pass.
