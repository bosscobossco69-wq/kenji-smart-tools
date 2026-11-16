import { billingCollection, billingDb, assertStripeKey, assertStripeObject, assertLegacyReviewed } from "../lib/billing-environment.js";
import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const PACKS = {
  mini: { name: "Mini Pack", amount: 500, credits: 10000 },
  basic: { name: "Basic Pack", amount: 2000, credits: 50000 },
  pro: { name: "Pro Pack", amount: 3500, credits: 100000 },
  business: { name: "Business Pack", amount: 15000, credits: 500000 }
};

let servicesPromise;
function getServices() {
  if (!servicesPromise) {
    servicesPromise = (async () => {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      assertStripeKey(stripeKey, true);
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const rawAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (!stripeKey || !projectId || !rawAccount) throw new Error("Billing service is not configured.");
      let account;
      try { account = JSON.parse(rawAccount); } catch { throw new Error("Firebase service account is invalid."); }
      if (account.project_id !== projectId) throw new Error("Firebase project mismatch.");
      const app = getApps()[0] || initializeApp({ credential: cert(account), projectId });
      return { stripe: new Stripe(stripeKey), auth: getAuth(app), db: billingDb(getFirestore(app)) };
    })();
  }
  return servicesPromise;
}

function siteBase(req) {
  const configured = process.env.SITE_URL;
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "https:" || url.username || url.password || url.port) {
      throw new Error("SITE_URL must be a valid HTTPS origin.");
    }
    return url.origin;
  }
  const host = req.headers["x-forwarded-host"];
  if (typeof host !== "string" || req.headers["x-forwarded-proto"] !== "https") {
    throw new Error("Secure site origin is not configured.");
  }
  const allowed = (process.env.ALLOWED_CHECKOUT_HOSTS || "").split(",").map(v => v.trim()).filter(Boolean);
  if (!allowed.includes(host)) throw new Error("Checkout host is not allowlisted.");
  return `https://${host}`;
}

async function verifiedCreditCustomerId(stripe, customerId, uid) {
  if (customerId == null) return null;
  if (typeof customerId !== "string" || !customerId.startsWith("cus_")) {
    throw new Error("Stripe customer ownership review is required.");
  }
  const customer = await stripe.customers.retrieve(customerId);
  assertStripeObject(customer);
  if (customer.deleted || customer.metadata?.firebaseUID !== uid) {
    throw new Error("Stripe customer ownership review is required.");
  }
  return customer.id;
}

// Use the same verified Firebase UID ownership policy as subscription Checkout.
// A first-time Credits buyer must also get a linked Stripe customer, otherwise
// a later subscription could be blocked by an email-only historical customer.
async function ensureCreditCustomer({ stripe, billingRef, billingData, user }) {
  const storedId = billingData?.stripeCustomerId ?? null;
  if (storedId != null) {
    return verifiedCreditCustomerId(stripe, storedId, user.uid);
  }
  let customer = null;
  let sawUnownedMatch = false;
  let startingAfter;
  while (true) {
    const page = await stripe.customers.list({
      email: user.email,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {})
    });
    for (const candidate of page.data) {
      assertStripeObject(candidate);
      if (candidate.deleted) continue;
      if (candidate.metadata?.firebaseUID === user.uid) {
        customer = candidate;
        break;
      }
      sawUnownedMatch = true;
    }
    if (customer || !page.has_more || !page.data.length) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  if (!customer && sawUnownedMatch) {
    throw new Error("Stripe customer ownership review is required.");
  }
  if (!customer) {
    customer = await stripe.customers.create({
      email: user.email,
      metadata: { firebaseUID: user.uid }
    }, { idempotencyKey: `kenji-customer-${user.uid}` });
  }
  assertStripeObject(customer);
  if (customer.deleted || customer.metadata?.firebaseUID !== user.uid) {
    throw new Error("Stripe customer ownership review is required.");
  }
  await billingRef.set({
    stripeCustomerId: customer.id,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return customer.id;
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

    await assertLegacyReviewed(db, user.uid);

    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const packId = typeof body.packId === "string" ? body.packId : "";
    const pack = Object.hasOwn(PACKS, packId) ? PACKS[packId] : null;
    if (!pack) return res.status(400).json({ error: "Choose a valid Credits pack." });

    const base = siteBase(req);
    const orderId = randomUUID();
    const orderRef = db.collection("billingOrders").doc(orderId);
    const billingRef = db.collection("users").doc(user.uid).collection(billingCollection()).doc("current");
    const billingSnap = await billingRef.get();
    const customerId = await ensureCreditCustomer({
      stripe, billingRef, billingData: billingSnap.exists ? billingSnap.data() : {}, user
    });
    const metadata = {
      firebaseUID: user.uid,
      orderId,
      purchaseType: "credit_pack",
      packId,
      credits: String(pack.credits)
    };

    await orderRef.create({
      orderId,
      uid: user.uid,
      type: "credit_pack",
      packId,
      credits: pack.credits,
      amount: pack.amount,
      currency: "usd",
      status: "checkout_pending",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    try {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer: customerId,
        client_reference_id: user.uid,
        line_items: [{
          price_data: {
            currency: "usd",
            unit_amount: pack.amount,
            product_data: {
              name: pack.name,
              description: `${pack.credits.toLocaleString("en-US")} KENJI AI Credits · one-time purchase`
            }
          },
          quantity: 1
        }],
        success_url: `${base}/workspace/billing.html?checkout=credits-success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/workspace/billing.html?checkout=cancelled`,
        metadata,
        payment_intent_data: { metadata }
      }, { idempotencyKey: `kenji-credit-pack-${orderId}` });

      assertStripeObject(session);
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
    if (error?.code === "billing_legacy_review_required") return res.status(409).json({ error: error.message });
    if (error?.message === "Stripe customer ownership review is required.") {
      return res.status(409).json({ error: "Billing account ownership needs review. Contact billing support before checkout." });
    }
    const message = error?.message || "";
    const status = message.includes("not configured") || message.includes("disabled") ||
      message.includes("requires a Stripe Test Mode") || message.includes("not allowlisted") ? 503 : 500;
    return res.status(status).json({
      error: status === 503 ? message : "Could not create a secure Credits checkout session."
    });
  }
}
