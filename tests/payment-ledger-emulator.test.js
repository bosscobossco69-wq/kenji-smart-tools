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

integration("Firestore ledger: concurrent same-key order creation reuses one order", async () => {
  const userId = `test_${randomUUID()}`;
  const idempotencyKey = `idem_${randomUUID()}_key`;
  const input = {
    userId, planId: "sandbox_plan", idempotencyKey,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  };
  const results = await Promise.all([
    createPendingPaymentOrder(input),
    createPendingPaymentOrder(input)
  ]);
  assert.equal(results[0].orderId, results[1].orderId);
  assert.equal(results.filter(x => x.reused).length, 1);
  const { db } = getFirebaseAdmin();
  const orders = await db.collection("paymentOrders").where("userId", "==", userId).get();
  assert.equal(orders.size, 1);
});

integration("Firestore ledger: idempotent retry preserves attached Checkout Session", async () => {
  const userId = `test_${randomUUID()}`;
  const input = {
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  };
  const created = await createPendingPaymentOrder(input);
  const sessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
  await attachStripeCheckoutSession({ orderId: created.orderId, userId, checkoutSessionId: sessionId });
  const retry = await createPendingPaymentOrder(input);
  assert.equal(retry.orderId, created.orderId);
  assert.equal(retry.reused, true);
  assert.equal(retry.order.providerCheckoutSessionId, sessionId);
  assert.equal(retry.order.status, "pending");
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

integration("Firestore ledger: identical Checkout Session attachment is idempotent", async () => {
  const userId = `test_${randomUUID()}`;
  const created = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  });
  const sessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
  const first = await attachStripeCheckoutSession({ orderId: created.orderId, userId, checkoutSessionId: sessionId });
  const second = await attachStripeCheckoutSession({ orderId: created.orderId, userId, checkoutSessionId: sessionId });
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
});

integration("Firestore ledger: a different Checkout Session cannot replace an attached one", async () => {
  const userId = `test_${randomUUID()}`;
  const created = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  });
  const sessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
  await attachStripeCheckoutSession({ orderId: created.orderId, userId, checkoutSessionId: sessionId });
  await assert.rejects(attachStripeCheckoutSession({
    orderId: created.orderId, userId,
    checkoutSessionId: `cs_test_${randomUUID().replaceAll("-", "")}`
  }), /different Checkout Session is already attached/);
});

integration("Firestore ledger: another user cannot attach a Checkout Session", async () => {
  const userId = `test_${randomUUID()}`;
  const created = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  });
  await assert.rejects(attachStripeCheckoutSession({
    orderId: created.orderId, userId: `other_${randomUUID()}`,
    checkoutSessionId: `cs_test_${randomUUID().replaceAll("-", "")}`
  }), /ownership\/provider mismatch/);
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

integration("Firestore ledger: concurrent distinct events can grant Credits only once", async () => {
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
  const attempts = await Promise.allSettled([
    applyVerifiedStripePayment({ ...base, eventId: `evt_${randomUUID().replaceAll("-", "")}` }),
    applyVerifiedStripePayment({ ...base, eventId: `evt_${randomUUID().replaceAll("-", "")}` })
  ]);
  assert.equal(attempts.filter(x => x.status === "fulfilled" && x.value.applied).length, 1);
  assert.equal(attempts.filter(x => x.status === "rejected").length, 1);
  const { db } = getFirebaseAdmin();
  const ledger = await db.collection("creditLedger").where("orderId", "==", created.orderId).get();
  assert.equal(ledger.size, 1);
  assert.equal(ledger.docs[0].get("amount"), 25);
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
