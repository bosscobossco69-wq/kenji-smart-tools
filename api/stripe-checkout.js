import { billingCollection, billingDb, assertStripeKey, assertStripeObject, assertLegacyReviewed } from "../lib/billing-environment.js";
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

function isMissingStripeResource(error) {
  return error?.statusCode === 404 || error?.raw?.statusCode === 404 ||
    error?.code === "resource_missing";
}

async function ensureStripeCustomer({ stripe, billingRef, billingData, user }) {
  let customer = null;
  if (typeof billingData.stripeCustomerId === "string") {
    try {
      customer = await stripe.customers.retrieve(billingData.stripeCustomerId);
    } catch (error) {
      if (!isMissingStripeResource(error)) throw error;
    }
  }

  if (!customer || customer.deleted) {
    const matches = [];
    let startingAfter;
    while (true) {
      const page = await stripe.customers.list({
        email: user.email,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {})
      });
      matches.push(...page.data);
      const owned = page.data.find(item => item.metadata?.firebaseUID === user.uid);
      if (owned) {
        customer = owned;
        break;
      }
      if (!page.has_more || page.data.length === 0) break;
      startingAfter = page.data[page.data.length - 1].id;
    }
    if (!customer && matches.length === 1) customer = matches[0];
    if (!customer && matches.length > 1) {
      throw new Error("Multiple Stripe customers match this account; manual billing review is required.");
    }
  }

  if (!customer) {
    customer = await stripe.customers.create({
      email: user.email,
      metadata: { firebaseUID: user.uid }
    }, { idempotencyKey: `kenji-customer-${user.uid}` });
  }
  if (customer.deleted) throw new Error("The Stripe customer is unavailable.");
  const linkedUid = customer.metadata?.firebaseUID;
  if (linkedUid && linkedUid !== user.uid) {
    throw new Error("The Stripe customer is linked to another account.");
  }
  if (!linkedUid) {
    customer = await stripe.customers.update(customer.id, {
      metadata: { ...(customer.metadata || {}), firebaseUID: user.uid }
    });
  }

  await billingRef.set({
    stripeCustomerId: customer.id,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return customer.id;
}

async function findActiveSubscription(stripe, customerId) {
  if (typeof customerId !== "string") return null;
  let startingAfter;
  while (true) {
    const page = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {})
    });
    const active = page.data.find(subscription =>
      ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status)
    );
    if (active) return active;
    if (!page.has_more || page.data.length === 0) return null;
    startingAfter = page.data[page.data.length - 1].id;
  }
}

async function findCheckoutSessionByOrder(stripe, customerId, orderId) {
  let startingAfter;
  while (true) {
    const page = await stripe.checkout.sessions.list({
      customer: customerId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {})
    });
    const match = page.data.find(session =>
      session.mode === "subscription" && session.metadata?.orderId === orderId
    );
    if (match) return match;
    if (!page.has_more || page.data.length === 0) return null;
    startingAfter = page.data[page.data.length - 1].id;
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  if (process.env.STRIPE_SUBSCRIPTIONS_ENABLED !== "true") {
    return res.status(503).json({ error: "New subscriptions are not available. One-time Credits packs remain available." });
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
    assertStripeObject(price);
    const expectedInterval = interval === "yearly" ? "year" : "month";
    const expectedAmount = PLAN_PRICE_AMOUNTS[planId][interval];
    if (!price.active || price.currency !== "usd" || price.type !== "recurring" ||
        price.recurring?.interval !== expectedInterval || price.recurring?.interval_count !== 1 ||
        price.unit_amount !== expectedAmount) {
      return res.status(409).json({ error: "The configured Stripe price does not match this plan and billing period." });
    }

    const base = siteBase(req);
    const billingRef = db.collection("users").doc(user.uid).collection(billingCollection()).doc("current");
    const billingSnap = await billingRef.get();
    const billingData = billingSnap.exists ? billingSnap.data() : {};
    const customerId = await ensureStripeCustomer({ stripe, billingRef, billingData, user });

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

    const existingSubscription = await findActiveSubscription(stripe, customerId);
    if (existingSubscription) {
      return res.status(409).json({
        error: "This account already has a subscription. Manage the current plan before starting another checkout."
      });
    }

    const clearPendingCheckout = async (expectedOrderId, blockingSubscription = null) => {
      await db.runTransaction(async transaction => {
        const currentSnap = await transaction.get(billingRef);
        const pending = currentSnap.exists ? currentSnap.data()?.pendingSubscriptionCheckout : null;
        if (pending?.orderId === expectedOrderId) {
          const update = {
            pendingSubscriptionCheckout: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp()
          };
          if (blockingSubscription) {
            update.stripeSubscriptionId = blockingSubscription.id;
            update.stripeCustomerId = customerId;
            update.status = blockingSubscription.status;
            update.active = ["active", "trialing"].includes(blockingSubscription.status);
            update.planId = blockingSubscription.metadata?.planId || null;
          }
          transaction.set(billingRef, update, { merge: true });
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
        // Firestore may rerun this callback after a transaction conflict.
        // Reset closure state on each attempt to avoid stale reservations leaking.
        reservation = null;
        reservationError = null;
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
            stripeCreateAttempt: Math.max(1, Number(pending.stripeCreateAttempt) || 1),
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
            stripeCreateAttempt: 1,
            stripeExpiresAt: proposedExpiresAt,
            expiresAtMs: proposedExpiresAt * 1000 + CHECKOUT_LOCK_GRACE_MS,
            createdAtMs: proposedNowMs
          },
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        reservation = {
          orderId: proposedOrderId,
          sessionId: null,
          stripeCreateAttempt: 1,
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

      // Re-read after taking the Firestore reservation. A completed first Checkout
      // may have cleared the previous reservation while its Stripe subscription
      // webhook was still being delivered.
      const freshBillingSnap = await billingRef.get();
      const freshBilling = freshBillingSnap.exists ? freshBillingSnap.data() : {};
      if (freshBilling.active === true || ACTIVE_SUBSCRIPTION_STATUSES.has(freshBilling.status)) {
        await clearPendingCheckout(reservation.orderId);
        return res.status(409).json({
          error: "This account already has a subscription. Manage the current plan before starting another checkout."
        });
      }
      const freshCustomerId = typeof freshBilling.stripeCustomerId === "string"
        ? freshBilling.stripeCustomerId : customerId;
      const subscriptionAfterReservation = await findActiveSubscription(stripe, freshCustomerId);
      if (subscriptionAfterReservation) {
        await clearPendingCheckout(reservation.orderId, subscriptionAfterReservation);
        return res.status(409).json({
          error: "This account already has a subscription. Manage the current plan before starting another checkout."
        });
      }

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

      // Recover a session created by Stripe when the previous request lost its
      // response or received a cached server error before saving the session ID.
      const recoveredSession = await findCheckoutSessionByOrder(stripe, freshCustomerId, reservation.orderId);
      if (recoveredSession?.status === "open" && typeof recoveredSession.url === "string") {
        await db.runTransaction(async transaction => {
          const currentSnap = await transaction.get(billingRef);
          const pending = currentSnap.exists ? currentSnap.data()?.pendingSubscriptionCheckout : null;
          if (pending?.orderId !== reservation.orderId) {
            throw new Error("Checkout reservation changed while recovering the Stripe session.");
          }
          transaction.set(billingRef, {
            pendingSubscriptionCheckout: { ...pending, sessionId: recoveredSession.id },
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
        });
        await orderRef.set({
          stripeCheckoutSessionId: recoveredSession.id,
          status: "checkout_created",
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        return res.status(200).json({ url: recoveredSession.url, reused: true });
      }
      if (recoveredSession?.status === "complete") {
        await orderRef.set({
          stripeCheckoutSessionId: recoveredSession.id,
          status: "checkout_completed",
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        return res.status(409).json({
          error: "This Checkout has already completed. Refresh your account while the subscription is being confirmed."
        });
      }
      if (recoveredSession?.status === "expired") {
        await clearPendingCheckout(reservation.orderId);
        await orderRef.set({
          stripeCheckoutSessionId: recoveredSession.id,
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
        const createAttempt = reservation.stripeCreateAttempt;
        const session = await stripe.checkout.sessions.create({
          mode: "subscription",
          customer: freshCustomerId,
          client_reference_id: user.uid,
          line_items: [{ price: priceId, quantity: 1 }],
          expires_at: reservation.stripeExpiresAt,
          success_url: `${base}/workspace/billing.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${base}/workspace/billing.html?checkout=cancelled`,
          metadata: { firebaseUID: user.uid, orderId: reservation.orderId, planId, interval },
          subscription_data: { metadata: { firebaseUID: user.uid, orderId: reservation.orderId, planId, interval } }
        }, { idempotencyKey: `kenji-checkout-${reservation.orderId}-${createAttempt}` });

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
        // Stripe may cache a 500 response for an idempotency key. Before rotating
        // the attempt key, prove that no Checkout session for this order exists.
        const recoveredAfterError = await findCheckoutSessionByOrder(stripe, freshCustomerId, reservation.orderId);
        if (recoveredAfterError?.status === "open" && typeof recoveredAfterError.url === "string") {
          await db.runTransaction(async transaction => {
            const currentSnap = await transaction.get(billingRef);
            const pending = currentSnap.exists ? currentSnap.data()?.pendingSubscriptionCheckout : null;
            if (pending?.orderId !== reservation.orderId) {
              throw new Error("Checkout reservation changed while recovering the Stripe session.");
            }
            transaction.set(billingRef, {
              pendingSubscriptionCheckout: { ...pending, sessionId: recoveredAfterError.id },
              updatedAt: FieldValue.serverTimestamp()
            }, { merge: true });
          });
          await orderRef.set({
            stripeCheckoutSessionId: recoveredAfterError.id,
            status: "checkout_created",
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
          return res.status(200).json({ url: recoveredAfterError.url, reused: true });
        }
        if (recoveredAfterError?.status === "complete") {
          await orderRef.set({
            stripeCheckoutSessionId: recoveredAfterError.id,
            status: "checkout_completed",
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
          return res.status(409).json({
            error: "This Checkout has already completed. Refresh your account while the subscription is being confirmed."
          });
        }
        if (recoveredAfterError?.status === "expired") {
          await clearPendingCheckout(reservation.orderId);
          await orderRef.set({
            stripeCheckoutSessionId: recoveredAfterError.id,
            status: "checkout_expired",
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
          continue;
        }

        let rotated = false;
        await db.runTransaction(async transaction => {
          const currentSnap = await transaction.get(billingRef);
          const pending = currentSnap.exists ? currentSnap.data()?.pendingSubscriptionCheckout : null;
          const currentAttempt = Math.max(1, Number(pending?.stripeCreateAttempt) || 1);
          if (pending?.orderId === reservation.orderId && currentAttempt === createAttempt) {
            transaction.set(billingRef, {
              pendingSubscriptionCheckout: {
                ...pending,
                stripeCreateAttempt: createAttempt + 1,
                lastCreateErrorAtMs: Date.now()
              },
              updatedAt: FieldValue.serverTimestamp()
            }, { merge: true });
            rotated = true;
          }
        });
        await orderRef.set({
          status: "checkout_creation_retryable",
          failureCode: typeof error?.code === "string" ? error.code : "stripe_error",
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        if (rotated) {
          const retryError = new Error("Checkout session creation failed. Please retry.");
          retryError.statusCode = 503;
          throw retryError;
        }
        throw error;
      }
    }

    return res.status(409).json({
      error: "A previous Checkout session expired while being retried. Please try again."
    });

  } catch (error) {
    if (error?.code === "billing_legacy_review_required") return res.status(409).json({ error: error.message });
    const message = error?.message || "";
    const configurationError = /not configured|disabled|requires a Stripe Test Mode|not allowlisted|secure site origin/i.test(message);
    const status = configurationError || error?.statusCode === 503 ? 503 : 500;
    return res.status(status).json({
      error: status === 503 ? message : "Could not create a secure checkout session."
    });
  }
}
