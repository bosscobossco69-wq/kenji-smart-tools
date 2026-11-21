import { timingSafeEqual } from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { adminEmailConfigured, deliverAdminAlert } from "../lib/admin-email-alerts.js";
import { billingDb } from "../lib/billing-environment.js";

// Vercel production Cron invokes this GET route with Authorization: Bearer CRON_SECRET.
// No unauthenticated bulk sending, replay or adjustment endpoint is exposed.
function authorized(header, secret) {
  if (typeof secret !== "string" || secret.length < 20 ||
      typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }
  if (!authorized(req.headers.authorization, process.env.CRON_SECRET)) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  if (!adminEmailConfigured()) return res.status(200).json({ configured: false, sent: 0 });
  try {
    const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "null");
    if (!account || account.project_id !== process.env.FIREBASE_PROJECT_ID) throw Error("Firebase project mismatch");
    const app = getApps()[0] || initializeApp({
      credential: cert(account), projectId: account.project_id
    });
    const db = billingDb(getFirestore(app));
    const pending = await db.collection("adminEmailAlerts").where("status", "==", "pending").limit(8).get();
    let sent = 0, failed = 0;
    // Avoid burst rate limits on a free email provider.
    for (const doc of pending.docs) {
      try {
        const result = await deliverAdminAlert(db, doc.id);
        if (result.status === "sent") sent++;
      } catch { failed++; }
    }
    return res.status(200).json({ configured: true, checked: pending.size, sent, failed });
  } catch {
    console.error("[kenji-admin-alert-retry] Failed to read or retry notification queue.");
    return res.status(503).json({ error: "Notification retry is temporarily unavailable." });
  }
}
