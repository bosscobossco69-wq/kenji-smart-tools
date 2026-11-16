import { FieldValue } from "firebase-admin/firestore";
import { assertStripeObject, billingCollection } from "./billing-environment.js";

export const ADJUSTMENT_EVENTS = new Set([
  "charge.refunded", "refund.created", "refund.updated", "refund.failed",
  "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed",
  "radar.early_fraud_warning.created", "radar.early_fraud_warning.updated"
]);
const idOf = value => typeof value === "string" ? value : value?.id;

// Reconcile cumulative *current* Stripe state, never debit per webhook delivery.
// A sequence allocated before retrieval fences slower, older snapshots.
export async function reconcileAdjustment({ stripe, db, event }) {
  const object = event.data.object;
  let chargeId = event.type === "charge.refunded" ? object.id : idOf(object.charge);
  if (!chargeId && object.payment_intent) {
    const intent = await stripe.paymentIntents.retrieve(idOf(object.payment_intent));
    assertStripeObject(intent);
    chargeId = idOf(intent.latest_charge);
  }
  if (!chargeId) throw new Error("Payment adjustment has no charge.");
  const stateRef = db.collection("stripeChargeAdjustments").doc(chargeId);
  const claim = await db.runTransaction(async tx => {
    const snap = await tx.get(stateRef);
    const previous = snap.data() || {};
    const sequence = Number(previous.sequence || 0) + 1;
    tx.set(stateRef, { sequence }, { merge: true });
    return { sequence, disputeId: previous.disputeId || null, fraudWarningId: previous.fraudWarningId || null };
  });
  const charge = await stripe.charges.retrieve(chargeId);
  assertStripeObject(charge);
  if (!charge.payment_intent) {
    await stateRef.set({ manualReview: true, reason: "legacy_non_intent_charge", stripeEventId: event.id }, { merge: true });
    return;
  }
  const intent = await stripe.paymentIntents.retrieve(idOf(charge.payment_intent));
  assertStripeObject(intent);
  const metadata = intent.metadata || {};
  const uid = metadata.firebaseUID;
  const orderId = metadata.orderId;
  // Subscription/legacy payments have no one-time pack provenance. Keep a durable
  // review queue; never guess a user from email or subtract unrelated Credits.
  if (metadata.purchaseType !== "credit_pack" || !uid || !orderId) {
    await stateRef.set({ manualReview: true, reason: "subscription_or_legacy_payment", stripeEventId: event.id }, { merge: true });
    return;
  }
  let refunded = 0, startingAfter;
  while (true) {
    const page = await stripe.refunds.list({ charge: chargeId, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    for (const refund of page.data) {
      assertStripeObject(refund);
      if (refund.status === "succeeded") refunded += refund.amount;
    }
    if (!page.has_more) break;
    if (!page.data.length) throw new Error("Invalid refunds pagination.");
    startingAfter = page.data.at(-1).id;
  }
  const disputeId = event.type.startsWith("charge.dispute.") ? object.id : claim.disputeId;
  let disputeHold = Boolean(charge.disputed), disputeStatus = null;
  if (disputeId) {
    const dispute = await stripe.disputes.retrieve(disputeId);
    assertStripeObject(dispute);
    if (idOf(dispute.charge) !== chargeId) throw new Error("Dispute charge mismatch.");
    disputeStatus = dispute.status;
    disputeHold = !["won", "warning_closed"].includes(dispute.status);
  }
  const fraudWarningId = event.type.startsWith("radar.early_fraud_warning.") ? object.id : claim.fraudWarningId;
  let fraudHold = false;
  if (fraudWarningId) {
    const warning = await stripe.radar.earlyFraudWarnings.retrieve(fraudWarningId);
    assertStripeObject(warning);
    if (idOf(warning.charge) !== chargeId) throw new Error("Fraud warning charge mismatch.");
    fraudHold = warning.actionable === true;
  }
  const orderRef = db.collection("billingOrders").doc(orderId);
  const billingRef = db.collection("users").doc(uid).collection(billingCollection()).doc("current");
  const grantRef = db.collection("users").doc(uid).collection("creditLedger").doc("stripe_pack_" + orderId);
  const adjustmentRef = db.collection("users").doc(uid).collection("creditLedger").doc("stripe_adjustment_" + chargeId + "_" + claim.sequence);
  await db.runTransaction(async tx => {
    const [stateSnap, orderSnap, grantSnap, billingSnap] = await Promise.all([
      tx.get(stateRef), tx.get(orderRef), tx.get(grantRef), tx.get(billingRef)
    ]);
    const state = stateSnap.data() || {};
    if (state.sequence !== claim.sequence) return;
    const order = orderSnap.data(), grant = grantSnap.data();
    if (!order || !grant || order.uid !== uid || order.type !== "credit_pack" ||
        grant.stripePaymentIntentId !== intent.id || order.stripePaymentIntentId !== intent.id ||
        order.currency !== charge.currency || order.amount !== charge.amount ||
        !Number.isSafeInteger(grant.credits) || grant.credits <= 0) {
      throw new Error("Adjustment is waiting for its validated pack grant.");
    }
    if (!Number.isSafeInteger(refunded) || refunded < 0 || refunded > charge.amount || charge.amount <= 0) {
      throw new Error("Invalid cumulative refund amount.");
    }
    const target = disputeHold || fraudHold ? grant.credits : Math.min(grant.credits, Math.ceil(grant.credits * refunded / charge.amount));
    const previous = Number(state.revokedCredits || 0);
    const delta = previous - target;
    const balance = Number(billingSnap.data()?.creditBalance || 0);
    if (!Number.isSafeInteger(balance) || !Number.isSafeInteger(delta)) throw new Error("Invalid adjustment balance.");
    if (delta) {
      // Allow debt for spent Credits. Future purchases offset it; no free balance
      // is manufactured by clamping a refund at zero.
      tx.set(billingRef, { creditBalance: balance + delta, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.create(adjustmentRef, {
        type: "stripe_payment_adjustment", credits: delta, stripeChargeId: chargeId,
        stripeEventId: event.id, orderId, refundedAmount: refunded,
        disputeStatus, createdAt: FieldValue.serverTimestamp()
      });
    }
    tx.set(stateRef, {
      revokedCredits: target, refundedAmount: refunded, disputeId: disputeId || null,
      fraudWarningId: fraudWarningId || null, disputeStatus, manualReview: fraudHold || (charge.disputed && !disputeId),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    tx.set(orderRef, { refundedAmount: refunded, revokedCredits: target, disputeStatus, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
}
