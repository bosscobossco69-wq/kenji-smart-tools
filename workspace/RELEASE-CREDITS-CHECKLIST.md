# Dual-sales release checklist (Subscriptions + one-time Credits)

This change is code preparation only. Do not merge or deploy automatically. Keep the
Vercel Ignored Build Step and Production checkout gate unchanged until a release is
explicitly approved. No Stripe products, Prices, endpoints or secrets are created by this change.

## Completed in code

- All payment/account/AI records use deployment-selected roots:
  `billing_test_users`, `billing_live_users`, and equivalently prefixed
  `billingOrders`, `stripeWebhookEvents`, `stripeSnapshotSequences`, `stripeChargeAdjustments`.
- User billing documents use `billing_test/current` or `billing_live/current`.
  Credit ledgers and AI reply caches are below their isolated user root.
- Preview/local requires a Test key. Production requires a Live key. New purchases
  additionally require `STRIPE_LIVE_CHECKOUT_ENABLED=true` in Production.
- Signed Webhook events and retrieved payment resources must match deployment mode.
  Cron queries only its own `billing_test`/`billing_live` collection group and checks
  the root before processing, then verifies the subscription mode.
- Existing `users`, `billingOrders`, ledgers, Customer IDs and subscription records
  are left unchanged. No automatic copy or destructive migration runs at deploy.
- Live accounts with a legacy billing document are held for review (HTTP 409) until
  `legacyReviewComplete` is recorded in their new isolated billing document. New
  accounts without legacy billing can purchase packs independently.
- One-time pack refunds reconcile cumulative **successful** refunds proportionally
  (rounding revoked Credits up). Pending/failed refunds do not count. Duplicate
  deliveries, refund/dispute overlap and stale snapshots cannot double debit.
- Open/lost disputes hold the pack's full Credits; a won dispute restores the
  non-refunded portion. Actionable fraud warnings hold Credits for review.
- If Credits were spent, refunds can leave a negative balance. AI usage stops;
  later purchases offset debt. The account page displays debt separately.
- Checkout arriving after a refund/dispute applies the hold atomically with the
  grant. It cannot temporarily grant a refunded pack's full spendable Credits.
- Existing subscriptions have a verified Stripe Customer Portal entry plus a
  support email fallback. All four monthly/yearly subscription checkout buttons
  are restored alongside all four one-time Credits packs. New subscription
  checkout remains fail-closed until STRIPE_SUBSCRIPTIONS_ENABLED=true is set
  after price, entitlement, billing period and refund tests.
- Browser tools remain free. No automatic free monthly Credits are promised.
  Unimplemented seats/channels/team/automation features are marked Coming Soon.
- Search Console verification, sitemap, robots, advertisements and affiliate code
  are outside the edited files and remain unchanged.

## Must confirm privately in dashboards before real collection

These are **verification items**, not a claim that configurations are missing.
Never paste secret values in a ticket, PR or chat.

### Vercel

- Production variables have correct scope: `STRIPE_SECRET_KEY` (the current code
  expects a Live secret key), `STRIPE_WEBHOOK_SECRET` for the matching existing
  Live endpoint, `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `SITE_URL`,
  `GROQ_API_KEY`. `GROQ_MODEL` and `AI_REPLY_CREDIT_COST` are optional.
- Preview retains Test credentials and its own SITE_URL. `SITE_URL` must be an HTTPS
  origin. AI origin checks currently support the existing Vercel domain and its
  Preview hosts; a new custom domain needs a separate explicit allowlist change.
- For dual-sales launch, validate all eight USD subscription Price variables
  (`STRIPE_PRICE_*_MONTHLY` and `STRIPE_PRICE_*_YEARLY`) against active Stripe
  recurring Prices before setting `STRIPE_SUBSCRIPTIONS_ENABLED=true`.
  This flag is deliberately not changed by the PR. Pack purchases do not require Price IDs.
- Keep `STRIPE_LIVE_CHECKOUT_ENABLED` off until an approved release. Keep the saved
  production build skip command; this PR neither reads nor changes that dashboard setting.
- `CRON_SECRET` and the daily schedule must be verified if maintaining reviewed
  annual subscribers. Historical annual schedules are not guessed or automatically
  imported; support must verify entitlement and the next grant date before enabling
  their isolated schedule. Do not silently abandon existing paid annual customers.

### Stripe

- Live account can accept charges. Existing Live endpoint URL resolves to the
  approved release's `/api/stripe-webhook` after a future authorized deployment.
- Inspect the **existing** endpoint subscriptions; avoid duplicate endpoints.
  Purchase events: `checkout.session.completed`,
  `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`.
  After-sale events implemented: `charge.refunded`, `refund.created`,
  `refund.updated`, `refund.failed`, `charge.dispute.created/updated/closed`,
  `radar.early_fraud_warning.created/updated`.
  Retained subscription events: `customer.subscription.created/updated/deleted`,
  `invoice.paid`, `invoice.payment_failed`.
- Confirm existing Customer Portal settings permit cancellation and payment-method
  management. If unavailable, use the support procedure below; do not create a
  second customer or silently link by email.
- Packs need no Price IDs: USD 5/20/35/150 buy 10k/50k/100k/500k Credits through
  server-defined inline prices. Do not recreate products/Prices for this change.
- Confirm refund/support terms and applicable tax treatment. No automatic tax is
  enabled by this PR; tax registration must be assessed before enabling Stripe Tax.

### Firebase

- Confirm effective rules deny browser/client writes to both `billing_test_*` and
  `billing_live_*` roots and their descendants, including balances/ledgers/orders,
  event leases, adjustment state and migration markers. Only server Admin IAM may
  write. An old broad `allow write` rule can override an added deny: inspect actual
  effective rules, not just one rule fragment.
- Firebase frontend project, Admin project, production authorized domains and
  email verification/password reset are correct.
- Confirm TTL policy on collection group `aiReplyCache`, field `expiresAt`, covers
  the newly isolated paths. For annual subscribers verify collection-group indexes
  on `billing_live.interval` / `billing_test.interval` as needed by Firestore.
- Review every legacy Live account before importing anything. Until review its
  historical data remains intact and purchases/AI/balance display are held.

## Support and historical-account procedure

1. Customer uses Billing → Manage or cancel subscription. The API verifies Firebase
   token, verified email, deployment mode and the Stripe customer's UID metadata.
   If it cannot safely resolve ownership, it returns the support email instead of
   opening another customer's portal.
2. Support receives receipt/order/subscription ID at `kenjing3073@gmail.com`.
   Never request passwords, card numbers, private keys or secret values.
3. For cancellation, inspect the exact customer in the correct Stripe mode and
   cancel at period end (or immediately only with the customer's instruction).
   Do not treat Checkout's cancel URL as subscription cancellation.
4. For pack refunds, use the existing Stripe Dashboard refund action after review.
   The signed event handles Credits. Check the isolated order's `refundedAmount`,
   `revokedCredits` and ledger; replay a failed event rather than editing the balance
   or creating a second refund. No automatic money transfer is made by this code.
5. Watch `billing_live_stripeChargeAdjustments` for `manualReview=true`, and
   `billing_live_stripeWebhookEvents` for retryable/unprocessed events. Subscription
   or legacy payments without pack provenance go to review instead of guessing a
   Credits amount. Inspect current Stripe status and all previous ledger adjustments.
6. For historical balances, use `scripts/import-reviewed-live-billing.mjs` on a
   trusted administrator machine with existing server credentials supplied privately.
   It validates Live customer/subscription ownership and is a dry run unless
   `--apply` is supplied. Example manifest shape (not a real account):

   ```json
   [{"uid":"REVIEWED_UID","reviewedCreditBalance":100,"reviewReference":"support-case-001","legacyUpdateTime":"100:1","stripeCustomerId":"cus_REVIEWED_LIVE"}]
   ```

   `legacyUpdateTime` is the exact `seconds:nanoseconds` of the reviewed legacy document's updateTime;
   obtain it through an authorized Admin read. `stripeSubscriptionId` is optional.
   The **reviewed** Credits amount excludes test payments and accounts for refunds
   and spent Credits; never blindly copy the historical total. The script adds it
   once with a deterministic opening ledger entry, never overwrites history, and
   does not automatically resume an annual grant schedule. Keep the review evidence
   and manifest private. Run a dry run, review it, then apply the same manifest.
7. For reviewed subscription/legacy refund or dispute Credits use
   `scripts/apply-reviewed-credit-adjustment.mjs` with
   `{uid, caseId, reviewReference, chargeId, creditsDelta}`. It is dry-run by default,
   verifies Live customer ownership, requires completed legacy review and uses the
   case ID as an idempotency key. Use one stable case ID per decision, including
   retries; a later dispute reversal is a separate reviewed decision. Automatic pack
   payments are rejected by this tool: use webhook reconciliation instead.
8. Fraud holds and unknown dispute associations remain in the review queue. Clear
   the underlying Stripe warning/status when appropriate and replay its signed event;
   do not manually zero an automatic adjustment state or generate free Credits.

## Can follow the dual-sales release

- Implement and separately validate all advertised team/channel features before
  removing Coming Soon. Subscription buyers must only be promised and charged for
  verified Credits entitlements and working billing/cancellation capabilities.
- Automate the legacy/subscription review queue and richer operational notifications.
- Custom-domain expansion, expanded reporting and optional free monthly Credit
  provisioning. None should be promised until implemented and tested.

## Validation for this change

`npm run test:billing` uses actual route/helper source with isolated SDK boundaries;
no actual charges, refunds or database changes are made. Tests cover namespace and
mode fencing, payment/order verification, duplicate events, partial refunds, refund
ordering, dispute outcomes, fraud holds, Portal ownership, legacy migration/review,
AI reservation/refund/cache/debt, and default subscription closure plus restored dual-sales UI. This is not a
claim that dashboard settings or real Live end-to-end payment have been verified.

## Dual-sales release acceptance gates

- Monthly and yearly subscription Checkout sessions are validated against the correct
  **USD** recurring Price IDs, interval, amount, and Stripe mode. Older MYR catalog
  products must not be substituted without a coordinated currency/pricing redesign.
- Subscription invoice webhook grants the correct monthly Credits once; annual plans
  receive monthly scheduled grants without duplicating the initial invoice grant.
- Customer Portal cancellation and subscription renewal/payment failure handling
  are checked against the same environment. The 3-day Stripe Checkout trial is implemented behind
  `STRIPE_SUBSCRIPTION_TRIAL_ENABLED=true` and requests a payment method up front;
  missing-payment-method trial end behavior is `cancel`. Keep the flag OFF until
  verified trial signup, trial invoice, first paid invoice, cancellation before
  trial end, recurring charge and Credits grants have all passed Preview tests.
  Trial-start $0 invoices do **not** grant plan Credits; plan Credits begin after\n  the first successful payment. Do not advertise a trial until these pass. Confirm Stripe sends the appropriate
  customer notices for trial expiration and automatic charging.
- Credits packs still work independently and retain duplicate-event, refund, dispute,
  and fraud-warning protections. Existing Sandbox tests do not establish Live readiness.
- Verify effective Firestore rules for new isolated roots and review historical Live
  balances before switching. Do not automatically merge, deploy, or enable live charges.
