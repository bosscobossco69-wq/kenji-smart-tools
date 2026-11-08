import { createHash, randomUUID } from "node:crypto";
import { getFirebaseAdmin } from "./firebase-admin.js";

const CURRENCY = "myr";

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} is required.`);
  }
  return value.trim();
}

function positiveInteger(value, name, allowZero = false) {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new TypeError(`${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer.`);
  }
  return value;
}

function idempotencyDocumentId(userId, key) {
  return createHash("sha256").update(`${userId}:${key}`).digest("hex");
}

/**
 * Create a pending order using only server-loaded plan data.
 * Call only after requireVerifiedUser(req) and after loading an active plan
 * from the server-side plans collection. Never pass browser-supplied prices.
 */
export async function createPendingPaymentOrder({
  userId,
  planId,
  provider = "stripe",
  idempotencyKey,
  amountMinor,
  currency = CURRENCY,
  creditsGrant = 0,
  billingInterval = "month"
}) {
  userId = requiredString(userId, "userId");
  planId = requiredString(planId, "planId");
  idempotencyKey = requiredString(idempotencyKey, "idempotencyKey");
  amountMinor = positiveInteger(amountMinor, "amountMinor");
  creditsGrant = positiveInteger(creditsGrant, "creditsGrant", true);
  if (provider !== "stripe") throw new TypeError("Unsupported payment provider.");
  if (String(currency).toLowerCase() !== CURRENCY) throw new TypeError("Only MYR plans are currently supported.");
  if (!["month", "year", "one_time"].includes(billingInterval)) throw new TypeError("Unsupported billing interval.");
  const requestFingerprint = createHash("sha256").update(JSON.stringify({ planId, provider, amountMinor, currency: CURRENCY, creditsGrant, billingInterval })).digest("hex");

  const { db, Timestamp } = getFirebaseAdmin();
  const now = Timestamp.now();
  const orderId = randomUUID();
  const orderRef = db.collection("paymentOrders").doc(orderId);
  const idemRef = db.collection("paymentIdempotency").doc(idempotencyDocumentId(userId, idempotencyKey));

  return db.runTransaction(async tx => {
    const existing = await tx.get(idemRef);
    if (existing.exists) {
      const existingOrderId = existing.get("orderId");
      const existingOrder = await tx.get(db.collection("paymentOrders").doc(existingOrderId));
      if (!existingOrder.exists) throw new Error("Idempotency record points to a missing order.");
      if (existing.get("requestFingerprint") !== requestFingerprint) {
        throw new Error("Idempotency key was already used with different order details.");
      }
      return { orderId: existingOrderId, order: existingOrder.data(), reused: true };
    }

    const order = {
      userId,
      planId,
      provider,
      status: "pending",
      expectedAmountMinor: amountMinor,
      currency: CURRENCY,
      creditsGrant,
      billingInterval,
      providerCheckoutSessionId: null,
      providerPaymentIntentId: null,
      createdAt: now,
      updatedAt: now,
      paidAt: null
    };
    tx.create(orderRef, order);
    tx.create(idemRef, { userId, orderId, requestFingerprint, createdAt: now });
    return { orderId, order, reused: false };
  });
}

/**
 * Apply a payment only after the caller has independently verified the Stripe
 * webhook signature and retrieved/reconciled the Stripe payment object.
 * All order, event, Credit and entitlement changes commit atomically.
 */
export async function applyVerifiedStripePayment({
  eventId,
  eventType,
  orderId,
  checkoutSessionId,
  paymentIntentId = null,
  userId,
  amountMinor,
  currency,
  paymentStatus
}) {
  eventId = requiredString(eventId, "eventId");
  eventType = requiredString(eventType, "eventType");
  orderId = requiredString(orderId, "orderId");
  checkoutSessionId = requiredString(checkoutSessionId, "checkoutSessionId");
  userId = requiredString(userId, "userId");
  amountMinor = positiveInteger(amountMinor, "amountMinor");
  if (String(currency).toLowerCase() !== CURRENCY || paymentStatus !== "paid") {
    throw new Error("Payment is not a verified paid MYR transaction.");
  }

  const { db, Timestamp } = getFirebaseAdmin();
  const eventRef = db.collection("paymentEvents").doc(eventId);
  const orderRef = db.collection("paymentOrders").doc(orderId);
  const ledgerRef = db.collection("creditLedger").doc(eventId);
  const entitlementRef = db.collection("entitlements").doc(userId);
  const now = Timestamp.now();

  return db.runTransaction(async tx => {
    const [eventSnap, orderSnap] = await Promise.all([tx.get(eventRef), tx.get(orderRef)]);
    if (eventSnap.exists) return { duplicate: true, applied: false };
    if (!orderSnap.exists) throw new Error("Payment order was not found.");

    const order = orderSnap.data();
    if (order.provider !== "stripe" || order.userId !== userId) throw new Error("Payment order ownership/provider mismatch.");
    if (order.status === "paid") throw new Error("Order is already paid.");
    if (order.status !== "pending") throw new Error("Order is not pending.");
    if (order.providerCheckoutSessionId && order.providerCheckoutSessionId !== checkoutSessionId) {
      throw new Error("Checkout Session does not match the pending order.");
    }
    if (order.expectedAmountMinor !== amountMinor || order.currency !== CURRENCY) {
      throw new Error("Verified amount or currency does not match the order.");
    }

    const grant = positiveInteger(order.creditsGrant || 0, "creditsGrant", true);
    tx.create(eventRef, {
      provider: "stripe",
      eventType,
      orderId,
      checkoutSessionId,
      paymentIntentId,
      processingStatus: "processed",
      receivedAt: now,
      processedAt: now
    });
    tx.update(orderRef, {
      status: "paid",
      providerCheckoutSessionId: checkoutSessionId,
      providerPaymentIntentId: paymentIntentId,
      paidAt: now,
      updatedAt: now
    });
    if (grant > 0) {
      tx.create(ledgerRef, {
        userId,
        orderId,
        sourceEventId: eventId,
        entryType: "grant",
        amount: grant,
        createdAt: now
      });
    }
    tx.set(entitlementRef, {
      userId,
      planId: order.planId,
      status: "active",
      sourceOrderId: orderId,
      updatedAt: now
    }, { merge: true });

    return { duplicate: false, applied: true, creditsGranted: grant };
  });
}
