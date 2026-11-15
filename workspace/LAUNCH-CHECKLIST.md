# KENJI AI Workspace — Free-first launch checklist

This document is an internal release checklist. It does not enable authentication, payments, subscriptions, Credits, or data collection.

## Current deployment boundaries

- Work only on `feature/kenji-ai-workspace-foundation`.
- Do not merge into or modify `main` without explicit approval.
- Keep the existing Cardora and Pokémon Treasure Supabase projects unchanged.
- Supabase Free currently has no available active-project slot for a separate Workspace project. Do not reuse either existing project.
- Keep Production checkout disabled until the full Stripe Test Mode validation matrix has passed and the release has explicit approval. Preview must use Stripe Test Mode.

## AI Customer Reply — configuration

Required Vercel environment variable:
- `GROQ_API_KEY`: secret GroqCloud API key, configured only in Vercel Project Settings → Environment Variables. Never commit it, put it in browser code, or send it in chat.

Optional:
- `GROQ_MODEL`: model identifier supported by GroqCloud. If omitted, the API route defaults to `openai/gpt-oss-20b`.

Provider endpoint: `https://api.groq.com/openai/v1/responses`. The free tier has model-specific rate limits and may retain request data temporarily for reliability or abuse monitoring. Do not submit passwords, payment data, or other sensitive personal information.

After adding or changing environment variables, redeploy the relevant Preview deployment.

## AI Customer Reply — Credits and reply retention

- Permanent financial records live in `users/{uid}/creditLedger/{requestId}` and retain the Credit delta, request hash, status, timestamps and reservation lease metadata only.
- Generated replies are stored separately in `users/{uid}/aiReplyCache/{requestId}` for idempotent retries, with an `expiresAt` timestamp one hour after creation. The reply text is not written into the permanent financial ledger.
- **Required one-time Firestore setting:** create a Time-to-live policy for collection group `aiReplyCache` using the `expiresAt` field. Without this policy, the application stops serving expired cache entries, but Firestore does not automatically delete the documents.
- AI Credit reservations use a five-minute lease. A retry with the same request ID can reclaim an expired lease; a lease token prevents a late earlier execution from completing or refunding a newer reservation.
- Verify in Preview that duplicate requests do not double-charge, stale reservations can be retried, and expired reply-cache documents are removed by Firestore TTL.

## Pre-launch verification

- [ ] Open the deployed Workspace landing page and verify every navigation link.
- [ ] Verify sign-in, sign-up, account and billing pages remain clearly marked as previews.
- [ ] Confirm preview forms remain disabled and do not transmit personal data.
- [ ] Without `GROQ_API_KEY`, confirm the reply endpoint returns a safe configuration error and does not expose secrets.
- [ ] With a valid `GROQ_API_KEY` configured privately in Vercel, test each supported scenario and tone using non-sensitive sample text.
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
