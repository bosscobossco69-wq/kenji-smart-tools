# KENJI AI Workspace — Free-first launch checklist

This document is an internal release checklist. It does not enable authentication, payments, subscriptions, Credits, or data collection.

## Current deployment boundaries

- Work only on `feature/kenji-ai-workspace-foundation`.
- Do not merge into or modify `main` without explicit approval.
- Keep the existing Cardora and Pokémon Treasure Supabase projects unchanged.
- Supabase Free currently has no available active-project slot for a separate Workspace project. Do not reuse either existing project.
- Do not enable checkout or issue Credits until a verified payment ledger and server-side payment verification are implemented.

## AI Customer Reply — configuration

Required Vercel environment variable:
- `OPENAI_API_KEY`: secret API key, configured only in Vercel Project Settings → Environment Variables. Never commit it, put it in browser code, or send it in chat.

Optional:
- `OPENAI_MODEL`: model identifier supported by the connected API account. If omitted, the API route currently defaults to `gpt-5.4-mini`; verify the selected model is available to the account before launch.

After adding or changing environment variables, redeploy the relevant Preview deployment.

## Pre-launch verification

- [ ] Open the deployed Workspace landing page and verify every navigation link.
- [ ] Verify sign-in, sign-up, account and billing pages remain clearly marked as previews.
- [ ] Confirm preview forms remain disabled and do not transmit personal data.
- [ ] Without `OPENAI_API_KEY`, confirm the reply endpoint returns a safe configuration error and does not expose secrets.
- [ ] With a valid key configured privately in Vercel, test each supported scenario and tone using non-sensitive sample text.
- [ ] Verify invalid methods, invalid JSON content type, oversized bodies, invalid scenarios and invalid tones are rejected.
- [ ] Confirm the endpoint accepts same-origin HTTPS Preview and production requests and rejects cross-origin requests.
- [ ] Configure provider-side spending alerts/limits where available; do not assume a hard spend cap exists.\n- [ ] Add a durable abuse-control strategy (rate limiting and bot protection) before public launch; same-origin checks alone do not prevent scripted abuse.\n- [ ] Review API usage and spending limits in the provider dashboard before inviting public users.
- [ ] Review privacy notice and retention practices before collecting customer messages.

## Not launch-ready yet

- Supabase Auth and user sessions
- User profiles and team membership
- Persistent Credits ledger and usage metering
- Payment checkout, callback reconciliation and refunds
- Subscription lifecycle and entitlement enforcement
- Abuse prevention, rate limiting and operational monitoring

## Domain plan

Use the Vercel Preview URL while validating the product. When a KENJI domain is purchased, add it to Vercel and update canonical URLs, redirects, OAuth allowlists and trusted origins before switching public links.
