import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getApps, deleteApp } from "firebase-admin/app";
import { getFirebaseAdmin } from "../api/_lib/firebase-admin.js";
import {
  createPendingPaymentOrder,
  attachStripeCheckoutSession,
  applyVerifiedStripePayment,
  applyVerifiedStripeRefund,
  recordVerifiedStripeDispute
} from "../api/_lib/payment-ledger.js";

const emulatorEnabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const integration = emulatorEnabled ? test : test.skip;

async function paidOrder({ credits = 100, amountMinor = 10000 } = {}) {
  const userId = `refund_test_${randomUUID()}`;
  const order = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor, currency: "myr", creditsGrant: credits, billingInterval: "one_time"
  });
  const checkoutSessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
  const paymentIntentId = `pi_${randomUUID().replaceAll("-", "")}`;
  await attachStripeCheckoutSession({ orderId: order.orderId, userId, checkoutSessionId });
  await applyVerifiedStripePayment({
    eventId: `evt_${randomUUID().replaceAll("-", "")}`,
    eventType: "checkout.session.completed",
    orderId: order.orderId, checkoutSessionId, paymentIntentId, userId,
    amountMinor, currency: "myr", paymentStatus: "paid"
  });
  return { userId, orderId: order.orderId, paymentIntentId };
}

integration("refund ledger rejects cumulative refunds above the paid amount", async () => {
  const paid = await paidOrder({ credits: 100, amountMinor: 10000 });
  const base = {
    paymentIntentId: paid.paymentIntentId, orderId: paid.orderId, userId: paid.userId,
    currency: "myr", refundStatus: "succeeded"
  };
  await applyVerifiedStripeRefund({
    ...base, refundId: `re_${randomUUID().replaceAll("-", "")}`,
    amountMinor: 6000, evidenceFingerprint: "1".repeat(64)
  });
  await assert.rejects(applyVerifiedStripeRefund({
    ...base, refundId: `re_${randomUUID().replaceAll("-", "")}`,
    amountMinor: 5000, evidenceFingerprint: "2".repeat(64)
  }), /Cumulative refunds exceed the paid amount/);
  const { db } = getFirebaseAdmin();
  const receipts = await db.collection("refundReceipts").where("orderId", "==", paid.orderId).get();
  assert.equal(receipts.size, 1);
});

integration("refund ledger rejects reused refund ID with conflicting evidence", async () => {
  const paid = await paidOrder();
  const refundId = `re_${randomUUID().replaceAll("-", "")}`;
  const input = {
    refundId, paymentIntentId: paid.paymentIntentId, orderId: paid.orderId,
    userId: paid.userId, amountMinor: 2500, currency: "myr",
    refundStatus: "succeeded", evidenceFingerprint: "3".repeat(64)
  };
  await applyVerifiedStripeRefund(input);
  await assert.rejects(applyVerifiedStripeRefund({
    ...input, amountMinor: 3000, evidenceFingerprint: "4".repeat(64)
  }), /conflicting evidence/);
});

integration("lost dispute is recorded for human review and never changes Credits", async () => {
  const paid = await paidOrder({ credits: 20, amountMinor: 2000 });
  const input = {
    disputeId: `dp_${randomUUID().replaceAll("-", "")}`,
    eventId: `evt_${randomUUID().replaceAll("-", "")}`,
    eventType: "charge.dispute.closed",
    orderId: paid.orderId, userId: paid.userId,
    paymentIntentId: paid.paymentIntentId,
    disputeStatus: "lost", evidenceFingerprint: "5".repeat(64)
  };
  const result = await recordVerifiedStripeDispute(input);
  assert.equal(result.humanReviewRequired, true);
  const { db } = getFirebaseAdmin();
  const balance = await db.collection("creditBalances").doc(paid.userId).get();
  assert.equal(balance.get("balance"), 20);
  const events = await db.collection("disputeEvents").where("eventId", "==", input.eventId).get();
  assert.equal(events.size, 1);
  assert.equal(events.docs[0].get("processingStatus"), "human_review_required");
});

test("refund/dispute emulator suite is explicitly opt-in", { skip: emulatorEnabled }, () => {
  assert.equal(emulatorEnabled, false);
});

test.after(async () => {
  for (const app of getApps()) await deleteApp(app);
});
