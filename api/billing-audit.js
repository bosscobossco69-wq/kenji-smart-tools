// Read-only, owner-authenticated historical billing inventory. No billing writes.
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

function classify(data = {}) {
  const session = data.stripeCheckoutSessionId || data.checkoutSessionId || "";
  if (typeof session === "string" && session.startsWith("cs_test_")) return "test";
  if (typeof session === "string" && session.startsWith("cs_live_")) return "live_unverified";
  return "unknown";
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Vary", "Authorization");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed." });
  try {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length > 8200)
      return res.status(401).json({ error: "Sign in required." });
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
    if (!projectId || serviceAccount.project_id !== projectId)
      return res.status(503).json({ error: "Firebase configuration mismatch." });
    const app = getApps()[0] || initializeApp({ credential: cert(serviceAccount), projectId });
    const user = await getAuth(app).verifyIdToken(header.slice(7), true);
    if (!user.email_verified) return res.status(403).json({ error: "Verified email required." });
    const db = getFirestore(app), uid = user.uid;
    const oldRef = db.collection("users").doc(uid);
    const newRef = db.collection("billing_live_users").doc(uid).collection("billing_live").doc("current");
    const [oldBilling, newBilling, ledgerSnap] = await Promise.all([
      oldRef.collection("billing").doc("current").get(),
      newRef.get(),
      oldRef.collection("creditLedger").limit(500).get()
    ]);
    const entries = ledgerSnap.docs.map(doc => {
      const d = doc.data();
      const amount = Number(d.credits);
      return {
        kind: typeof d.type === "string" ? d.type.slice(0, 90) : "unknown",
        credits: Number.isSafeInteger(amount) ? amount : null,
        sourceMode: classify(d),
        status: typeof d.status === "string" ? d.status.slice(0, 40) : null,
        hasStripePaymentIntent: typeof d.stripePaymentIntentId === "string" && d.stripePaymentIntentId.length > 0
      };
    });
    const old = oldBilling.data() || {}, live = newBilling.data() || {};
    const safeBalance = v => Number.isSafeInteger(Number(v)) ? Number(v) : null;
    return res.status(200).json({
      environment: process.env.VERCEL_ENV === "production" ? "live" : "preview",
      oldBillingExists: oldBilling.exists,
      oldBalance: oldBilling.exists ? safeBalance(old.creditBalance) : null,
      oldCheckoutMode: classify(old),
      oldPaymentStatus: typeof old.checkoutPaymentStatus === "string" ? old.checkoutPaymentStatus.slice(0,40) : null,
      liveBillingExists: newBilling.exists,
      liveBalance: newBilling.exists ? safeBalance(live.creditBalance) : null,
      legacyReviewComplete: live.legacyReviewComplete === true,
      ledgerCountReturned: entries.length,
      ledgerPossiblyTruncated: ledgerSnap.size === 500,
      ledger: entries,
      warning: "Inventory only. Live payment and entitlement provenance must be verified before migration."
    });
  } catch (e) {
    console.error("[billing-audit] read failed", { code: typeof e?.code === "string" ? e.code : "unknown" });
    return res.status(500).json({ error: "Audit unavailable. Verify login and server configuration." });
  }
}
