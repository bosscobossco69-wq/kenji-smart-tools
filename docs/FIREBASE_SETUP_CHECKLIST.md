# Firebase setup checklist — KENJI AI Workspace

Purpose: prepare the existing Firebase project `kenji-ai-workspace` for secure trial and subscription entitlements.

Important: this repository is deployed with Vercel. Adding Firestore files to GitHub does not itself create a Firestore database or deploy Firestore Security Rules.

## Console checks required
1. Open Firebase Console and select the existing project `kenji-ai-workspace` (do not select Cardora or Pokémon Treasure projects).
2. Open Build → Firestore Database. Check whether a database already exists.
3. If no database exists, do not create it until the production region has been selected deliberately. Firestore database location cannot be changed in-place later.
4. Confirm the project plan and quotas. Do not enable paid billing or upgrade a plan without reviewing the cost implications.
5. Keep Firebase Authentication → Email/Password enabled.

## Credentials required for server-side enforcement
- Use a server-side Firebase Admin SDK credential or supported workload identity on the server. Never place a service-account private key in browser JavaScript, HTML, GitHub, or a public environment variable.
- Store credentials only in Vercel server-side environment variables / secure integration settings.
- Do not paste private keys, service-account JSON, API secrets, passwords, or OTPs into chat.

## Before trial activation
- Deploy Firestore Security Rules that deny clients writes to entitlement fields.
- Implement authenticated server endpoints that verify Firebase ID tokens and email verification.
- Create each trial once in a server transaction; repeated calls must not extend it.
- Enforce entitlement checks on every paid AI API endpoint.
- Test with a separate test account before public release.

## Current status
- Signup page describes the planned offer only.
- Trial start/end dates are not yet stored.
- No account is currently granted a trial entitlement by this repository.
- Do not announce the 3-day trial as active until the above steps and tests pass.