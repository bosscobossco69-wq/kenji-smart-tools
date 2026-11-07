# Trial backend deployment prerequisites

Do not activate the public trial until all items below are completed and tested.

## 1. Server credentials
- Create or use a dedicated service identity for the existing Firebase project `kenji-ai-workspace`.
- Grant only the Firebase Authentication user-read and Firestore read/write permissions required by the server endpoints.
- Generate/download credentials only in Google Cloud Console. Keep the private key secret.
- Add the entire service-account JSON as a Vercel server-side environment variable named `FIREBASE_SERVICE_ACCOUNT_JSON` for Preview first, then Production after testing.
- Add `FIREBASE_PROJECT_ID=kenji-ai-workspace` to Vercel server-side environment variables.
- Never commit the JSON key, paste it into chat, expose it as a `NEXT_PUBLIC_`/browser variable, or put it in static files.

## 2. Firestore rules
- The repository includes `firestore.rules` and `firebase.json`.
- Publish these rules to the existing `(default)` database only after reviewing the target Firebase project and rules in the Firebase Console or Firebase CLI.
- The rules allow a signed-in user to read only their own `users/{uid}` document. All client writes and all other client reads are denied.
- Firebase Admin SDK calls from trusted server functions bypass Firestore client security rules; protect server credentials carefully.

## 3. Vercel deployment
- `package.json` installs `firebase-admin` for server functions and sets ES module mode.
- Deploy the feature branch to a Preview deployment first.
- Set the environment variables for Preview and redeploy.
- Confirm the Firebase service-account project ID is exactly `kenji-ai-workspace`.

## 4. End-to-end tests required
- Verified user: POST `/api/trial-status` returns one trial window of exactly 72 hours.
- Repeated trial-status calls return the original timestamps and do not extend the trial.
- Unverified user and unauthenticated request are rejected.
- AI generation is rejected if there is no trial record, if the trial expired, or if no active subscription exists.
- A valid active trial is allowed; a verified active subscription is allowed.
- A client cannot write `trialEndsAt`, `subscriptionStatus`, `planId`, payment status, or Credits.
- No payment webhook or payment activation is implemented by this change.

## Current limitation
The endpoints fail closed until the server credentials are configured and the Preview deployment is tested. This commit does not create or activate any customer trial automatically. The AI page requires a verified Firebase session.