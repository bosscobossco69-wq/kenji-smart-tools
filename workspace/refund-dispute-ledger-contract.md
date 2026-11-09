# Refund and dispute ledger contract

Status: design only. This document does not enable Stripe refunds, issue refunds, mutate balances, or change payment routes.

## Scope

The first payment release remains one-time Credit packs in MYR. Refunds and disputes are separate append-only financial adjustments. They never rewrite the original payment event, original order, or original Credit grant.

## Canonical evidence

A refund adjustment may be recorded only after a server-side Stripe API retrieval confirms all of the following:

- Refund belongs to the PaymentIntent stored on the paid internal order.
- Refund ID is a valid Stripe Refund identifier and is unique.
- Refund status is `succeeded`; pending, failed, canceled, or unknown states do not reverse Credits.
- Amount is a positive integer in MYR minor units and does not exceed the paid amount.
- Currency, PaymentIntent, Checkout Session, customer, and internal order linkage match.
- The payment is in the expected Stripe mode (test or live) for the environment.

Never accept a browser assertion, webhook payload alone, or user-supplied refund ID as proof.

## Append-only records

Keep the original `paymentEvents` and `creditLedger` grant immutable.

For each successful Stripe Refund, persist a unique refund receipt keyed by a deterministic hash of the Stripe Refund ID, including:

- provider, refund ID, PaymentIntent ID, internal order ID, and user ID
- refund amount and currency
- canonical status and evidence fingerprint
- cumulative refunded amount after this refund
- Credit reversal amount, if any
- processing timestamp and reviewer metadata when applicable

A matching duplicate refund ID and fingerprint is an idempotent no-op. The same refund ID with conflicting details is an integrity incident and must be routed to review.

## Credit reversal policy

- Reversal entries are new immutable ledger rows referencing the original grant and Stripe Refund ID.
- Never edit or delete the grant row.
- For partial refunds, calculate cumulative Credits eligible for reversal from the cumulative refunded minor amount, then reverse only the difference from the amount already reversed. This avoids rounding drift across multiple partial refunds.
- The cumulative reversal must never exceed the original grant.
- The system must first know the user's unspent Credit balance. Do not silently claw back Credits already consumed.
- If the eligible reversal exceeds unspent Credits, record the refund financially but route the Credit shortfall to `review_required`/debt policy. Do not create a negative balance or silently revoke unrelated entitlements.
- Zero-Credit packs and refunds that do not change the rounded proportional Credit amount still require an auditable refund receipt, but no zero-value ledger row.

## Disputes

A dispute is not a refund and is not proof of final loss.

- Persist dispute opened, updated, and closed events as append-only provider records.
- An opened dispute may place the related order/credits into a reversible hold state only under a separately approved policy.
- Do not permanently remove Credits, ban an account, or treat the dispute as lost merely because it was opened.
- A won dispute releases any hold with an auditable event.
- A lost dispute requires canonical final Stripe evidence and human review before a separate immutable reversal/adjustment.
- Duplicate and out-of-order dispute events must converge using canonical retrieval, not event arrival order.

## Required tests before implementation

1. Successful full refund creates one receipt and one correctly capped reversal.
2. Duplicate refund delivery is idempotent.
3. Same refund ID with changed amount/currency/PaymentIntent is rejected and flagged.
4. Multiple partial refunds produce the same cumulative reversal as one equivalent full refund.
5. Cumulative refund amount cannot exceed the paid amount.
6. Cumulative Credit reversal cannot exceed the original grant.
7. Refund amount and currency mismatch do not change the ledger.
8. Pending, failed, canceled, or unknown refund status does not reverse Credits.
9. A refund with insufficient unspent Credits records the financial fact but does not silently create a negative balance.
10. Dispute opened, won, and lost events are idempotent and safe out of order.
11. A dispute opened does not trigger a permanent reversal or account ban.
12. Concurrent duplicate refund events create one receipt and one reversal.

## Explicit non-goals

- No Stripe Refund API calls.
- No automatic customer refunds.
- No automatic account bans.
- No negative Credit balances.
- No subscription proration or recurring billing.
- No live payment activation.

Implementation must wait until the ledger has an authoritative, transactionally consistent Credit balance/spend model and a human-review workflow. Until then, keep refund/dispute handling disabled and fail closed.
