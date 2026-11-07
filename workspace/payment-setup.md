# ToyyibPay integration — implementation status

## Current status: safe scaffold only

The API routes are present but checkout and Credit issuance are deliberately disabled.
This is intentional: the repository currently has no dedicated KENJI AI Workspace
database/order ledger. Do not point these routes at the Cardora or Pokémon Treasure
Supabase projects.

## Routes

- `POST /api/toyyibpay/create-bill` — fail-closed until server-side plans and pending-order persistence exist.
- `POST /api/toyyibpay/callback` — validates the ToyyibPay callback MD5 hash, but does not issue Credits.
- `POST /api/toyyibpay/verify-payment` — reserved for server-to-server transaction verification.

## Required next implementation

1. Provision a dedicated database for KENJI AI Workspace (no reuse of unrelated projects).
2. Add an orders table with unique internal order ID, user ID, plan/pack ID, expected amount in MYR sen, bill code, status and timestamps.
3. Add a Credit ledger with a unique payment reference / order constraint so duplicate callbacks cannot credit twice.
4. Enable row-level security and user ownership policies for all user-facing tables.
5. Implement server-side plan pricing; never accept amount or Credits quantity from the browser.
6. Implement ToyyPay Create Bill using the Sandbox host and Sandbox credentials.
7. In callback processing, validate the provider hash, load the matching pending order, call Get Bill Transactions, compare bill code/reference/amount/status, then atomically post one ledger event.
8. Test success, pending, failed, invalid hash, amount mismatch, unknown order, duplicate callback and provider timeout.
9. Only after Sandbox tests and merchant approval, configure Live credentials as server-only environment variables.

## Environment variable names

Use Vercel Project Settings → Environment Variables. Never commit values or paste secrets into chat.

- `TOYYIBPAY_BASE_URL` — Sandbox host during testing: `https://dev.toyyibpay.com`.
- `TOYYIBPAY_SECRET_KEY` — Sandbox secret only during Sandbox testing.
- `TOYYIBPAY_CATEGORY_CODE` — Category code from the matching Sandbox account.
- `TOYYIBPAY_CHECKOUT_ENABLED` — keep unset / false until the full checkout flow is implemented.
- `PAYMENT_LEDGER_READY` — keep unset / false until the dedicated database and atomic ledger are verified.

Never mix Sandbox credentials/category codes with Live endpoints, or Live credentials with Sandbox endpoints.
The merchant's Live account verification/settlement approval is a separate provider-side requirement.
