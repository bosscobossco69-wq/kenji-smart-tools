const REFUND_EVENTS = new Set(["refund.created", "refund.updated"]);
const DISPUTE_EVENTS = new Set([
  "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed"
]);

function requiredId(value, prefix, name) {
  const id = typeof value === "string" ? value : value?.id;
  if (typeof id !== "string" || !id.startsWith(prefix)) {
    throw new Error(`Canonical Stripe ${name} identifier is missing or invalid.`);
  }
  return id;
}

function assertSandbox(object, name) {
  if (!object || object.livemode !== false) {
    throw new Error(`Canonical Stripe ${name} is not a Sandbox object.`);
  }
}

function assertCurrency(value, name) {
  if (typeof value !== "string" || value.toLowerCase() !== "myr") {
    throw new Error(`${name} currency is not MYR.`);
  }
}

function assertOrder(order, paymentIntentId) {
  if (!order || order.provider !== "stripe" || order.status !== "paid" ||
      typeof order.orderId !== "string" || typeof order.userId !== "string" ||
      order.providerPaymentIntentId !== paymentIntentId ||
      typeof order.providerCheckoutSessionId !== "string" ||
      !order.providerCheckoutSessionId.startsWith("cs_test_") ||
      !Number.isSafeInteger(order.expectedAmountMinor) || order.expectedAmountMinor <= 0 ||
      order.currency !== "myr") {
    throw new Error("Canonical Stripe evidence does not match a paid internal order.");
  }
}

async function retrieveCanonicalChain({ stripe, paymentIntentId, chargeId, findOrderByPaymentIntent }) {
  const [paymentIntent, charge] = await Promise.all([
    stripe.paymentIntents.retrieve(paymentIntentId),
    stripe.charges.retrieve(chargeId)
  ]);
  assertSandbox(paymentIntent, "PaymentIntent");
  assertSandbox(charge, "Charge");
  if (paymentIntent.id !== paymentIntentId || paymentIntent.status !== "succeeded" ||
      charge.id !== chargeId || charge.payment_intent !== paymentIntentId ||
      charge.paid !== true || charge.status !== "succeeded") {
    throw new Error("Canonical Charge and PaymentIntent linkage/status is invalid.");
  }
  assertCurrency(charge.currency, "Charge");
  const order = await findOrderByPaymentIntent(paymentIntentId);
  assertOrder(order, paymentIntentId);

  const session = await stripe.checkout.sessions.retrieve(order.providerCheckoutSessionId, {
    expand: ["payment_intent"]
  });
  assertSandbox(session, "Checkout Session");
  const sessionPaymentIntentId = requiredId(session.payment_intent, "pi_", "Checkout Session PaymentIntent");
  if (session.id !== order.providerCheckoutSessionId || session.status !== "complete" ||
      session.payment_status !== "paid" || sessionPaymentIntentId !== paymentIntentId ||
      session.metadata?.orderId !== order.orderId || session.metadata?.userId !== order.userId ||
      session.amount_total !== order.expectedAmountMinor) {
    throw new Error("Canonical Checkout Session does not match the internal paid order.");
  }
  assertCurrency(session.currency, "Checkout Session");
  if (order.providerCustomerId && requiredId(session.customer, "cus_", "Checkout Session Customer") !== order.providerCustomerId) {
    throw new Error("Canonical Checkout Session customer does not match the order.");
  }
  if (charge.amount !== order.expectedAmountMinor) {
    throw new Error("Canonical Charge amount does not match the paid order.");
  }
  return { order, paymentIntent, charge, session };
}

/**
 * Reconcile a signed Stripe refund/dispute event using server-retrieved
 * canonical objects. Only the event type and object ID are read from the
 * webhook payload; monetary, status, customer and relationship fields come
 * exclusively from Stripe API responses and the internal order record.
 */
export async function reconcileStripeRefundOrDispute({
  event, stripe, findOrderByPaymentIntent
}) {
  if (!event || !stripe || typeof findOrderByPaymentIntent !== "function" ||
      typeof event.data?.object?.id !== "string") {
    throw new TypeError("A signed Stripe event, Stripe client, and order lookup are required.");
  }

  const eventId = requiredId(event.id, "evt_", "Event");
  const objectId = event.data.object.id;

  if (REFUND_EVENTS.has(event.type)) {
    const refund = await stripe.refunds.retrieve(requiredId(objectId, "re_", "Refund"));
    assertSandbox(refund, "Refund");
    if (refund.id !== objectId) throw new Error("Retrieved Refund ID does not match the event.");
    const paymentIntentId = requiredId(refund.payment_intent, "pi_", "Refund PaymentIntent");
    const chargeId = requiredId(refund.charge, "ch_", "Refund Charge");
    const chain = await retrieveCanonicalChain({ stripe, paymentIntentId, chargeId, findOrderByPaymentIntent });
    if (refund.amount <= 0 || !Number.isSafeInteger(refund.amount)) {
      throw new Error("Canonical Refund amount is invalid.");
    }
    assertCurrency(refund.currency, "Refund");
    if (!["pending", "succeeded", "failed", "canceled"].includes(refund.status)) {
      throw new Error("Canonical Refund status is unsupported.");
    }
    if (refund.amount > chain.order.expectedAmountMinor) {
      throw new Error("Canonical Refund amount exceeds the original paid amount.");
    }
    return {
      kind: "refund", eventId, eventType: event.type, refundId: refund.id,
      paymentIntentId, chargeId, orderId: chain.order.orderId, userId: chain.order.userId,
      amountMinor: refund.amount, currency: refund.currency.toLowerCase(),
      refundStatus: refund.status, shouldRecordRefund: refund.status === "succeeded",
      evidence: { refund, paymentIntent: chain.paymentIntent, charge: chain.charge, session: chain.session }
    };
  }

  if (DISPUTE_EVENTS.has(event.type)) {
    const dispute = await stripe.disputes.retrieve(requiredId(objectId, "dp_", "Dispute"));
    assertSandbox(dispute, "Dispute");
    if (dispute.id !== objectId) throw new Error("Retrieved Dispute ID does not match the event.");
    const paymentIntentId = requiredId(dispute.payment_intent, "pi_", "Dispute PaymentIntent");
    const chargeId = requiredId(dispute.charge, "ch_", "Dispute Charge");
    const chain = await retrieveCanonicalChain({ stripe, paymentIntentId, chargeId, findOrderByPaymentIntent });
    if (!Number.isSafeInteger(dispute.amount) || dispute.amount <= 0 ||
        dispute.amount > chain.order.expectedAmountMinor) {
      throw new Error("Canonical Dispute amount is invalid.");
    }
    assertCurrency(dispute.currency, "Dispute");
    if (!["needs_response", "under_review", "won", "lost", "warning_needs_response",
      "warning_under_review", "warning_closed"].includes(dispute.status)) {
      throw new Error("Canonical Dispute status is unsupported.");
    }
    return {
      kind: "dispute", eventId, eventType: event.type, disputeId: dispute.id,
      paymentIntentId, chargeId, orderId: chain.order.orderId, userId: chain.order.userId,
      amountMinor: dispute.amount, currency: dispute.currency.toLowerCase(),
      disputeStatus: dispute.status,
      evidence: { dispute, paymentIntent: chain.paymentIntent, charge: chain.charge, session: chain.session }
    };
  }

  throw new Error("Stripe event type is not supported for canonical reconciliation.");
}
