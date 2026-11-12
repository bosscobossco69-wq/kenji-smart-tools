# Stripe Checkout — Preview setup

This route creates authenticated Stripe subscription Checkout Sessions for the four USD Workspace plans. Credits are issued only after a verified Stripe invoice webhook and an idempotent Firestore ledger transaction. Plan entitlement activation remains a separate integration.

## Required server-only Vercel environment variables

- `STRIPE_SECRET_KEY` — Stripe secret key for the matching environment (use Test Mode for Preview).
- `FIREBASE_PROJECT_ID` — `kenji-ai-workspace`.
- `FIREBASE_SERVICE_ACCOUNT_JSON` — Firebase Admin service account JSON; keep server-side only.
- `SITE_URL` — canonical HTTPS site origin, preferably the Preview origin during testing. Alternatively, set `ALLOWED_CHECKOUT_HOSTS` to a comma-separated exact host allowlist.

## Stripe Price ID mapping

Set each variable to the corresponding active recurring Stripe Price ID. Do not use Product IDs.

| Plan | Monthly Price ID variable | Yearly Price ID variable |
|---|---|---|
| Lite | `STRIPE_PRICE_LITE_MONTHLY` | `STRIPE_PRICE_LITE_YEARLY` |
| Pro | `STRIPE_PRICE_PRO_MONTHLY` | `STRIPE_PRICE_PRO_YEARLY` |
| Pro+ | `STRIPE_PRICE_PRO_PLUS_MONTHLY` | `STRIPE_PRICE_PRO_PLUS_YEARLY` |
| Ultra | `STRIPE_PRICE_ULTRA_MONTHLY` | `STRIPE_PRICE_ULTRA_YEARLY` |

The yearly variables must remain unset until the matching annual Prices have actually been created in Stripe. The API fails closed when a requested Price ID is missing, inactive, non-USD, or has the wrong recurring interval.

## Request contract

Authenticated browser request:

- Method: `POST`
- Path: `/api/stripe-checkout`
- Header: `Authorization: Bearer <Firebase ID token>`
- JSON body: `{"planId":"lite|pro|pro_plus|ultra","interval":"monthly|yearly"}`

The route verifies the Firebase ID token and verified email, reads the Price ID only from server environment variables, validates the Stripe Price, writes a pending document to `billingOrders`, and creates a subscription Checkout Session. Both Checkout Session and Subscription metadata include `firebaseUID`, `orderId`, `planId`, and `interval`.

## Important safety boundary

- This route does not issue Credits, grant plan access, or treat a browser success redirect as proof of payment.
- Purchase buttons are enabled only for signed-in users with verified email. Checkout still fails closed until the matching server-side Stripe Price IDs are configured.
- Use Stripe Test Mode keys and Test Mode Price IDs for Preview. Never place secrets in browser code or commit them.
- This initial route supports the four USD plans only. The three MYR products are intentionally not mapped.

## Webhook and Credits behavior (Preview validation required)

- A paid monthly subscription invoice is eligible for a Credits grant only when the subscription metadata contains the Checkout-created `orderId`, `planId`, and Firebase UID, and the invoice line Price ID matches the subscription Price ID and pending order.
- Monthly grants are 10,000 (Lite), 30,000 (Pro), 100,000 (Pro+), and 400,000 (Ultra).
- Each paid invoice has a deterministic per-user ledger document ID based on its Stripe invoice ID. The Firestore transaction creates the ledger entry and increments `users/{uid}.creditsBalance` atomically, preventing duplicate invoice grants.
- Annual subscriptions receive one monthly Credits allocation on each paid annual invoice and then monthly scheduled allocations. They never receive a full year's Credits at once.
- A missing/mismatched Checkout order causes invoice processing to fail and Stripe to retry. Review the event and order records before enabling Live checkout.

## Preview test matrix

Use Stripe Test Mode and a dedicated test Firebase user. Verify: successful monthly checkout grants exactly one monthly allocation; replaying the same `invoice.paid` event does not add Credits again; a different renewal invoice grants one additional allocation; wrong Price ID / missing order does not grant Credits; failed invoice does not grant Credits; yearly invoice does not issue a yearly lump sum. Also verify subscription cancellation and payment-failure status separately.

## Annual subscription monthly Credits scheduler

- `api/stripe-annual-credit-grant.js` runs daily at 03:00 UTC through the Vercel Cron entry in `vercel.json`. The job paginates through annual billing records in batches of 200, so it is not limited to the first 200 subscribers.
- Set a strong server-only Vercel environment variable named `CRON_SECRET`. Vercel Cron must call the endpoint with `Authorization: Bearer <CRON_SECRET>`; manual calls without the matching secret are rejected.
- When an annual subscription invoice is paid, the webhook grants one monthly allocation and initializes `nextCreditGrantAt` to one calendar month after the subscription period start.
- The scheduled job checks the current Stripe subscription status, grants at most one overdue monthly allocation per subscription per run, writes a deterministic month ledger record, increments the balance atomically, and advances the next grant date using the original subscription anniversary day (for example, a Jan 31 anniversary falls on the last day of February, then returns to Mar 31).
- It stops granting at or beyond the subscription period end and skips inactive subscriptions. A new paid annual renewal invoice initializes the next annual cycle.
- Configure the CRON_SECRET in Preview before testing. Confirm the Vercel project plan supports the configured daily Cron schedule and inspect Cron invocation logs. This code has not yet been runtime-tested against Stripe or Firestore.
