# Credit balance and spending contract

Status: implementation contract. The current payment ledger grants Credits but does not yet maintain an authoritative spendable balance. Do not expose Credit spending or refunds until the balance migration and tests are complete.

## Source of truth

- `creditLedger` is the immutable financial history.
- `creditBalances/{userId}` is a materialized balance maintained only by server-side Firestore transactions.
- A balance is valid only when it can be reconciled to the append-only ledger. A missing balance for a user with historical grants/spends is not automatically zero; it requires reconciliation.
- Browser clients must never write balances or ledger entries. Existing Firestore rules deny all client writes.

## Grant transaction

For a verified one-time payment, one Firestore transaction must:

1. Read the unique payment event receipt, order, deterministic grant ledger key, and user balance.
2. Confirm the order is pending and all canonical Stripe evidence matches.
3. Create exactly one grant ledger entry keyed by internal order/payment identity, not webhook delivery ID.
4. Increase the materialized balance by the same integer Credit amount.
5. Mark the order paid and persist the event receipt.

All writes must commit atomically. A retry or a different event for the same order must not create a second grant or increment the balance again.

## Spend transaction

A future `spendCredits` operation must:

- Require a server-verified Firebase UID.
- Accept a positive safe integer amount and a high-entropy idempotency key scoped to that UID.
- Read the spend receipt and balance inside one Firestore transaction.
- Return the original result for an identical retry; reject reuse of the key with changed amount or reference.
- Reject insufficient balance; never permit a negative balance.
- Append one immutable negative `spend` ledger row and decrement the materialized balance in the same transaction.
- Support concurrent requests safely; Firestore transaction contention must ensure the balance cannot be overspent.

## Reconciliation and migration

Before enabling this model for existing users:

1. Build a read-only reconciliation report from all grant, spend, reversal, and adjustment entries.
2. Identify users with missing, duplicated, malformed, or inconsistent entries.
3. Do not initialize a missing balance to zero when ledger history exists.
4. Backfill materialized balances only from validated ledger history, with a migration version and audit record.
5. Compare each materialized balance to the ledger-derived balance.
6. Require zero unexplained differences before enabling spend or refunds.

## Refund safety dependency

A refund must first record the canonical financial refund receipt. Credit reversal is a separate append-only entry. The system may reverse only Credits that remain unspent under the approved policy. If the user's available balance is insufficient, route the shortfall to human review; do not create negative balances, delete spend history, or silently claw back unrelated Credits.

## Required tests

1. Verified payment increments balance exactly once.
2. Duplicate event and concurrent different events cannot double-grant.
3. Spend appends one negative row and decrements balance atomically.
4. Same spend key and same request is idempotent.
5. Same spend key with changed amount/reference is rejected.
6. Insufficient balance leaves ledger and balance unchanged.
7. Concurrent spends cannot overdraw the balance.
8. Missing or malformed balance with existing history fails closed.
9. Transaction retry after a simulated conflict remains idempotent.
10. Reconciliation detects duplicate, missing, and inconsistent ledger entries.
11. Partial refund after partial spend never creates a negative balance.

## Explicit non-goals

- No browser-side balance writes.
- No negative balances or silent debt creation.
- No automatic refund API calls.
- No live payment enablement.
- No migration/backfill until a dedicated database is provisioned and a backup/restore plan is tested.
