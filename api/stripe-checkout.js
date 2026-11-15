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

const PLAN_PRICE_AMOUNTS = {
  lite: { monthly: 1000, yearly: 10000 },
  pro: { monthly: 2000, yearly: 20000 },
  pro_plus: { monthly: 6000, yearly: 60000 },
  ultra: { monthly: 20000, yearly: 200000 }
};

const ACTIVE_SUBSCRIPTION_STATUSES = new Set([
  "active", "trialing", "past_due", "unpaid", "incomplete", "paused"
]);
const CHECKOUT_SESSION_TTL_SECONDS = 23 * 60 * 60;
const CHECKOUT_LOCK_GRACE_MS = 2 * 60 * 1000;

let servicesPromise;
function getServices() {
  if (!servicesPromise) {
    servicesPromise = (async () => {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const rawAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (!stripeKey || !projectId || !rawAccount) throw new Error("Billing service is not configured.");
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
    const expectedAmount = PLAN_PRICE_AMOUNTS[planId][interval];
    if (!price.active || price.currency !== "usd" || price.type !== "recurring" ||
        price.recurring?.interval !== expectedInterval || price.recurring?.interval_count !== 1 ||
        price.unit_amount !== expectedAmount) {
      return res.status(409).json({ error: "The configured Stripe price does not match this plan and billing period." });
    }

    const base = siteBase(req);
    const billingRef = db.collection("users").doc(user.uid).collection("billing").doc("current");
    const billingSnap = await billingRef.get();
    const billingData = billingSnap.exists ? billingSnap.data() : {};
    const customerId = billingData.stripeCustomerId || null;

    // Fail closed when the account already has a non-terminal subscription.
    if (billingData.active === true ||
        ACTIVE_SUBSCRIPTION_STATUSES.has(billingData.status)) {
      return res.status(409).json({
        error: "This account already has a subscription. Manage the current plan before starting another checkout."
      });
    }
    if (typeof billingData.stripeSubscriptionId === "string") {
      try {
        const storedSubscription = await stripe.subscriptions.retrieve(billingData.stripeSubscriptionId);
        if (ACTIVE_SUBSCRIPTION_STATUSES.has(storedSubscription.status)) {
          return res.status(409).json({
            error: "This account already has a subscription. Manage the current plan before starting another checkout."
          });
        }
      } catch (error) {
        const notFound = error?.statusCode === 404 || error?.raw?.statusCode === 404 ||
          error?.code === "resource_missing";
        if (!notFound) throw error;
      }
    }

    if (typeof customerId === "string") {
      let startingAfter;
      while (true) {
        const page = await stripe.subscriptions.list({
          customer: customerId,
          status: "all",
          limit: 100,
          ...(startingAfter ? { starting_after: startingAfter } : {})
        });
        const existingSubscription = page.data.find(subscription =>
          ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status)
        );
        if (existingSubscription) {
          return res.status(409).json({
            error: "This account already has a subscription. Manage the current plan before starting another checkout."
          });
        }
        if (!page.has_more || page.data.length === 0) break;
        startingAfter = page.data[page.data.length - 1].id;
      }
    }

    const clearPendingCheckout = async expectedOrderId => {
      await db.runTransaction(async transaction => {
        const currentSnap = await transaction.get(billingRef);
        const pending = currentSnap.exists ? currentSnap.data()?.pendingSubscriptionCheckout : null;
        if (pending?.orderId === expectedOrderId) {
          transaction.set(billingRef, {
            pendingSubscriptionCheckout: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
        }
      });
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      const proposedOrderId = randomUUID();
      const proposedNowMs = Date.now();
      const proposedExpiresAt = Math.floor(proposedNowMs / 1000) + CHECKOUT_SESSION_TTL_SECONDS;
      let reservation = null;
      let reservationError = null;

      await db.runTransaction(async transaction => {
        const currentSnap = await transaction.get(billingRef);
        const current = currentSnap.exists ? currentSnap.data() : {};
        if (current.active === true || ACTIVE_SUBSCRIPTION_STATUSES.has(current.status)) {
          reservationError = "subscription";
          return;
        }

        const pending = current.pendingSubscriptionCheckout;
        if (pending && Number(pending.expiresAtMs || 0) > proposedNowMs) {
          if (pending.planId !== planId || pending.interval !== interval || pending.priceId !== priceId) {
            reservationError = "pending";
            return;
          }
          if (typeof pending.orderId !== "string" || !Number.isFinite(Number(pending.stripeExpiresAt))) {
            throw new Error("Existing Checkout reservation is invalid.");
          }
          const existingOrderRef = db.collection("billingOrders").doc(pending.orderId);
          const existingOrderSnap = await transaction.get(existingOrderRef);
          if (!existingOrderSnap.exists) throw new Error("Existing Checkout order was not found.");
          const existingOrder = existingOrderSnap.data();
          if (existingOrder.uid !== user.uid || existingOrder.planId !== planId ||
              existingOrder.interval !== interval || existingOrder.priceId !== priceId) {
            throw new Error("Existing Checkout order does not match this account and plan.");
          }
          reservation = {
            orderId: pending.orderId,
            sessionId: typeof pending.sessionId === "string" ? pending.sessionId : null,
            stripeExpiresAt: Number(pending.stripeExpiresAt)
          };
          return;
        }

        const orderRef = db.collection("billingOrders").doc(proposedOrderId);
        const orderSnap = await transaction.get(orderRef);
        if (orderSnap.exists) throw new Error("New Checkout order ID already exists.");
        transaction.create(orderRef, {
          orderId: proposedOrderId,
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
        transaction.set(billingRef, {
          pendingSubscriptionCheckout: {
            orderId: proposedOrderId,
            planId,
            interval,
            priceId,
            sessionId: null,
            stripeExpiresAt: proposedExpiresAt,
            expiresAtMs: proposedExpiresAt * 1000 + CHECKOUT_LOCK_GRACE_MS,
            createdAtMs: proposedNowMs
          },
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        reservation = {
          orderId: proposedOrderId,
          sessionId: null,
          stripeExpiresAt: proposedExpiresAt
        };
      });

      if (reservationError === "subscription") {
        return res.status(409).json({
          error: "This account already has a subscription. Manage the current plan before starting another checkout."
        });
      }
      if (reservationError === "pending") {
        return res.status(409).json({
          error: "A Checkout session is already open for this account. Complete or wait for it to expire before choosing another plan."
        });
      }
      if (!reservation) throw new Error("Could not reserve a Checkout order.");

      const orderRef = db.collection("billingOrders").doc(reservation.orderId);
      if (reservation.sessionId) {
        const existingSession = await stripe.checkout.sessions.retrieve(reservation.sessionId);
        if (existingSession.status === "open" && typeof existingSession.url === "string") {
          return res.status(200).json({ url: existingSession.url, reused: true });
        }
        if (existingSession.status === "complete") {
          return res.status(409).json({
            error: "This Checkout has already completed. Refresh your account while the subscription is being confirmed."
          });
        }
        await clearPendingCheckout(reservation.orderId);
        await orderRef.set({
          status: "checkout_expired",
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        continue;
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      if (reservation.stripeExpiresAt - nowSeconds < 30 * 60) {
        await clearPendingCheckout(reservation.orderId);
        await orderRef.set({
          status: "checkout_expired",
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        continue;
      }

      try {
        const session = await stripe.checkout.sessions.create({
          mode: "subscription",
          customer: typeof customerId === "string" ? customerId : undefined,
          customer_email: typeof customerId === "string" ? undefined : user.email,
          client_reference_id: user.uid,
          line_items: [{ price: priceId, quantity: 1 }],
          expires_at: reservation.stripeExpiresAt,
          success_url: `${base}/workspace/billing.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${base}/workspace/billing.html?checkout=cancelled`,
          metadata: { firebaseUID: user.uid, orderId: reservation.orderId, planId, interval },
          subscription_data: { metadata: { firebaseUID: user.uid, orderId: reservation.orderId, planId, interval } }
        }, { idempotencyKey: `kenji-checkout-${reservation.orderId}` });

        await db.runTransaction(async transaction => {
          const currentSnap = await transaction.get(billingRef);
          const pending = currentSnap.exists ? currentSnap.data()?.pendingSubscriptionCheckout : null;
          if (pending?.orderId !== reservation.orderId) {
            throw new Error("Checkout reservation changed while creating the Stripe session.");
          }
          transaction.set(billingRef, {
            pendingSubscriptionCheckout: { ...pending, sessionId: session.id },
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
        });
        await orderRef.set({
          stripeCheckoutSessionId: session.id,
          status: "checkout_created",
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        return res.status(200).json({ url: session.url, reused: false });
      } catch (error) {
        await orderRef.set({
          status: "checkout_creation_failed",
          failureCode: typeof error?.code === "string" ? error.code : "stripe_error",
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        throw error;
      }
    }

    return res.status(409).json({
      error: "A previous Checkout session expired while being retried. Please try again."
    });

  } catch (error) {
    const status = error?.message === "This plan's Stripe price is not configured yet." ? 503 : 500;
    return res.status(status).json({ error: status === 503 ? error.message : "Could not create a secure checkout session." });
  }
}
