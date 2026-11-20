import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { assertStripeKey, assertStripeObject, billingDb } from "../lib/billing-environment.js";

const PACKAGES = Object.freeze({
  basic: { name: "Basic Business Website", amount: 9900, pages: 1 },
  professional: { name: "Professional Business Website", amount: 24900, pages: 5 },
  premium: { name: "Premium Business Website", amount: 49900, pages: 10 }
});
let services;
function getServices() {
  if (!services) services = (async () => {
    assertStripeKey(process.env.STRIPE_SECRET_KEY, true);
    const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "null");
    if (!account || account.project_id !== process.env.FIREBASE_PROJECT_ID) throw new Error("Service not configured");
    const app = getApps()[0] || initializeApp({ credential: cert(account), projectId: account.project_id });
    return { stripe: new Stripe(process.env.STRIPE_SECRET_KEY), db: billingDb(getFirestore(app)) };
  })();
  return services;
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const packageId = typeof body.packageId === "string" ? body.packageId : "";
  const selected = Object.hasOwn(PACKAGES, packageId) ? PACKAGES[packageId] : null;
  if (!selected) return res.status(400).json({ error: "Choose a valid website package." });
  let orderRef;
  try {
    const base = new URL(process.env.SITE_URL || "");
    if (base.protocol !== "https:" || base.host !== "kenjismarttools.com") throw new Error("Checkout origin unavailable");
    const { stripe, db } = await getServices();
    const orderId = randomUUID();
    orderRef = db.collection("websiteOrders").doc(orderId);
    await orderRef.create({ orderId, packageId, amount: selected.amount, currency: "usd", pages: selected.pages,
      status: "checkout_pending", createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_creation: "always",
      customer_email: undefined,
      billing_address_collection: "auto",
      line_items: [{ price_data: { currency: "usd", unit_amount: selected.amount,
        product_data: { name: selected.name, description: "Website design service. Project onboarding begins after payment; completed website delivered later per agreed scope." } }, quantity: 1 }],
      metadata: { purchaseType: "website_service", websiteOrderId: orderId, websitePackageId: packageId },
      payment_intent_data: { metadata: { purchaseType: "website_service", websiteOrderId: orderId, websitePackageId: packageId } },
      success_url: base.origin + "/website-order.html?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: base.origin + "/#web-services",
      submit_type: "pay"
    }, { idempotencyKey: "kenji-website-" + orderId });
    assertStripeObject(session);
    await orderRef.set({ stripeCheckoutSessionId: session.id, status: "checkout_created",
      updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    if (orderRef) await orderRef.set({ status: "checkout_creation_failed", updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
    console.error("[website-checkout]", { category: "checkout_failed", code: typeof e?.code === "string" ? e.code : "unknown" });
    return res.status(503).json({ error: "Secure website checkout is temporarily unavailable. Please contact support." });
  }
}
