# KENJI AI Workspace — Firebase Authentication setup

Status: preparation only. No Firebase project is connected and no credentials are stored in this repository.

## Decision

Use a dedicated Firebase project for KENJI AI Workspace authentication, on the Spark (no-cost) plan.

Initial scope:
- Email/password registration
- Email address verification before treating an account as verified
- Email/password sign-in
- Password reset email
- Sign out and persistent session handling
- Account page showing the signed-in user's email and verification state

Out of scope for this phase:
- Phone/SMS authentication
- Firestore, Storage, Cloud Functions, billing, subscriptions, Credits, and payment processing
- Reusing Cardora or Pokémon Treasure Supabase projects

## Why Firebase

Firebase documentation classifies most Authentication features as no-cost. The Spark plan does not require a billing account for no-cost products. Current documented Spark email quotas include 1,000 address-verification emails/day and 150 password-reset emails/day. Phone/SMS authentication is pay-as-you-go and is intentionally excluded.

Official references:
- https://firebase.google.com/docs/projects/billing/firebase-pricing-plans
- https://firebase.google.com/docs/auth/limits
- https://firebase.google.com/docs/auth/web/password-auth

## User setup required

1. Open https://console.firebase.google.com/
2. Create a new project named `kenji-ai-workspace` (or another available unique project ID).
3. Keep the project on the Spark plan. Do not link a billing account or upgrade to Blaze.
4. Add a Web app named `KENJI AI Workspace`.
5. In Authentication → Sign-in method, enable Email/Password.
6. In Authentication → Settings → Authorized domains, add the exact Vercel Preview hostname used for testing. Add the final custom domain only after it is purchased and configured.
7. Copy the Firebase web app configuration (apiKey, authDomain, projectId, appId, messagingSenderId if present). These web configuration values are public client identifiers, not service-account credentials.
8. Do not create or share service-account private keys. Never put private keys or Admin SDK credentials in browser code or GitHub.

## Implementation requirements before enabling forms

- Use the Firebase modular Web SDK.
- Initialize Firebase only when all required public config values are present; otherwise show a clear setup-incomplete message.
- Use createUserWithEmailAndPassword, updateProfile for display name, sendEmailVerification, signInWithEmailAndPassword, sendPasswordResetEmail, signOut, and onAuthStateChanged as appropriate.
- Require verified email before granting access to protected Workspace pages.
- Do not store passwords in localStorage, sessionStorage, cookies, logs, or analytics.
- Render user-provided strings with textContent, not innerHTML.
- Add form validation and accessible pending/success/error states.
- Do not expose account existence unnecessarily; preserve Firebase email-enumeration protections.
- Restrict authorized domains to actual app hosts.
- Test registration, verification, sign-in, wrong password, unverified account, reset email, sign-out, refresh/session persistence, and unauthorized-domain errors.
- Keep payment, Credits, billing, and API secret handling completely separate from authentication.

## Current project constraints

- All code changes must remain on `feature/kenji-ai-workspace-foundation`.
- Do not modify or merge into `main` without explicit approval.
- Do not connect to or modify Cardora or Pokémon Treasure Supabase projects.
- No real authentication is active until the dedicated Firebase project is created, configured, and tested.
