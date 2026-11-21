import { notifyAdminSafely, errorAlertReference } from "../lib/admin-email-alerts.js";
import Stripe from "stripe";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { assertStripeKey, assertStripeObject, billingDb } from "../lib/billing-environment.js";

const PACKAGES = { basic: { amount: 9900, name: "Basic", pages: 1 },
  professional: { amount: 24900, name: "Professional", pages: 5 },
  premium: { amount: 49900, name: "Premium", pages: 10 } };
let services;
async function getServices() {
  if (!services) services = (async () => {
    assertStripeKey(process.env.STRIPE_SECRET_KEY);
    const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "null");
    if (!account || account.project_id !== process.env.FIREBASE_PROJECT_ID) throw new Error("Missing configuration");
    const app = getApps()[0] || initializeApp({ credential: cert(account), projectId: account.project_id });
    return { stripe: new Stripe(process.env.STRIPE_SECRET_KEY), db: billingDb(getFirestore(app)) };
  })();
  return services;
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });
  const sessionId = req.method === "GET" ? req.query.session_id : req.body?.sessionId;
  if (typeof sessionId !== "string" || !/^cs_(test_|live_)[a-zA-Z0-9]{10,}$/.test(sessionId)) return res.status(400).json({ error: "Invalid order reference." });
  try {
    const { stripe, db } = await getServices();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    assertStripeObject(session);
    const orderId = session.metadata?.websiteOrderId;
    const packageId = session.metadata?.websitePackageId;
    const selected = Object.hasOwn(PACKAGES, packageId) ? PACKAGES[packageId] : null;
    if (session.metadata?.purchaseType !== "website_service" || !orderId || !selected ||
      session.mode !== "payment" || session.currency !== "usd" || session.amount_total !== selected.amount) {
      return res.status(404).json({ error: "Website service order not found." });
    }
    const ref = db.collection("websiteOrders").doc(orderId);
    const existing = await ref.get();
    if (!existing.exists || existing.data()?.packageId !== packageId ||
      existing.data()?.amount !== selected.amount ||
      (existing.data()?.stripeCheckoutSessionId && existing.data()?.stripeCheckoutSessionId !== session.id)) {
      return res.status(409).json({ error: "Order verification needs support review." });
    }
    const paid = session.payment_status === "paid";
    if (paid) await db.runTransaction(async tx => {
      const snap = await tx.get(ref); const data = snap.data();
      if (!data || data.packageId !== packageId || data.amount !== selected.amount ||
        (data.stripeCheckoutSessionId && data.stripeCheckoutSessionId !== session.id)) throw new Error("Order mismatch");
      if (data.status === "checkout_pending" || data.status === "checkout_created" || data.status === "checkout_creation_failed") {
        tx.set(ref, { status: "paid", stripeCheckoutSessionId: session.id, stripePaymentIntentId: session.payment_intent,
          buyerEmail: session.customer_details?.email || null, paidAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
    });
    // Also notify when this verification endpoint confirms payment before a webhook arrives.
    // Same order ID guarantees deduplication with the Stripe webhook notification.
    if (paid) await notifyAdminSafely(db, "website_paid", orderId, {
      orderId, package: packageId, amountUsd: selected.amount / 100,
      environment: process.env.VERCEL_ENV === "production" ? "live" : "test"
    });
    if (req.method === "POST") {
      if (!paid) return res.status(409).json({ error: "Payment has not been confirmed." });
      const { businessName, projectDetails, contactEmail } = req.body || {};
      if (typeof businessName !== "string" || businessName.trim().length < 2 || businessName.length > 150 ||
          typeof projectDetails !== "string" || projectDetails.trim().length < 10 || projectDetails.length > 5000 ||
          typeof contactEmail !== "string" || contactEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
        return res.status(400).json({ error: "Provide business name, a valid email and project requirements." });
      }
      await ref.set({ onboarding: { businessName: businessName.trim(), projectDetails: projectDetails.trim(),
        contactEmail: contactEmail.trim() }, onboardingSubmittedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await notifyAdminSafely(db, "website_onboarding", orderId, {
        orderId, package: packageId, environment: process.env.VERCEL_ENV === "production" ? "live" : "test"
      });
      return res.status(200).json({ paid: true, package: selected.name, onboardingSubmitted: true });
    }
    const latest = (await ref.get()).data() || {};
    return res.status(200).json({ paid, package: selected.name, amount: selected.amount, currency: "usd", pages: selected.pages,
      onboardingSubmitted: Boolean(latest.onboardingSubmittedAt), status: paid ? "paid" : "pending" });
  } catch (e) {
    console.error("[website-order]", { code: typeof e?.code === "string" ? e.code : "failed" });
    try { const { db } = await getServices(); await notifyAdminSafely(db, "system_failure", errorAlertReference("website_order", "handler"), {
      source: "website_order", stage: "handler", environment: process.env.VERCEL_ENV === "production" ? "live" : "test"
    }); } catch {}
    return res.status(503).json({ error: "Unable to verify order right now. Please try again or contact support." });
  }
}
