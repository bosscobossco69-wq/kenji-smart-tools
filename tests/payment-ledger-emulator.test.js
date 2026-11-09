import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getApps, deleteApp } from "firebase-admin/app";
import { getFirebaseAdmin } from "../api/_lib/firebase-admin.js";
import {
  createPendingPaymentOrder,
  attachStripeCheckoutSession,
  applyVerifiedStripePayment
} from "../api/_lib/payment-ledger.js";

const emulatorEnabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const integration = emulatorEnabled ? test : test.skip;

integration("Firestore ledger: same idempotency key reuses the same order", async () => {
  const userId = `test_${randomUUID()}`;
  const key = `idem_${randomUUID()}_key`;
  const first = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: key,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  });
  const second = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: key,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  });
  assert.equal(first.orderId, second.orderId);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.order.status, "pending");
});

integration("Firestore ledger: reused idempotency key rejects changed order details", async () => {
  const userId = `test_${randomUUID()}`;
  const key = `idem_${randomUUID()}_key`;
  await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: key,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  });
  await assert.rejects(createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: key,
    amountMinor: 5000, currency: "myr", creditsGrant: 50, billingInterval: "one_time"
  }), /different order details/);
});

integration("Firestore ledger: duplicate Stripe event grants Credits exactly once", async () => {
  const userId = `test_${randomUUID()}`;
  const created = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  });
  const sessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
  await attachStripeCheckoutSession({ orderId: created.orderId, userId, checkoutSessionId: sessionId });
  const payment = {
    eventId: `evt_${randomUUID().replaceAll("-", "")}`,
    eventType: "checkout.session.completed",
    orderId: created.orderId,
    checkoutSessionId: sessionId,
    paymentIntentId: `pi_${randomUUID().replaceAll("-", "")}`,
    userId,
    amountMinor: 2500,
    currency: "myr",
    paymentStatus: "paid"
  };
  const first = await applyVerifiedStripePayment(payment);
  const second = await applyVerifiedStripePayment(payment);
  assert.equal(first.applied, true);
  assert.equal(first.creditsGranted, 25);
  assert.equal(second.duplicate, true);
  assert.equal(second.applied, false);

  const { db } = getFirebaseAdmin();
  const ledger = await db.collection("creditLedger").where("orderId", "==", created.orderId).get();
  assert.equal(ledger.size, 1);
  assert.equal(ledger.docs[0].get("amount"), 25);
  assert.equal(ledger.docs[0].get("entryType"), "grant");
});

integration("Firestore ledger: a second event cannot pay an already-paid order", async () => {
  const userId = `test_${randomUUID()}`;
  const created = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  });
  const sessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
  await attachStripeCheckoutSession({ orderId: created.orderId, userId, checkoutSessionId: sessionId });
  const base = {
    eventType: "checkout.session.completed",
    orderId: created.orderId,
    checkoutSessionId: sessionId,
    userId,
    amountMinor: 2500,
    currency: "myr",
    paymentStatus: "paid"
  };
  await applyVerifiedStripePayment({ ...base, eventId: `evt_${randomUUID().replaceAll("-", "")}` });
  await assert.rejects(applyVerifiedStripePayment({
    ...base, eventId: `evt_${randomUUID().replaceAll("-", "")}`
  }), /already paid/);
});

integration("Firestore ledger: amount mismatch does not mark order paid", async () => {
  const userId = `test_${randomUUID()}`;
  const created = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  });
  const sessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
  await attachStripeCheckoutSession({ orderId: created.orderId, userId, checkoutSessionId: sessionId });
  await assert.rejects(applyVerifiedStripePayment({
    eventId: `evt_${randomUUID().replaceAll("-", "")}`,
    eventType: "checkout.session.completed",
    orderId: created.orderId,
    checkoutSessionId: sessionId,
    userId,
    amountMinor: 9999,
    currency: "myr",
    paymentStatus: "paid"
  }), /does not match the order/);
  const { db } = getFirebaseAdmin();
  const order = await db.collection("paymentOrders").doc(created.orderId).get();
  assert.equal(order.get("status"), "pending");
});

test("Firestore emulator integration suite is explicitly opt-in", { skip: emulatorEnabled }, () => {
  assert.equal(emulatorEnabled, false);
});

test.after(async () => {
  for (const app of getApps()) await deleteApp(app);
});
