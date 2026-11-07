# KENJI AI Workspace — Authentication implementation status

## Firebase project
- Project: `kenji-ai-workspace`
- Plan: Spark (no-cost)
- Web app: KENJI AI Workspace Web
- Email/Password provider: enabled
- Email verification and password reset templates: default Firebase templates available
- Vercel Preview hostname: added to Authorized domains
- Google Analytics: disabled

## Code integration
- Firebase modular Web SDK loaded from Google's hosted SDK (no npm build step required).
- Registration creates a Firebase Authentication user, sets display name, sends verification email, then signs out.
- Login requires a verified email before redirecting to the account page.
- Unverified users can request another verification email from the login page.
- Password reset uses Firebase's reset email flow.
- Account page requires a signed-in, verified user and supports sign out.
- User-facing status messages use textContent; passwords are not stored by application code.
- Firebase client config is public web-app configuration; no service-account key or Admin SDK secret is included.

## Remaining verification before public launch
- [ ] Confirm the current Vercel Preview deployment includes these changes.
- [ ] Test registration with a dedicated test email address.
- [ ] Verify the email link returns to the authorized Vercel hostname.
- [ ] Test verified login, unverified login, resend verification, password reset and sign out.
- [ ] Check Firebase Authentication user list for the test account.
- [ ] Add production hostname after domain purchase.
- [ ] Review Firebase API key restrictions and authorized domains before public launch.
- [ ] Add abuse controls/rate limiting and privacy notice before broad public release.

## Not enabled
- Firestore/database, storage, payments, subscriptions, Credits and billing.
- SMS authentication and multi-factor SMS.
- No changes to Cardora or Pokémon Treasure Supabase projects.
- All code changes remain on `feature/kenji-ai-workspace-foundation`; do not merge to `main` without approval.
