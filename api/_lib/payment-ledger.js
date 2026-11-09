import { createHash, randomUUID } from "node:crypto";
import { getFirebaseAdmin } from "./firebase-admin.js";

const CURRENCY = "myr";
const SUPPORTED_PAID_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded"
]);

function requiredString(value, name, maxLength = 256) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new TypeError(`${name} exceeds the maximum length.`);
  }
  return normalized;
}

function safeDocumentId(value) {
  return createHash("sha256").update(value).digest("hex");
}

function positiveInteger(value, name, allowZero = false) {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new TypeError(`${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer.`);
  }
  return value;
}

function idempotencyDocumentId(userId, key) {
  return createHash("sha256").update(JSON.stringify([userId, key])).digest("hex");
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
  idempotencyKey = requiredString(idempotencyKey, "idempotencyKey", 200);
  if (idempotencyKey.length < 16) throw new TypeError("idempotencyKey must contain at least 16 characters.");
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
 * Bind a provider Checkout Session to its pending internal order before
 * returning the redirect URL. Repeated identical binds are safe; a different
 * session can never replace an existing one.
 */
export async function attachStripeCheckoutSession({
  orderId,
  userId,
  checkoutSessionId,
  stripeCustomerId = null
}) {
  orderId = requiredString(orderId, "orderId");
  userId = requiredString(userId, "userId");
  checkoutSessionId = requiredString(checkoutSessionId, "checkoutSessionId", 255);
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(checkoutSessionId)) {
    throw new TypeError("checkoutSessionId is not a valid Stripe Checkout Session identifier.");
  }
  if (stripeCustomerId !== null) {
    stripeCustomerId = requiredString(stripeCustomerId, "stripeCustomerId", 255);
    if (!/^cus_[A-Za-z0-9]+$/.test(stripeCustomerId)) {
      throw new TypeError("stripeCustomerId is not a valid Stripe Customer identifier.");
    }
  }
  const { db, Timestamp } = getFirebaseAdmin();
  const orderRef = db.collection("paymentOrders").doc(orderId);
  const now = Timestamp.now();

  return db.runTransaction(async tx => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) throw new Error("Payment order was not found.");
    const order = snap.data();
    if (order.provider !== "stripe" || order.userId !== userId) {
      throw new Error("Payment order ownership/provider mismatch.");
    }
    if (order.status !== "pending") throw new Error("Payment order is not pending.");
    if (order.providerCheckoutSessionId) {
      if (order.providerCheckoutSessionId !== checkoutSessionId) {
        throw new Error("A different Checkout Session is already attached.");
      }
      return { attached: true, reused: true };
    }
    tx.update(orderRef, {
      providerCheckoutSessionId: checkoutSessionId,
      ...(stripeCustomerId ? { providerCustomerId: requiredString(stripeCustomerId, "stripeCustomerId") } : {}),
      updatedAt: now
    });
    return { attached: true, reused: false };
  });
}

/**
 * Apply a payment only after the caller has independently verified the Stripe
 * webhook signature and retrieved/reconciled the Stripe payment object.
 * This records payment and any one-off Credit grant only. It deliberately does
 * not activate memberships: subscription lifecycle and entitlement expiry
 * policies must be implemented and tested separately.
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
  eventId = requiredString(eventId, "eventId", 255);
  if (!/^evt_[A-Za-z0-9]+$/.test(eventId)) throw new TypeError("eventId is not a valid Stripe event identifier.");
  eventType = requiredString(eventType, "eventType", 128);
  if (!SUPPORTED_PAID_EVENT_TYPES.has(eventType)) {
    throw new TypeError("eventType is not a supported paid Checkout event.");
  }
  orderId = requiredString(orderId, "orderId");
  checkoutSessionId = requiredString(checkoutSessionId, "checkoutSessionId", 255);
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(checkoutSessionId)) throw new TypeError("checkoutSessionId is not a valid Stripe Checkout Session identifier.");
  if (paymentIntentId !== null) {
    paymentIntentId = requiredString(paymentIntentId, "paymentIntentId", 255);
    if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)) throw new TypeError("paymentIntentId is not a valid Stripe PaymentIntent identifier.");
  }
  userId = requiredString(userId, "userId");
  amountMinor = positiveInteger(amountMinor, "amountMinor");
  if (String(currency).toLowerCase() !== CURRENCY || paymentStatus !== "paid") {
    throw new Error("Payment is not a verified paid MYR transaction.");
  }

  const { db, Timestamp } = getFirebaseAdmin();
  const eventDocumentId = safeDocumentId(eventId);
  const eventRef = db.collection("paymentEvents").doc(eventDocumentId);
  const orderRef = db.collection("paymentOrders").doc(orderId);
  const ledgerRef = db.collection("creditLedger").doc(eventDocumentId);
  const eventFingerprint = createHash("sha256").update(JSON.stringify({
    eventType, orderId, checkoutSessionId, paymentIntentId, userId, amountMinor, currency: CURRENCY
  })).digest("hex");
  const now = Timestamp.now();

  return db.runTransaction(async tx => {
    const [eventSnap, orderSnap] = await Promise.all([tx.get(eventRef), tx.get(orderRef)]);
    if (eventSnap.exists) {
      if (eventSnap.get("eventFingerprint") !== eventFingerprint) {
        throw new Error("Stripe event ID was previously recorded with different payment details.");
      }
      return { duplicate: true, applied: false };
    }
    if (!orderSnap.exists) throw new Error("Payment order was not found.");

    const order = orderSnap.data();
    if (order.provider !== "stripe" || order.userId !== userId) throw new Error("Payment order ownership/provider mismatch.");
    if (order.status === "paid") throw new Error("Order is already paid.");
    if (order.status !== "pending") throw new Error("Order is not pending.");
    if (!order.providerCheckoutSessionId || order.providerCheckoutSessionId !== checkoutSessionId) {
      throw new Error("Checkout Session does not match the pending order.");
    }
    if (order.expectedAmountMinor !== amountMinor || order.currency !== CURRENCY) {
      throw new Error("Verified amount or currency does not match the order.");
    }

    const grant = positiveInteger(order.creditsGrant || 0, "creditsGrant", true);
    tx.create(eventRef, {
      provider: "stripe",
      eventType,
      eventFingerprint,
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
    return {
      duplicate: false,
      applied: true,
      creditsGranted: grant,
      entitlementActivated: false
    };
  });
}


/**
 * Persist a terminal/review outcome only after the caller has retrieved the
 * canonical Stripe objects server-to-server and validated their relationship
 * to this order. This helper does not call Stripe and cannot establish that
 * the supplied evidence is genuine by itself.
 */
export async function recordVerifiedPaymentOrderOutcome({
  outcome,
  orderId,
  userId,
  checkoutSessionId,
  evidence
}) {
  orderId = requiredString(orderId, "orderId");
  userId = requiredString(userId, "userId");
  checkoutSessionId = requiredString(checkoutSessionId, "checkoutSessionId", 255);
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(checkoutSessionId)) {
    throw new TypeError("checkoutSessionId is not a valid Stripe Checkout Session identifier.");
  }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new TypeError("Canonical Stripe evidence is required.");
  }

  let evidenceId;
  let evidenceFingerprint;
  if (outcome === "failed") {
    const paymentIntentId = requiredString(evidence.paymentIntentId, "evidence.paymentIntentId", 255);
    if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntentId) || evidence.paymentIntentStatus !== "canceled") {
      throw new Error("Failed outcome requires a canonically retrieved canceled PaymentIntent.");
    }
    evidenceId = paymentIntentId;
    evidenceFingerprint = { paymentIntentId, paymentIntentStatus: "canceled", checkoutSessionId };
  } else if (outcome === "expired") {
    const expiresAt = positiveInteger(evidence.expiresAt, "evidence.expiresAt");
    if (evidence.sessionStatus !== "expired" || evidence.paymentStatus !== "unpaid" ||
        expiresAt * 1000 > Date.now()) {
      throw new Error("Expired outcome requires an expired, unpaid Checkout Session whose expires_at has passed.");
    }
    evidenceId = checkoutSessionId;
    evidenceFingerprint = { checkoutSessionId, sessionStatus: "expired", paymentStatus: "unpaid", expiresAt };
  } else if (outcome === "review_required") {
    const reason = requiredString(evidence.reason, "evidence.reason", 500);
    const reference = requiredString(evidence.reference, "evidence.reference", 255);
    evidenceId = reference;
    evidenceFingerprint = { reference, reason, checkoutSessionId };
  } else {
    throw new TypeError("Unsupported payment order outcome.");
  }

  const { db, Timestamp } = getFirebaseAdmin();
  const orderRef = db.collection("paymentOrders").doc(orderId);
  const auditId = safeDocumentId(JSON.stringify([orderId, outcome, evidenceId]));
  const auditRef = db.collection("paymentOrderEvents").doc(auditId);
  const fingerprint = createHash("sha256").update(JSON.stringify(evidenceFingerprint)).digest("hex");
  const now = Timestamp.now();

  return db.runTransaction(async tx => {
    const [orderSnap, auditSnap] = await Promise.all([tx.get(orderRef), tx.get(auditRef)]);
    if (!orderSnap.exists) throw new Error("Payment order was not found.");
    const order = orderSnap.data();
    if (order.provider !== "stripe" || order.userId !== userId ||
        order.providerCheckoutSessionId !== checkoutSessionId) {
      throw new Error("Payment order ownership/provider/session mismatch.");
    }
    if (auditSnap.exists) {
      if (auditSnap.get("evidenceFingerprint") !== fingerprint) {
        throw new Error("Outcome evidence reference was reused with conflicting details.");
      }
      return { recorded: true, duplicate: true, status: order.status };
    }
    if (order.status === "paid") {
      throw new Error("Paid orders cannot be downgraded or moved to review by a later failure/expiry outcome.");
    }
    if (outcome === "failed" || outcome === "expired") {
      if (order.status !== "pending") {
        throw new Error("Only pending orders can transition to failed or expired.");
      }
    } else if (!["pending", "failed", "expired", "review_required"].includes(order.status)) {
      throw new Error("Order cannot transition to review_required from its current status.");
    }

    tx.create(auditRef, {
      provider: "stripe",
      orderId,
      checkoutSessionId,
      outcome,
      evidenceId,
      evidenceFingerprint: fingerprint,
      recordedAt: now
    });
    tx.update(orderRef, {
      status: outcome,
      updatedAt: now,
      ...(outcome === "failed" ? { failedAt: now } : {}),
      ...(outcome === "expired" ? { expiredAt: now } : {}),
      ...(outcome === "review_required" ? { reviewRequiredAt: now } : {})
    });
    return { recorded: true, duplicate: false, status: outcome };
  });
}
