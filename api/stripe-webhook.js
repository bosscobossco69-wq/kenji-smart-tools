import { notifyAdminSafely } from "../lib/admin-email-alerts.js";
import { ADJUSTMENT_EVENTS, reconcileAdjustment } from "../lib/stripe-adjustments.js";
import { billingCollection, billingDb, assertStripeKey, assertStripeObject } from "../lib/billing-environment.js";
import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

export const config = { api: { bodyParser: false } };

const MAX_BODY_BYTES = 1024 * 1024;
const PLAN_CREDITS = { lite: 10000, pro: 30000, pro_plus: 100000, ultra: 400000 };
const CREDIT_PACKS = {
  mini: { amount: 500, credits: 10000 }, basic: { amount: 2000, credits: 50000 },
  pro: { amount: 3500, credits: 100000 }, business: { amount: 15000, credits: 500000 }
};
let servicesPromise;

async function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === "string") return Buffer.from(req.rawBody);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Webhook payload too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function getServices() {
  if (!servicesPromise) {
    servicesPromise = (async () => {
      const stripeSecret = process.env.STRIPE_SECRET_KEY;
      assertStripeKey(stripeSecret);
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (!stripeSecret || !webhookSecret || !projectId || !serviceAccountRaw) {
        throw new Error("Missing required server configuration.");
      }

      let serviceAccount;
      try {
        serviceAccount = JSON.parse(serviceAccountRaw);
      } catch {
        throw new Error("Firebase service account configuration is invalid.");
      }
      if (serviceAccount.project_id !== projectId) {
        throw new Error("Firebase project configuration does not match.");
      }

      const app = getApps()[0] || initializeApp({
        credential: cert(serviceAccount),
        projectId
      });
      return {
        stripe: new Stripe(stripeSecret),
        auth: getAuth(app),
        db: billingDb(getFirestore(app))
      };
    })();
  }
  return servicesPromise;
}

function unixDate(seconds) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

function addUtcMonth(date) {
  const next = new Date(date);
  const anchorDay = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(anchorDay, lastDay));
  return next;
}

function isMissingStripeResource(error) {
  return error?.statusCode === 404 || error?.raw?.statusCode === 404 ||
    error?.code === "resource_missing";
}

function getFirebaseUid(object) {
  // Only accept server-controlled Stripe metadata. client_reference_id can be
  // supplied in a Payment Link URL and must never be trusted as an account ID.
  const candidate = object?.metadata?.firebaseUID || object?.metadata?.firebase_uid;
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= 128
    ? candidate
    : null;
}


async function getOrderCreatedAtMs(db, orderId) {
  if (typeof orderId !== "string" || !orderId) return null;
  const orderSnap = await db.collection("billingOrders").doc(orderId).get();
  if (!orderSnap.exists) return null;
  const value = orderSnap.data()?.createdAt;
  const milliseconds = typeof value?.toMillis === "function"
    ? value.toMillis()
    : value instanceof Date
      ? value.getTime()
      : Number(value);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null;
}

function timestampOrderKey(value) {
  let seconds;
  let nanoseconds;
  if (Number.isInteger(value?.seconds) && Number.isInteger(value?.nanoseconds)) {
    seconds = value.seconds;
    nanoseconds = value.nanoseconds;
  } else {
    const milliseconds = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
    seconds = Math.floor(milliseconds / 1000);
    nanoseconds = Math.floor((milliseconds - seconds * 1000) * 1000000);
  }
  if (!Number.isInteger(seconds) || !Number.isInteger(nanoseconds) ||
      nanoseconds < 0 || nanoseconds >= 1000000000) return null;
  return String(seconds).padStart(12, "0") + String(nanoseconds).padStart(9, "0");
}

function millisecondsToOrderKey(milliseconds) {
  return timestampOrderKey(Number(milliseconds));
}

async function getOrderCreatedAtKey(db, orderId) {
  if (typeof orderId !== "string" || !orderId) return null;
  const orderSnap = await db.collection("billingOrders").doc(orderId).get();
  if (!orderSnap.exists) return null;
  return timestampOrderKey(orderSnap.data()?.createdAt);
}

async function getOrderCheckoutSessionId(db, orderId) {
  if (typeof orderId !== "string" || !orderId) return null;
  const orderSnap = await db.collection("billingOrders").doc(orderId).get();
  if (!orderSnap.exists) return null;
  const sessionId = orderSnap.data()?.stripeCheckoutSessionId;
  return typeof sessionId === "string" && sessionId ? sessionId : null;
}

function subscriptionData(subscription) {
  const item = subscription.items?.data?.[0];
  return {
    stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id || null,
    stripeSubscriptionId: subscription.id,
    planId: subscription.metadata?.planId || null,
    orderId: subscription.metadata?.orderId || null,
    status: subscription.status,
    priceId: item?.price?.id || null,
    currency: item?.price?.currency || null,
    interval: item?.price?.recurring?.interval || null,
    currentPeriodStart: unixDate(Number.isFinite(item?.current_period_start)
      ? item.current_period_start : subscription.current_period_start),
    currentPeriodEnd: unixDate(Number.isFinite(item?.current_period_end)
      ? item.current_period_end : subscription.current_period_end),
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    cancelAt: unixDate(subscription.cancel_at),
    updatedAt: FieldValue.serverTimestamp()
  };
}

async function fulfillCreditPack({ db, session, uid, event, charge = null }) {
  const meta = session.metadata || {};
  const orderId = typeof meta.orderId === "string" ? meta.orderId : "";
  const pack = Object.hasOwn(CREDIT_PACKS, meta.packId) ? CREDIT_PACKS[meta.packId] : null;
  if (!orderId || !pack) throw new Error("Invalid credit pack metadata.");
  if (session.payment_status !== "paid") return;
  if (!uid || meta.firebaseUID !== uid) throw new Error("Credit pack payment has no verified Firebase user.");
  if (session.mode !== "payment" || session.currency !== "usd" || session.amount_total !== pack.amount) {
    throw new Error("Credit pack payment mismatch.");
  }

  const orderRef = db.collection("billingOrders").doc(orderId);
  const billingRef = db.collection("users").doc(uid).collection(billingCollection()).doc("current");
  const ledgerRef = db.collection("users").doc(uid).collection("creditLedger").doc("stripe_pack_" + orderId);
  if (charge && (charge.amount !== pack.amount || charge.currency !== "usd" ||
      (typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id) !== session.payment_intent)) {
    throw new Error("Credit charge does not match Checkout.");
  }
  const initialHold = charge ? (charge.disputed ? pack.credits :
    Math.min(pack.credits, Math.ceil(pack.credits * Number(charge.amount_refunded || 0) / pack.amount))) : 0;
  if (!Number.isSafeInteger(initialHold) || initialHold < 0) throw new Error("Invalid charge refund state.");

  await db.runTransaction(async tx => {
    const [orderSnap, ledgerSnap] = await Promise.all([tx.get(orderRef), tx.get(ledgerRef)]);
    if (!orderSnap.exists) throw new Error("Credit order not found.");
    const order = orderSnap.data();
    if (order.uid !== uid || order.type !== "credit_pack" || order.packId !== meta.packId ||
        order.credits !== pack.credits || order.amount !== pack.amount || order.currency !== "usd") {
      throw new Error("Credit order does not match payment.");
    }
    // Stripe can create a valid Checkout before its session ID is persisted.
    // Recover only a missing pointer for the same server-issued order, and only
    // after the signed, Stripe-retrieved paid Checkout + charge are validated.
    const needsSessionRecovery = !order.stripeCheckoutSessionId &&
      ["checkout_pending", "checkout_creation_failed"].includes(order.status);
    if (order.stripeCheckoutSessionId !== session.id && !needsSessionRecovery) {
      throw new Error("Credit order does not match payment.");
    }
    if (needsSessionRecovery && !charge) {
      throw new Error("Credit order recovery requires a verified charge.");
    }
    if (ledgerSnap.exists || order.status === "paid") return;

    tx.set(billingRef, {
      creditBalance: FieldValue.increment(pack.credits - initialHold),
      lastCreditOrderId: orderId,
      lastStripeEventId: event.id,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    if (charge) {
      tx.set(db.collection("stripeChargeAdjustments").doc(charge.id), {
        revokedCredits: initialHold, manualReview: Boolean(charge.disputed), updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    if (initialHold) {
      tx.create(db.collection("users").doc(uid).collection("creditLedger").doc("stripe_pack_initial_hold_" + orderId), {
        type: "stripe_payment_initial_hold", credits: -initialHold, orderId,
        stripeChargeId: charge.id, stripeEventId: event.id, createdAt: FieldValue.serverTimestamp()
      });
    }
    tx.create(ledgerRef, {
      type: "credit_pack_purchase",
      source: "stripe_checkout",
      orderId,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
      stripeEventId: event.id,
      credits: pack.credits,
      amount: pack.amount,
      currency: "usd",
      createdAt: FieldValue.serverTimestamp()
    });
    tx.set(orderRef, {
      status: "paid",
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
      stripeEventId: event.id,
      paidAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });
}

async function grantSubscriptionInvoice({ db, invoice, subscription, uid }) {
  if (!uid || !subscription) throw new Error("Paid subscription invoice is not linked to a verified user.");
  if (!["subscription_create", "subscription_cycle"].includes(invoice.billing_reason)) return;
  // Zero-value trial invoices grant no Credits, even when Stripe's current subscription
  // has already moved from trialing to active by the time a delayed webhook arrives.
  // Paid Credits are granted by a separate, successfully collected invoice.
  if (invoice.amount_paid === 0) return;

  if (invoice.status !== "paid" || invoice.currency !== "usd") {
    throw new Error("Subscription invoice is not a paid USD invoice.");
  }

  const metadata = subscription.metadata || {};
  const orderId = metadata.orderId;
  const planId = metadata.planId;
  const credits = PLAN_CREDITS[planId];
  const item = subscription.items?.data?.[0];
  const interval = item?.price?.recurring?.interval;
  const invoicePriceIds = (invoice.lines?.data || []).map(line =>
    line.price?.id || line.pricing?.price_details?.price
  ).filter(Boolean);

  if (!orderId || !credits || !["month", "year"].includes(interval) ||
      !item?.price?.id || !invoicePriceIds.includes(item.price.id)) {
    throw new Error("Paid invoice does not match a supported subscription plan.");
  }

  const orderRef = db.collection("billingOrders").doc(orderId);
  const billingRef = db.collection("users").doc(uid).collection(billingCollection()).doc("current");
  const ledgerRef = db.collection("users").doc(uid).collection("creditLedger").doc("stripe_invoice_" + invoice.id);

  await db.runTransaction(async tx => {
    const [orderSnap, ledgerSnap] = await Promise.all([tx.get(orderRef), tx.get(ledgerRef)]);
    if (!orderSnap.exists) throw new Error("Checkout order was not found for paid invoice.");
    const order = orderSnap.data();
    const expectedInterval = interval === "year" ? "yearly" : "monthly";
    if (order.uid !== uid || order.planId !== planId || order.interval !== expectedInterval ||
        order.priceId !== item.price.id || order.currency !== "usd") {
      throw new Error("Paid invoice does not match its pending Checkout order.");
    }
    if (ledgerSnap.exists) return;

    tx.set(billingRef, {
      creditBalance: FieldValue.increment(credits),
      lastCreditGrantInvoiceId: invoice.id,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    tx.create(ledgerRef, {
      type: interval === "year" ? "annual_subscription_initial_grant" : "subscription_cycle_grant",
      source: "stripe_invoice",
      stripeInvoiceId: invoice.id,
      stripeSubscriptionId: subscription.id,
      orderId,
      planId,
      credits,
      currency: invoice.currency || null,
      amountPaid: invoice.amount_paid ?? null,
      createdAt: FieldValue.serverTimestamp()
    });
    if (interval === "year") {
      // Stripe API versions using the Basil model expose billing periods on subscription items.
      // Keep the subscription-level fallback for older API responses.
      const periodStartSeconds = Number.isFinite(item?.current_period_start)
        ? item.current_period_start
        : subscription.current_period_start;
      const periodStart = unixDate(periodStartSeconds);
      if (!periodStart) throw new Error("Annual subscription period start is missing.");
      tx.set(billingRef, {
        nextCreditGrantAt: addUtcMonth(periodStart),
        annualCreditGrantSubscriptionId: subscription.id,
        annualCreditGrantPlanId: planId,
        annualCreditGrantPeriodStart: periodStart,
        annualCreditGrantAnchorDay: periodStart.getUTCDate()
      }, { merge: true });
    }
    tx.set(orderRef, {
      status: "paid",
      lastPaidInvoiceId: invoice.id,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });
}


export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  let services;
  try {
    services = await getServices();
  } catch {
    return res.status(503).json({ error: "Webhook service is not configured." });
  }

  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string") {
    return res.status(400).json({ error: "Missing Stripe signature." });
  }

  let event;
  try {
    const rawBody = await readRawBody(req);
    event = services.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch {
    return res.status(400).json({ error: "Invalid Stripe webhook signature or payload." });
  }

  try { assertStripeObject(event); } catch {
    return res.status(400).json({ error: "Stripe event environment mismatch." });
  }

  const eventRef = services.db.collection("stripeWebhookEvents").doc(event.id);
  const processingToken = randomUUID();
  let alreadyProcessed = false;
  let claimed = false;
  try {
    await services.db.runTransaction(async transaction => {
      // Firestore may rerun this callback after a transaction conflict.
      // Reset closure flags on every attempt so stale values cannot leak.
      alreadyProcessed = false;
      claimed = false;
      const existing = await transaction.get(eventRef);
      const current = existing.exists ? existing.data() : {};
      if (current.processed === true) {
        alreadyProcessed = true;
        return;
      }
      const leaseUntil = Number(current.processingLeaseUntilMs || 0);
      if (current.processingStatus === "processing" && leaseUntil > Date.now()) {
        return;
      }
      transaction.set(eventRef, {
        type: event.type,
        livemode: Boolean(event.livemode),
        processed: false,
        processingStatus: "processing",
        processingToken,
        processingLeaseUntilMs: Date.now() + 5 * 60 * 1000,
        attempts: FieldValue.increment(1),
        receivedAt: current.receivedAt || FieldValue.serverTimestamp()
      }, { merge: true });
      claimed = true;
    });
  } catch {
    return res.status(500).json({ error: "Could not claim Stripe event for processing." });
  }

  if (alreadyProcessed) {
    return res.status(200).json({ received: true, duplicate: true });
  }
  if (!claimed) {
    // Another invocation owns the active lease. A non-2xx response asks Stripe
    // to retry after the current processor finishes or its lease expires.
    return res.status(500).json({ error: "Stripe event is already being processed." });
  }

  try {
    if (ADJUSTMENT_EVENTS.has(event.type)) {
      await reconcileAdjustment({ ...services, event });
    }
    let object = event.data.object;
    const isCheckoutEvent = [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed"
    ].includes(event.type);
    // Resolve current server metadata and payment state before account binding or fulfillment.
    if (isCheckoutEvent) {
      object = await services.stripe.checkout.sessions.retrieve(object.id);
      assertStripeObject(object);
    }
    // Website services are independent one-time purchases, not AI Credits or subscriptions.
    // Process them before the general Firebase-linked billing path.
    if (isCheckoutEvent && object?.metadata?.purchaseType === "website_service") {
      const orderId = object.metadata.websiteOrderId;
      const packageId = object.metadata.websitePackageId;
      const servicePrices = { basic: 9900, professional: 24900, premium: 49900 };
      const price = Object.hasOwn(servicePrices, packageId) ? servicePrices[packageId] : null;
      if (!orderId || !price || object.mode !== "payment" || object.currency !== "usd" || object.amount_total !== price) {
        throw new Error("Website service Stripe payment mismatch.");
      }
      const websiteOrderRef = services.db.collection("websiteOrders").doc(orderId);
      await services.db.runTransaction(async transaction => {
        const current = await transaction.get(websiteOrderRef);
        const data = current.data();
        if (!current.exists || data.packageId !== packageId || data.amount !== price ||
            (data.stripeCheckoutSessionId && data.stripeCheckoutSessionId !== object.id)) {
          throw new Error("Website order was not issued by this server.");
        }
        // Do not grant access for unpaid, failed, or incomplete Checkout.
        if (object.payment_status === "paid") {
          if (data.status !== "paid") transaction.set(websiteOrderRef, {
            status: "paid",
            stripeCheckoutSessionId: object.id,
            stripePaymentIntentId: object.payment_intent || null,
            buyerEmail: object.customer_details?.email || null,
            paidAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
        } else if (event.type === "checkout.session.async_payment_failed" && data.status !== "paid") {
          transaction.set(websiteOrderRef, {
            status: "payment_failed", updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
        }
      });
      await services.db.runTransaction(async transaction => {
        const claimedEvent = await transaction.get(eventRef);
        if (claimedEvent.data()?.processingToken !== processingToken) throw new Error("Webhook lease lost.");
        transaction.set(eventRef, {
          processed: true, processingStatus: "processed",
          processingToken: FieldValue.delete(),
          processingLeaseUntilMs: FieldValue.delete(),
          websiteOrderId: orderId,
          processedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      });
      if (object.payment_status === "paid") {
        await notifyAdminSafely(services.db, "website_paid", orderId, {
          orderId, package: packageId, amountUsd: price / 100, environment: event.livemode ? "live" : "test"
        });
      }
      return res.status(200).json({ received: true, websiteService: true });
    }
    let snapshotSequence = null;
    let latestInvoiceSnapshot = null;
    let relatedSubscription = null;
    const isInvoiceEvent = event.type === "invoice.paid" || event.type === "invoice.payment_failed";
    let snapshotSubscriptionId = event.type.startsWith("customer.subscription.")
      ? object.id
      : (typeof object.subscription === "string"
        ? object.subscription
        : object.subscription?.id || object.parent?.subscription_details?.subscription || null);

    // Use a Firestore-issued monotonic sequence instead of Date.now(): two
    // concurrent handlers can start in the same millisecond. The sequence is
    // allocated before Stripe retrieval, so slower earlier responses cannot win.
    const allocateSnapshotSequence = async subscriptionId => {
      if (!subscriptionId) return null;
      const sequenceRef = services.db.collection("stripeSnapshotSequences").doc(subscriptionId);
      return services.db.runTransaction(async transaction => {
        const current = await transaction.get(sequenceRef);
        const next = Number(current.data()?.value || 0) + 1;
        transaction.set(sequenceRef, { value: next, updatedAt: FieldValue.serverTimestamp() });
        return next;
      });
    };

    if (snapshotSubscriptionId) {
      snapshotSequence = await allocateSnapshotSequence(snapshotSubscriptionId);
    }

    if (event.type.startsWith("customer.subscription.")) {
      const eventSubscription = object;
      try {
        object = await services.stripe.subscriptions.retrieve(eventSubscription.id);
        assertStripeObject(object);
      } catch (error) {
        if (!(event.type === "customer.subscription.deleted" && isMissingStripeResource(error))) {
          throw error;
        }
        object = { ...eventSubscription, status: "canceled" };
      }
    } else if (isInvoiceEvent) {
      object = await services.stripe.invoices.retrieve(object.id);
      assertStripeObject(object);
      snapshotSubscriptionId = typeof object.subscription === "string"
        ? object.subscription
        : object.subscription?.id || object.parent?.subscription_details?.subscription || snapshotSubscriptionId;
      if (snapshotSubscriptionId && snapshotSequence === null) {
        snapshotSequence = await allocateSnapshotSequence(snapshotSubscriptionId);
      }
      if (snapshotSubscriptionId) {
        relatedSubscription = await services.stripe.subscriptions.retrieve(snapshotSubscriptionId);
        assertStripeObject(relatedSubscription);
        const latestInvoiceId = typeof relatedSubscription.latest_invoice === "string"
          ? relatedSubscription.latest_invoice
          : relatedSubscription.latest_invoice?.id || null;
        if (latestInvoiceId) {
          latestInvoiceSnapshot = await services.stripe.invoices.retrieve(latestInvoiceId);
          assertStripeObject(latestInvoiceSnapshot);
        }
      }
    }
    let uid = getFirebaseUid(object) || getFirebaseUid(relatedSubscription);
    let customer = null;
    const customerId = typeof object?.customer === "string" ? object.customer : object?.customer?.id;
    if (customerId) {
      try {
        customer = await services.stripe.customers.retrieve(customerId);
        if (customer?.deleted) customer = null;
      } catch (error) {
        if (!isMissingStripeResource(error)) throw error;
        customer = null;
      }
    }
    if (!uid) uid = getFirebaseUid(customer);

    // Never infer Firebase account ownership from Checkout/customer email.
    // Only server-written Stripe metadata may link billing to a Firebase UID.
    // Public Payment Links without that metadata remain unlinked for explicit reconciliation.

    if (uid) {
      // Verify that the UID belongs to a real Firebase account before granting billing state.
      const firebaseUser = await services.auth.getUser(uid);
      if (!firebaseUser.emailVerified) uid = null;
    }

    const isPackCheckout = [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded"
    ].includes(event.type) && object?.metadata?.purchaseType === "credit_pack";
    if (isPackCheckout) {
      if (object.payment_status === "paid") {
        const intent = await services.stripe.paymentIntents.retrieve(object.payment_intent, { expand: ["latest_charge"] });
        assertStripeObject(intent);
        let charge = intent.latest_charge;
        if (typeof charge === "string") charge = await services.stripe.charges.retrieve(charge);
        assertStripeObject(charge);
        await fulfillCreditPack({ db: services.db, session: object, uid, event, charge });
        await notifyAdminSafely(services.db, "credit_paid", object.metadata.orderId, {
          orderId: object.metadata.orderId, package: object.metadata.packId,
          amountUsd: object.amount_total / 100, credits: CREDIT_PACKS[object.metadata.packId]?.credits,
          environment: event.livemode ? "live" : "test"
        });
      }
    } else if (event.type === "invoice.paid" && relatedSubscription) {
      await grantSubscriptionInvoice({ db: services.db, invoice: object, subscription: relatedSubscription, uid });
      if (object.status === "paid" && object.amount_paid > 0 &&
          ["subscription_create", "subscription_cycle"].includes(object.billing_reason)) {
        await notifyAdminSafely(services.db, "subscription_paid", object.id, {
          plan: relatedSubscription.metadata?.planId, amountUsd: object.amount_paid / 100,
          credits: PLAN_CREDITS[relatedSubscription.metadata?.planId], environment: event.livemode ? "live" : "test"
        });
      }
    }

    if (uid) {
      const billingRef = services.db.collection("users").doc(uid).collection(billingCollection()).doc("current");
      const common = {
        stripeCustomerId: typeof object?.customer === "string" ? object.customer : object?.customer?.id || null,
        lastStripeEventId: event.id,
        lastStripeEventType: event.type,
        updatedAt: FieldValue.serverTimestamp()
      };

      if ([
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.async_payment_failed"
      ].includes(event.type)) {
        const incomingPaymentStatus = event.type === "checkout.session.async_payment_succeeded"
          ? "paid"
          : event.type === "checkout.session.async_payment_failed"
            ? "failed"
            : object.payment_status || "unpaid";
        const orderId = object.metadata?.orderId || null;
        const orderCreatedAtMs = await getOrderCreatedAtMs(services.db, orderId);
        const orderCreatedAtKey = await getOrderCreatedAtKey(services.db, orderId);
        const orderCheckoutSessionId = await getOrderCheckoutSessionId(services.db, orderId);
        const paymentStatusRank = status => ({
          unpaid: 0,
          failed: 1,
          paid: 2,
          no_payment_required: 2
        }[status] ?? -1);
        await services.db.runTransaction(async transaction => {
          const current = await transaction.get(billingRef);
          const data = current.exists ? current.data() : {};
          const sameSession = data.checkoutSessionId === object.id;
          const currentSessionCreated = Number(data.checkoutSessionCreated || 0);
          const incomingSessionCreated = Number(object.created || 0);
          if (!sameSession && data.checkoutSessionId) {
            const currentOrderCreatedAtMs = Number(data.checkoutOrderCreatedAtMs || 0);
            const currentOrderCreatedAtKey = data.checkoutOrderCreatedAtKey ||
              millisecondsToOrderKey(currentOrderCreatedAtMs);
            if (orderCreatedAtKey && currentOrderCreatedAtKey) {
              if (orderCreatedAtKey < currentOrderCreatedAtKey) return;
              if (orderCreatedAtKey === currentOrderCreatedAtKey) {
                if (data.checkoutOrderId !== orderId) {
                  throw new Error("Cannot safely order distinct Checkout orders with identical creation time.");
                }
                if (incomingSessionCreated < currentSessionCreated) return;
                if (incomingSessionCreated === currentSessionCreated) {
                  const pending = data.pendingSubscriptionCheckout;
                  const authoritativeSessionId =
                    pending?.orderId === orderId && typeof pending.sessionId === "string"
                      ? pending.sessionId
                      : orderCheckoutSessionId;
                  // Use the session selected by the server-side checkout reservation/order.
                  // If no authoritative pointer exists, keep the existing billing pointer
                  // rather than retrying an immutable same-second ambiguity forever.
                  if (authoritativeSessionId) {
                    if (object.id !== authoritativeSessionId) return;
                  } else {
                    return;
                  }
                }
              }
            } else if (incomingSessionCreated < currentSessionCreated) {
              return;
            } else if (incomingSessionCreated === currentSessionCreated) {
              // No reliable order key exists. Keep the current pointer rather than
              // retrying a same-second ambiguity indefinitely.
              return;
            }
          }
          if (sameSession && event.created < Number(data.checkoutEventCreated || 0)) return;
          const previousPaymentStatus = sameSession ? data.checkoutPaymentStatus : null;
          const checkoutPaymentStatus =
            paymentStatusRank(previousPaymentStatus) > paymentStatusRank(incomingPaymentStatus)
              ? previousPaymentStatus
              : incomingPaymentStatus;
          const checkoutUpdate = {
            ...common,
            checkoutSessionId: object.id,
            checkoutPaymentStatus,
            checkoutPaymentUpdatedAt: FieldValue.serverTimestamp(),
            checkoutMode: object.mode || null,
            checkoutSessionCreated: incomingSessionCreated,
            checkoutOrderId: orderId,
            checkoutOrderCreatedAtMs: orderCreatedAtMs ?? FieldValue.delete(),
            checkoutOrderCreatedAtKey: orderCreatedAtKey ?? FieldValue.delete(),
            checkoutEventCreated: sameSession
              ? Math.max(Number(data.checkoutEventCreated || 0), Number(event.created || 0))
              : Number(event.created || 0)
          };
          const pending = data.pendingSubscriptionCheckout;
          if (pending?.orderId === object.metadata?.orderId || pending?.sessionId === object.id) {
            checkoutUpdate.pendingSubscriptionCheckout = FieldValue.delete();
          }
          transaction.set(billingRef, checkoutUpdate, { merge: true });
        });
      } else if (event.type.startsWith("customer.subscription.")) {
        const subscription = object;
        const incomingCreated = Number(subscription.created || 0);
        const incomingOrderId = subscription.metadata?.orderId || null;
        const incomingOrderAt = Number(await getOrderCreatedAtMs(services.db, incomingOrderId) || 0);
        const incomingOrderKey = await getOrderCreatedAtKey(services.db, incomingOrderId);
        const existingBilling = await billingRef.get();
        const existingData = existingBilling.exists ? existingBilling.data() : {};
        const existingSubscriptionId = existingData.stripeSubscriptionId || null;
        let existingSubscriptionCreated = Number(existingData.stripeSubscriptionCreated || 0);
        let existingOrderId = existingData.stripeSubscriptionOrderId || null;
        let existingOrderAt = Number(existingData.stripeSubscriptionOrderCreatedAtMs || 0);
        let existingOrderKey = existingData.stripeSubscriptionOrderCreatedAtKey ||
          millisecondsToOrderKey(existingOrderAt);
        let existingSubscriptionMissing = false;
        if (existingSubscriptionId && existingSubscriptionId !== subscription.id &&
            (!existingSubscriptionCreated || existingSubscriptionCreated === incomingCreated)) {
          try {
            const existingSubscription = await services.stripe.subscriptions.retrieve(existingSubscriptionId);
            existingSubscriptionCreated = Number(existingSubscription.created || existingSubscriptionCreated || 0);
            existingOrderId = existingOrderId || existingSubscription.metadata?.orderId || null;
            existingOrderAt = existingOrderAt ||
              Number(await getOrderCreatedAtMs(services.db, existingOrderId) || 0);
            existingOrderKey = existingOrderKey ||
              await getOrderCreatedAtKey(services.db, existingOrderId);
          } catch (error) {
            if (isMissingStripeResource(error)) {
              existingSubscriptionMissing = true;
            } else {
              throw error;
            }
          }
        }
        await services.db.runTransaction(async transaction => {
          const current = await transaction.get(billingRef);
          const data = current.exists ? current.data() : {};
          const sequences = data.subscriptionSnapshotSequences || {};
          const previousSequence = Number(sequences[subscription.id] || 0);
          if (snapshotSequence === null || snapshotSequence < previousSequence) return;

          const currentSubscriptionId = data.stripeSubscriptionId || null;
          const transactionCurrentCreated = Number(data.stripeSubscriptionCreated || 0) ||
            (currentSubscriptionId === existingSubscriptionId ? existingSubscriptionCreated : 0);
          const transactionCurrentOrderId = data.stripeSubscriptionOrderId ||
            (currentSubscriptionId === existingSubscriptionId ? existingOrderId : null);
          const transactionCurrentOrderAt = Number(data.stripeSubscriptionOrderCreatedAtMs || 0) ||
            (currentSubscriptionId === existingSubscriptionId ? existingOrderAt : 0);
          const transactionCurrentOrderKey = data.stripeSubscriptionOrderCreatedAtKey ||
            millisecondsToOrderKey(transactionCurrentOrderAt) ||
            (currentSubscriptionId === existingSubscriptionId ? existingOrderKey : null);

          if (currentSubscriptionId && currentSubscriptionId !== subscription.id) {
            if (!incomingCreated) throw new Error("Incoming subscription creation timestamp is missing.");
            const missingLegacyPointerWithoutWatermark =
              existingSubscriptionMissing &&
              currentSubscriptionId === existingSubscriptionId &&
              !transactionCurrentCreated &&
              !transactionCurrentOrderKey;
            if (!missingLegacyPointerWithoutWatermark) {
              if (!transactionCurrentCreated) {
                // Some older billing records have an order watermark but predate
                // stripeSubscriptionCreated. Compare the surviving order key.
                if (!incomingOrderKey || !transactionCurrentOrderKey) {
                  throw new Error("Cannot safely order subscription replacement without a creation or order watermark.");
                }
                if (incomingOrderKey < transactionCurrentOrderKey) return;
                if (incomingOrderKey === transactionCurrentOrderKey) {
                  if (incomingOrderId === transactionCurrentOrderId) return;
                  throw new Error("Subscription replacement order timestamps are ambiguous.");
                }
              } else {
                if (incomingCreated < transactionCurrentCreated) return;
                if (incomingCreated === transactionCurrentCreated) {
                  if (!incomingOrderKey || !transactionCurrentOrderKey) {
                    throw new Error("Cannot safely order subscriptions created in the same second.");
                  }
                  if (incomingOrderKey < transactionCurrentOrderKey) return;
                  if (incomingOrderKey === transactionCurrentOrderKey) {
                    // Distinct subscriptions cannot be ordered by identical Stripe
                    // second and identical billing order; retain the current pointer.
                    if (incomingOrderId === transactionCurrentOrderId) return;
                    throw new Error("Subscription replacement order timestamps are ambiguous.");
                  }
                }
              }
            }
          }

          transaction.set(billingRef, {
            ...common,
            ...subscriptionData(subscription),
            active: ["active", "trialing"].includes(subscription.status),
            stripeSubscriptionId: subscription.id,
            stripeSubscriptionCreated: incomingCreated,
            stripeSubscriptionOrderId: incomingOrderId,
            stripeSubscriptionOrderCreatedAtMs: incomingOrderAt || FieldValue.delete(),
            stripeSubscriptionOrderCreatedAtKey: incomingOrderKey || FieldValue.delete(),
            subscriptionSnapshotSequences: {
              ...sequences,
              [subscription.id]: snapshotSequence
            }
          }, { merge: true });
        });
      } else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
        // Only the subscription's current latest invoice may update the
        // displayed payment state; an older invoice event cannot replace it.
        if (latestInvoiceSnapshot) {
          const invoiceStatus = latestInvoiceSnapshot.status || "open";
          const invoiceSubscriptionOrderId = relatedSubscription?.metadata?.orderId || null;
          const invoiceSubscriptionOrderKey =
            await getOrderCreatedAtKey(services.db, invoiceSubscriptionOrderId);
          await services.db.runTransaction(async transaction => {
            const current = await transaction.get(billingRef);
            const data = current.exists ? current.data() : {};
            const invoiceSequences = data.invoiceSnapshotSequences || {};
            const previousInvoiceSequence = Number(invoiceSequences[snapshotSubscriptionId] || 0);
            // An invoice from a superseded subscription must not replace the
            // payment status shown for the current subscription.
            if (!snapshotSubscriptionId || snapshotSequence === null ||
                snapshotSequence < previousInvoiceSequence) return;
            if (data.stripeSubscriptionId !== snapshotSubscriptionId) {
              const currentCreated = Number(data.stripeSubscriptionCreated || 0);
              const incomingCreated = Number(relatedSubscription?.created || 0);
              // If linkage has not arrived yet, leave the event retryable. If
              // this invoice belongs to an older subscription, it is safe to
              // consume without changing the current account payment state.
              if (!data.stripeSubscriptionId || !currentCreated || !incomingCreated) {
                throw new Error("Invoice arrived before its subscription was linked.");
              }
              if (incomingCreated > currentCreated) {
                throw new Error("Invoice belongs to a newer subscription not linked yet.");
              }
              if (incomingCreated === currentCreated) {
                const currentOrderAt = Number(data.stripeSubscriptionOrderCreatedAtMs || 0);
                const currentOrderKey = data.stripeSubscriptionOrderCreatedAtKey ||
                  millisecondsToOrderKey(currentOrderAt);
                if (!invoiceSubscriptionOrderKey || !currentOrderKey) {
                  throw new Error("Invoice subscription ordering is ambiguous within the same second.");
                }
                if (invoiceSubscriptionOrderKey > currentOrderKey) {
                  throw new Error("Invoice belongs to a newer same-second subscription not linked yet.");
                }
                if (invoiceSubscriptionOrderKey === currentOrderKey &&
                    invoiceSubscriptionOrderId !== data.stripeSubscriptionOrderId) {
                  throw new Error("Invoice subscription order timestamps are ambiguous.");
                }
              }
              return;
            }
            transaction.set(billingRef, {
              ...common,
              latestInvoiceId: latestInvoiceSnapshot.id,
              latestInvoiceStatus: invoiceStatus,
              latestInvoiceAmountPaid: latestInvoiceSnapshot.amount_paid ?? null,
              latestInvoiceCurrency: latestInvoiceSnapshot.currency || null,
              paymentIssue: invoiceStatus === "uncollectible" ||
                (invoiceStatus === "open" && Boolean(latestInvoiceSnapshot.attempted) &&
                  Number(latestInvoiceSnapshot.attempt_count || 0) > 0),
              invoiceSnapshotSequences: {
                ...invoiceSequences,
                [snapshotSubscriptionId]: snapshotSequence
              }
            }, { merge: true });
          });
        }
      }
    }

    const requiresVerifiedAccount = [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed"
    ].includes(event.type) ||
      event.type.startsWith("customer.subscription.") ||
      event.type === "invoice.paid" ||
      event.type === "invoice.payment_failed";

    if (!uid && requiresVerifiedAccount) {
      throw new Error("Stripe billing event is not linked to a verified Firebase account yet.");
    }

    await services.db.runTransaction(async transaction => {
      const current = await transaction.get(eventRef);
      if (current.data()?.processingToken !== processingToken) {
        throw new Error("Stripe event processing lease was lost.");
      }
      transaction.set(eventRef, {
        processed: true,
        processingStatus: "processed",
        processingToken: FieldValue.delete(),
        processingLeaseUntilMs: FieldValue.delete(),
        firebaseUid: uid || null,
        processedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    });

    if (event.type === "invoice.payment_failed") {
      await notifyAdminSafely(services.db, "billing_failure", event.id, {
        category: "invoice_payment_failed", source: "stripe_webhook", environment: event.livemode ? "live" : "test"
      });
    }
    return res.status(200).json({ received: true, linked: Boolean(uid) });
  } catch {
    // Release only this invocation's lease so Stripe can retry immediately.
    // Never clear a lease acquired by a newer concurrent delivery.
    try {
      await services.db.runTransaction(async transaction => {
        const current = await transaction.get(eventRef);
        if (current.data()?.processingToken !== processingToken) return;
        transaction.set(eventRef, {
          processingStatus: "retryable",
          processingToken: FieldValue.delete(),
          processingLeaseUntilMs: FieldValue.delete(),
          lastProcessingErrorAt: FieldValue.serverTimestamp()
        }, { merge: true });
      });
    } catch {}
    await notifyAdminSafely(services.db, "billing_failure", event.id, {
      category: "webhook_processing_failed", source: "stripe_webhook", environment: event.livemode ? "live" : "test"
    });
    return res.status(500).json({ error: "Stripe event processing failed." });
  }
}
