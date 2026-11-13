import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const PLAN_PRICE_ENV = {
  lite: { monthly: "STRIPE_PRICE_LITE_MONTHLY", yearly: "STRIPE_PRICE_LITE_YEARLY" },
  pro: { monthly: "STRIPE_PRICE_PRO_MONTHLY", yearly: "STRIPE_PRICE_PRO_YEARLY" },
  pro_plus: { monthly: "STRIPE_PRICE_PRO_PLUS_MONTHLY", yearly: "STRIPE_PRICE_PRO_PLUS_YEARLY" },
  ultra: { monthly: "STRIPE_PRICE_ULTRA_MONTHLY", yearly: "STRIPE_PRICE_ULTRA_YEARLY" }
};

let servicesPromise;
function getServices() {
  if (!servicesPromise) {
    servicesPromise = (async () => {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const rawAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (!stripeKey || !projectId || !rawAccount) throw new Error("Billing service is not configured.");
      if (process.env.VERCEL_ENV === "production") {
        if (!stripeKey.startsWith("sk_live_") || process.env.STRIPE_LIVE_CHECKOUT_ENABLED !== "true") {
          throw new Error("Live Stripe checkout is disabled.");
        }
      } else if (!stripeKey.startsWith("sk_test_")) {
        throw new Error("Preview checkout requires a Stripe Test Mode key.");
      }
      let account;
      try { account = JSON.parse(rawAccount); } catch { throw new Error("Firebase service account is invalid."); }
      if (account.project_id !== projectId) throw new Error("Firebase project mismatch.");
      const app = getApps()[0] || initializeApp({ credential: cert(account), projectId });
      return { stripe: new Stripe(stripeKey), auth: getAuth(app), db: getFirestore(app) };
    })();
  }
  return servicesPromise;
}

function siteBase(req) {
  const configured = process.env.SITE_URL;
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "https:") throw new Error("SITE_URL must use HTTPS.");
    return url.origin;
  }
  const host = req.headers["x-forwarded-host"];
  const proto = req.headers["x-forwarded-proto"];
  if (typeof host !== "string" || proto !== "https") throw new Error("Secure site origin is not configured.");
  const allowed = (process.env.ALLOWED_CHECKOUT_HOSTS || "").split(",").map(v => v.trim()).filter(Boolean);
  if (!allowed.includes(host)) throw new Error("Checkout host is not allowlisted.");
  return `https://${host}`;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const authorization = req.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Sign in is required." });
    }
    const token = authorization.slice(7);
    if (!token || token.length > 8192) return res.status(401).json({ error: "Invalid authentication token." });

    const { stripe, auth, db } = await getServices();
    const user = await auth.verifyIdToken(token, true);
    if (!user.email || user.email_verified !== true) {
      return res.status(403).json({ error: "A verified email address is required." });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const planId = typeof body.planId === "string" ? body.planId : "";
    const interval = typeof body.interval === "string" ? body.interval : "";
    if (!Object.hasOwn(PLAN_PRICE_ENV, planId) || !["monthly", "yearly"].includes(interval)) {
      return res.status(400).json({ error: "Choose a valid plan and billing period." });
    }

    const priceEnv = PLAN_PRICE_ENV[planId][interval];
    const priceId = process.env[priceEnv];
    if (!priceId || !priceId.startsWith("price_")) {
      return res.status(503).json({ error: "This plan's Stripe price is not configured yet." });
    }

    const price = await stripe.prices.retrieve(priceId);
    const expectedInterval = interval === "yearly" ? "year" : "month";
    if (!price.active || price.currency !== "usd" || price.type !== "recurring" ||
        price.recurring?.interval !== expectedInterval || price.recurring?.interval_count !== 1) {
      return res.status(409).json({ error: "The configured Stripe price does not match this plan and billing period." });
    }

    const base = siteBase(req);
    const orderId = randomUUID();
    const orderRef = db.collection("billingOrders").doc(orderId);
    const billingRef = db.collection("users").doc(user.uid).collection("billing").doc("current");
    const billingSnap = await billingRef.get();
    const customerId = billingSnap.exists ? billingSnap.data()?.stripeCustomerId : null;

    await orderRef.create({
      orderId,
      uid: user.uid,
      planId,
      interval,
      priceId,
      currency: price.currency,
      amount: price.unit_amount,
      status: "checkout_pending",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    try {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: typeof customerId === "string" ? customerId : undefined,
        customer_email: typeof customerId === "string" ? undefined : user.email,
        client_reference_id: user.uid,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${base}/workspace/billing.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/workspace/billing.html?checkout=cancelled`,
        metadata: { firebaseUID: user.uid, orderId, planId, interval },
        subscription_data: { metadata: { firebaseUID: user.uid, orderId, planId, interval } }
      }, { idempotencyKey: `kenji-checkout-${orderId}` });

      await orderRef.set({
        stripeCheckoutSessionId: session.id,
        status: "checkout_created",
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return res.status(200).json({ url: session.url });
    } catch (error) {
      await orderRef.set({
        status: "checkout_creation_failed",
        failureCode: typeof error?.code === "string" ? error.code : "stripe_error",
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      throw error;
    }
  } catch (error) {
    const status = error?.message === "This plan's Stripe price is not configured yet." ? 503 : 500;
    return res.status(status).json({ error: status === 503 ? error.message : "Could not create a secure checkout session." });
  }
}
