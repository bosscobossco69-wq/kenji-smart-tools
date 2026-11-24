# Signup Credits and AI upgrade — rollout checklist

## Implemented in this branch
- API account-billing optionally awards a ONE-TIME grant to email-verified Firebase users created on/after 2026-11-25T00:00:00Z.
- Server-side FREE_SIGNUP_CREDITS is an opt-in integer in [1,100]; absent/invalid means 0 and no grants.
- Grant is guarded by a Firestore transaction and creditLedger/signup_trial_v1 marker. Repeated visits and concurrent loads do not create duplicate grants.
- Existing balances, debts, subscriptions, unverified emails and pre-cutoff accounts are excluded.
- AI reply UI shows upgrade CTA when current credits are 0 or the generate API responds 402.
- No Stripe prices, webhook settings or deployed production environment variables have been changed.

## Required safety checks BEFORE merge / production activation
1. Run automated tests and perform sandbox account-billing/signup/concurrent request checks.
2. Verify that account-billing reads both the subscription and trial balances without altering paid receipts.
3. Confirm Vercel is still within the Hobby serverless function limit (no new API function in this PR).
4. After deployment, set FREE_SIGNUP_CREDITS=20 in the relevant Vercel environment ONLY when ready; redeploy.
5. Confirm new verified account gets exactly 20 Credits; verify repeated refreshes never grant again.
6. Confirm old user and the historical paid US$5 account remain untouched.
7. Confirm 20 successful reply requests deplete the trial balance and prompt upgrade, with no charge.
8. Verify signup promotion is only advertised publicly AFTER activation.

## Unimplemented / subsequent milestones
- Registration gate for all browser tools (needs a deliberate product/SEO decision and page-by-page implementation).
- Discounted recurring Stripe prices (requires price IDs and explicit subscription migration policy).
- Telegram Bot end-to-end webhook, tenant ownership, token secret storage, AI reply, rate limiting and billing.
- Official WhatsApp Cloud API onboarding, webhook signature validation, template/24-hour window handling, human handoff and messaging charges.

## Business requirements
- Never grant free credits on the browser; all credit additions must have auditable server-side ledger entries.
- Preserve existing billing data; do not reset balances or resubscribe users.
- Do not describe WhatsApp/Telegram as live until a tested end-to-end channel is deployed.
