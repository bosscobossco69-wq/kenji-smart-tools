import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { billingDb } from "../lib/billing-environment.js";
import { adminEmailConfigured, notifyAdmin } from "../lib/admin-email-alerts.js";

let services;
async function getServices() {
  if (!services) services = (async () => {
    const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "null");
    if (!account || account.project_id !== process.env.FIREBASE_PROJECT_ID) throw Error("Firebase configuration mismatch.");
    const app = getApps()[0] || initializeApp({ credential: cert(account), projectId: account.project_id });
    return { auth: getAuth(app), db: billingDb(getFirestore(app)) };
  })();
  return services;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const configuredEmail = (process.env.WEBSITE_ADMIN_EMAIL || "").trim().toLowerCase();
  if (!configuredEmail || !adminEmailConfigured()) return res.status(503).json({ error: "Administrator email sending is not configured." });
  const header = req.headers.authorization || "";
  if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length > 8500) {
    return res.status(401).json({ error: "Administrator sign-in required." });
  }
  try {
    const { auth, db } = await getServices();
    const identity = await auth.verifyIdToken(header.slice(7), true);
    if (identity.email_verified !== true || identity.email?.toLowerCase() !== configuredEmail) {
      return res.status(403).json({ error: "Administrator account required." });
    }
    const currentUser = await auth.getUser(identity.uid);
    if (currentUser.disabled || !currentUser.emailVerified || currentUser.email?.toLowerCase() !== configuredEmail) {
      return res.status(403).json({ error: "Administrator verification failed." });
    }
    // One unique notification per UTC day: safe to click twice without sending twice.
    const day = new Date().toISOString().slice(0, 10);
    const result = await notifyAdmin(db, "admin_test", "smoke:" + day, {
      source: "admin_dashboard", environment: process.env.VERCEL_ENV === "production" ? "live" : "test"
    });
    return res.status(200).json({
      status: result.status, message: result.status === "sent"
        ? "Test email accepted by Resend; check provider delivery and inbox."
        : "Already processed or temporarily sending. Check email and notification records."
    });
  } catch (error) {
    if (error?.code?.startsWith?.("auth/")) return res.status(401).json({ error: "Sign in again." });
    console.warn("[admin-email-test] Test request failed.", { code: typeof error?.code === "string" ? error.code : "server_error" });
    return res.status(503).json({ error: "Test notification was not confirmed. Inspect delivery status before trying again." });
  }
}
