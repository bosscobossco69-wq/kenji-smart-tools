# Stripe Checkout — Preview setup

This route creates authenticated Stripe subscription Checkout Sessions for the four USD Workspace plans. It deliberately does not create Credits or activate entitlements. Those actions must happen only after a verified Stripe webhook and a completed ledger implementation.

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
- Do not enable purchase buttons until the webhook reconciles Checkout and subscription events against the pending order and an idempotent Credits ledger is implemented and tested.
- Use Stripe Test Mode keys and Test Mode Price IDs for Preview. Never place secrets in browser code or commit them.
- This initial route supports the four USD plans only. The three MYR products are intentionally not mapped.
