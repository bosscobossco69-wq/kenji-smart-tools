# KENJI Smart Tools — 3-Day Trial Implementation Plan

Status: DESIGN ONLY — trial enforcement is not enabled.

## Product policy
- One 3-day introductory trial per Firebase account.
- Trial starts only after successful account creation and verified email.
- Store timestamps in UTC; derive expiry on the server.
- Re-login, browser storage clearing, device changes, and local clock changes must not reset the trial.
- At expiry, retain account/profile and historical records; restrict premium AI actions until a verified paid entitlement exists.
- No automatic charge. No payment means no paid entitlement.
- A payment redirect or uploaded receipt is not proof of payment.

## Required architecture before activation
1. Firebase Authentication remains the identity provider.
2. Provision a durable database (Firestore is proposed) in the existing kenji-ai-workspace Firebase project, after confirming billing/quota and region.
3. Add server-side Firebase ID-token verification using Firebase Admin SDK or an equivalent verified-token flow. Never trust a UID supplied in request JSON.
4. Create a server-only trial initializer that transactionally creates one immutable trial record per UID. Repeated calls must return the original timestamps and never extend the trial.
5. Create a server-side entitlement guard for every paid AI endpoint. It must check verified identity, email verification, trial expiry, and active subscription status on every request.
6. Keep provider webhook verification server-side. Only verified provider events may activate or renew subscriptions.
7. Add abuse controls: per-account and per-IP rate limits, request size limits, origin checks, and monitoring. Do not rely on localStorage or client-side timers.
8. Add privacy notice, retention policy, support path, and clear trial/renewal terms before public launch.

## Suggested Firestore data model
```text
users/{uid}
  createdAt
  emailVerifiedAt
  trialStartedAt
  trialEndsAt
  trialStatus: not_started | active | expired
  subscriptionStatus: none | active | past_due | canceled
  planId
  entitlementUpdatedAt
```

- Client writes to trial and subscription fields must be denied by database rules.
- Trial creation must use a server transaction and immutable once-only semantics.
- A user must never be able to set their own plan, expiry, or payment status.

## Rollout gates
- Gate A: confirm Firestore is enabled and select a region.
- Gate B: deploy server-side auth verification and transactional trial service.
- Gate C: enforce the entitlement guard on every paid AI endpoint.
- Gate D: test expiry, duplicate signup, replay, forged UID, unverified email, and provider webhook cases.
- Gate E: only then change the signup copy from planned offer to active 3-day trial.

## Current safety state
- Trial remains preview-only.
- Billing page remains display-only; all checkout buttons stay disabled.
- No credits are issued and no payment method is represented as active.
- Do not merge this branch into main until the separate release review is complete.