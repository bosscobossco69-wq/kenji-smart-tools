import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { billingDb } from "../lib/billing-environment.js";

// Record explicit choices only. This endpoint never sends mail.
// Existing users are NOT opted in automatically.
let servicesPromise;
function services() {
  if (!servicesPromise) servicesPromise = (async () => {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const account = JSON.parse(raw || "null");
    if (!account || !account.project_id || account.project_id !== process.env.FIREBASE_PROJECT_ID) {
      throw new Error("Firebase project configuration mismatch.");
    }
    const app = getApps()[0] || initializeApp({ credential: cert(account), projectId: account.project_id });
    return { auth: getAuth(app), db: billingDb(getFirestore(app)) };
  })();
  return servicesPromise;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ") || authorization.length > 8500) {
    return res.status(401).json({ error: "Sign in required." });
  }
  if (typeof req.body?.marketingConsent !== "boolean") {
    return res.status(400).json({ error: "A true or false consent choice is required." });
  }
  try {
    const { auth, db } = await services();
    const identity = await auth.verifyIdToken(authorization.slice(7), true);
    const user = await auth.getUser(identity.uid);
    if (!user.email || user.disabled) return res.status(403).json({ error: "Account unavailable." });
    // Consent given while registering is retained but never eligible for marketing
    // until Firebase confirms the email address.
    const optedIn = req.body.marketingConsent === true;
    const doc = db.collection("marketingPreferences").doc(identity.uid);
    const prev = await doc.get();
    const old = prev.data() || {};
    await doc.set({
      uid: identity.uid,
      email: user.email,
      marketingConsent: optedIn,
      consentSource: "workspace_signup",
      consentVersion: "2026-11-22-v1",
      consentUpdatedAt: FieldValue.serverTimestamp(),
      ...(optedIn ? { consentedAt: FieldValue.serverTimestamp(), unsubscribedAt: FieldValue.delete() } :
        { unsubscribedAt: FieldValue.serverTimestamp(), consentedAt: FieldValue.delete() }),
      // Any changed preference invalidates old follow-up scheduling.
      followupState: old.marketingConsent === optedIn ? (old.followupState || "not_scheduled") : "not_scheduled",
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return res.status(200).json({ ok: true, marketingConsent: optedIn, emailVerified: user.emailVerified });
  } catch (error) {
    console.error("[marketing-preferences] Unable to save consent:", error?.message || "unknown");
    return res.status(500).json({ error: "Could not save email preferences." });
  }
}
