# Stripe Sandbox implementation checkpoint

Last updated: 2026-11-10

## Project boundary
- Repository: `bosscobossco69-wq/kenji-smart-tools`
- Working branch: `feature/stripe-sandbox-integration-preview`
- Pull request: #13 — Prepare Stripe Sandbox integration plan
- PR base: `feature/kenji-ai-workspace-foundation`
- PR status: Open, Draft, not merged.
- Keep ToyyibPay PR #12 separate.
- Do not modify `main`, production deployment, Cardora, or Pokémon Treasure.
- Do not change the approved website colors, styling, or UI without a separate request.

## Completed
1. Stripe Sandbox-only Checkout and webhook scaffolding for one-time MYR Credits packs.
2. Server-side plan lookup and order creation; client cannot choose authoritative amount, currency, user ID, or Credits grant.
3. Stripe client rejects non-`sk_test_` keys.
4. Checkout webhook verifies signature against raw body and retrieves canonical Checkout Session before payment grant.
5. Transactional, idempotent payment order/Credit ledger helpers, including spend, refund, and dispute-recording primitives.
6. Firestore client rules deny all client reads and writes.
7. Firestore Rules Emulator integration test added for unauthenticated and authenticated read/create/update/delete denial across sensitive collections.
8. CI dependency installation fixed. Both latest workflow runs for commit `e27af3aa48e7e336b48c471461976afd130fa13b` succeeded:
   - Push run: 42572882955
   - Pull request run: 42572889641
   Both include successful Firestore Emulator integration test step.
9. Vercel feature-branch Preview deployment reported Ready. User visually checked the site and approved the appearance.

## Not completed / remaining phases
### Phase A — Refund and dispute ledger tests (partially complete)
- Confirmed commit `d96206b4f6f8382ffc9ed3901857e0eaa64010cc` CI: Push run `42574919596` and PR run `42574928443` both succeeded. Push log: 93 tests, 91 pass, 0 fail, 2 explicitly skipped opt-in guard tests; the three new refund/dispute tests executed and passed.
- Added six webhook regression tests in commit `bc6e067419f847198369cb7972eac682484898ce` for `refund.created`, `refund.updated`, `charge.refunded`, and dispute created/updated/closed. They assert these events remain safely ignored and cannot trigger Stripe retrieval or ledger mutation until canonical reconciliation is implemented. CI pending.
- Added `tests/payment-refund-dispute-emulator.test.js` in commit `d96206b4f6f8382ffc9ed3901857e0eaa64010cc`.
- New Emulator cases: cumulative refunds cannot exceed paid amount; refund ID reuse with conflicting evidence is rejected; lost dispute is recorded for human review and does not change Credits.
- Still to add: webhook handler/canonical-object tests for full and partial refunds, duplicate delivery, currency/PaymentIntent/order mismatch, pending/failed refund statuses, dispute created/updated/closed and out-of-order events.

### Phase B — Canonical Stripe object retrieval and reconciliation (implementation started; not wired into webhook)
- Added `api/_lib/stripe-canonical-reconciliation.js` to retrieve canonical Refund/Dispute, Charge, PaymentIntent, and Checkout Session objects server-to-server.
- The verifier uses only the signed event type and object ID from the webhook payload; monetary/status/customer/linkage evidence comes from Stripe retrieval and the internal paid order lookup.
- Checks Sandbox mode, object IDs, Refund/Dispute ↔ Charge ↔ PaymentIntent ↔ Checkout Session ↔ internal order linkage, customer, user metadata, MYR currency, paid state, and original amount.
- Pending refunds are explicitly marked non-recordable; only canonical succeeded refunds are eligible for the ledger helper.
- Added `tests/stripe-canonical-reconciliation.test.js` covering refund/dispute canonical retrieval, untrusted event payload fields, pending refund, unknown event type, and mismatched/Live evidence.
- Implementation commits: `00db3bc` (tests), `c8465d1` (verifier), `37bb2b1` (fixture corrections), `83b74cc` (Charge field validation correction).
- CI for earlier PR head `83b74cca8ceb699ca3ccea6760a434c5165267a5` failed in the new verifier tests: four fixture/assertion defects (missing event IDs in three fixtures and an order-dependent Promise.all call assertion); core existing suites passed. Fixed these test issues in commit `a6d456298296a774ffc6dedeeba0b84e677a6bb3`. The corrected head is now awaiting CI.
- Do not wire refund/dispute webhook events until this CI passes and the verifier is reviewed.
- Unknown, incomplete, conflicting, or out-of-order evidence must fail closed or route to review.

### Phase C — Implement webhook ingestion
- Only after Phase A tests and Phase B reconciliation design are reviewed.
- Wire supported refund/dispute event types to the existing ledger helpers.
- Preserve raw-body signature verification, idempotency, append-only audit records, and Stripe retry behavior (5xx on transient processing failure).
- Do not add an event type to the supported set without a complete canonical retrieval path.

### Phase D — Verify and document
- Run full Node tests and Firestore Emulator integration tests in CI.
- Inspect exact test counts and ensure no intended suite is skipped.
- Update setup/status and refund/dispute contract documents.
- Keep all work on the feature branch and PR #13 Draft.

### Phase E — Separate future approval gates (not authorized now)
- Controlled end-to-end Stripe Sandbox checkout/webhook test using properly configured Sandbox secrets.
- Frontend balance/ledger integration through server-authorized APIs.
- Any Live-mode, subscription, auto-renewal, Customer Portal, merge, or production deployment requires separate explicit approval.

## Safety rules
- Sandbox/Test mode only; never use Live keys.
- Never request or expose secrets in chat or source control.
- No real refunds, no automatic dispute-loss clawback, no negative Credits balance.
- No subscription activation or automatic renewal.
- No SQL, Firebase Console changes, production deployment, merge, or UI redesign without explicit authorization.

## Latest checkpoint
- Canonical verifier implementation and mocked tests have been added but remain unverified pending CI run `42769410275`; refund/dispute webhook events remain ignored.
- Refund/dispute ledger tests at `d96206b4f6f8382ffc9ed3901857e0eaa64010cc`: both CI runs passed; 93 tests, 91 passed, 0 failed, 2 expected opt-in guards skipped. All three new refund/dispute tests executed and passed.
- Added six webhook safety regression tests at `bc6e067419f847198369cb7972eac682484898ce`; these ensure refund/dispute events remain ignored with no Stripe retrieval or ledger mutation until canonical reconciliation exists. CI pending.

## Next exact action
Check the latest PR workflow for head `a6d456298296a774ffc6dedeeba0b84e677a6bb3` (runs: 42769734463:queued). If green, review verifier correctness and add canonical tests for failed/canceled refunds, dispute state edge cases, missing/ambiguous orders, and object retrieval failures. If red, inspect logs and fix the exact failures. Only then plan webhook wiring. Do not modify UI or activate refund/dispute event handling prematurely.
