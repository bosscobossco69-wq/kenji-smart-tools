import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getApps, deleteApp } from "firebase-admin/app";
import { getFirebaseAdmin } from "../api/_lib/firebase-admin.js";
import {
  createPendingPaymentOrder,
  attachStripeCheckoutSession,
  applyVerifiedStripePayment,
  spendCredits,
  recordVerifiedPaymentOrderOutcome
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
  const retry = await applyVerifiedStripePayment({
    ...base, eventId: `evt_${randomUUID().replaceAll("-", "")}`
  });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.applied, false);
  const { db } = getFirebaseAdmin();
  const balance = await db.collection("creditBalances").doc(userId).get();
  assert.equal(balance.get("balance"), 25);
  const ledger = await db.collection("creditLedger").where("orderId", "==", created.orderId).get();
  assert.equal(ledger.size, 1);
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
  assert.equal(attempts.filter(x => x.status === "fulfilled" && x.value.duplicate).length, 1);
  assert.equal(attempts.filter(x => x.status === "rejected").length, 0);
  const { db } = getFirebaseAdmin();
  const balance = await db.collection("creditBalances").doc(userId).get();
  assert.equal(balance.get("balance"), 25);
  const ledger = await db.collection("creditLedger").where("orderId", "==", created.orderId).get();
  assert.equal(ledger.size, 1);
  assert.equal(ledger.docs[0].get("amount"), 25);
});

integration("Firestore ledger: expired orders cannot attach a Checkout Session", async () => {
  const userId = `test_${randomUUID()}`;
  const created = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  });
  const { db } = getFirebaseAdmin();
  await db.collection("paymentOrders").doc(created.orderId).update({ status: "expired" });
  await assert.rejects(attachStripeCheckoutSession({
    orderId: created.orderId, userId,
    checkoutSessionId: `cs_test_${randomUUID().replaceAll("-", "")}`
  }), /not pending/);
});

integration("Firestore ledger: failed orders cannot be paid by a later event", async () => {
  const userId = `test_${randomUUID()}`;
  const created = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  });
  const sessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
  await attachStripeCheckoutSession({ orderId: created.orderId, userId, checkoutSessionId: sessionId });
  const { db } = getFirebaseAdmin();
  await db.collection("paymentOrders").doc(created.orderId).update({ status: "failed" });
  await assert.rejects(applyVerifiedStripePayment({
    eventId: `evt_${randomUUID().replaceAll("-", "")}`,
    eventType: "checkout.session.completed",
    orderId: created.orderId,
    checkoutSessionId: sessionId,
    userId,
    amountMinor: 2500,
    currency: "myr",
    paymentStatus: "paid"
  }), /not pending/);
  const order = await db.collection("paymentOrders").doc(created.orderId).get();
  assert.equal(order.get("status"), "failed");
  const ledger = await db.collection("creditLedger").where("orderId", "==", created.orderId).get();
  assert.equal(ledger.size, 0);
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


integration("Firestore ledger: verified payment updates materialized balance exactly once", async () => {
  const userId = `test_${randomUUID()}`;
  const created = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  });
  const sessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
  await attachStripeCheckoutSession({ orderId: created.orderId, userId, checkoutSessionId: sessionId });
  const payment = {
    eventId: `evt_${randomUUID().replaceAll("-", "")}`, eventType: "checkout.session.completed",
    orderId: created.orderId, checkoutSessionId: sessionId,
    paymentIntentId: `pi_${randomUUID().replaceAll("-", "")}`, userId,
    amountMinor: 2500, currency: "myr", paymentStatus: "paid"
  };
  await applyVerifiedStripePayment(payment);
  await applyVerifiedStripePayment(payment);
  const { db } = getFirebaseAdmin();
  const balance = await db.collection("creditBalances").doc(userId).get();
  assert.equal(balance.get("balance"), 25);
  const grants = await db.collection("creditLedger").where("orderId", "==", created.orderId).get();
  assert.equal(grants.size, 1);
});

integration("Firestore ledger: spend is atomic, immutable and idempotent", async () => {
  const userId = `test_${randomUUID()}`;
  const created = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  });
  const sessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
  await attachStripeCheckoutSession({ orderId: created.orderId, userId, checkoutSessionId: sessionId });
  await applyVerifiedStripePayment({
    eventId: `evt_${randomUUID().replaceAll("-", "")}`, eventType: "checkout.session.completed",
    orderId: created.orderId, checkoutSessionId: sessionId, userId,
    amountMinor: 2500, currency: "myr", paymentStatus: "paid"
  });
  const input = { userId, amount: 7, idempotencyKey: `spend_${randomUUID()}_key`, reference: "tool_run_1" };
  const first = await spendCredits(input);
  const retry = await spendCredits(input);
  assert.equal(first.balanceAfter, 18);
  assert.equal(first.duplicate, false);
  assert.equal(retry.balanceAfter, 18);
  assert.equal(retry.duplicate, true);
  const { db } = getFirebaseAdmin();
  const balance = await db.collection("creditBalances").doc(userId).get();
  assert.equal(balance.get("balance"), 18);
  const ledger = await db.collection("creditLedger").where("userId", "==", userId).get();
  const spends = ledger.docs.filter(doc => doc.get("entryType") === "spend");
  assert.equal(spends.length, 1);
  assert.equal(spends[0].get("amount"), -7);
});

integration("Firestore ledger: spend rejects changed idempotency payload and insufficient balance", async () => {
  const userId = `test_${randomUUID()}`;
  const created = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 5, billingInterval: "one_time"
  });
  const sessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
  await attachStripeCheckoutSession({ orderId: created.orderId, userId, checkoutSessionId: sessionId });
  await applyVerifiedStripePayment({
    eventId: `evt_${randomUUID().replaceAll("-", "")}`, eventType: "checkout.session.completed",
    orderId: created.orderId, checkoutSessionId: sessionId, userId,
    amountMinor: 2500, currency: "myr", paymentStatus: "paid"
  });
  const key = `spend_${randomUUID()}_key`;
  await spendCredits({ userId, amount: 2, idempotencyKey: key, reference: "run_a" });
  await assert.rejects(spendCredits({ userId, amount: 3, idempotencyKey: key, reference: "run_a" }), /different details/);
  await assert.rejects(spendCredits({ userId, amount: 4, idempotencyKey: `spend_${randomUUID()}_key`, reference: "run_b" }), /Insufficient Credits/);
  const { db } = getFirebaseAdmin();
  const balance = await db.collection("creditBalances").doc(userId).get();
  assert.equal(balance.get("balance"), 3);
});

integration("Firestore ledger: concurrent spends cannot overspend", async () => {
  const userId = `test_${randomUUID()}`;
  const created = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 10, billingInterval: "one_time"
  });
  const sessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
  await attachStripeCheckoutSession({ orderId: created.orderId, userId, checkoutSessionId: sessionId });
  await applyVerifiedStripePayment({
    eventId: `evt_${randomUUID().replaceAll("-", "")}`, eventType: "checkout.session.completed",
    orderId: created.orderId, checkoutSessionId: sessionId, userId,
    amountMinor: 2500, currency: "myr", paymentStatus: "paid"
  });
  const attempts = await Promise.allSettled([
    spendCredits({ userId, amount: 7, idempotencyKey: `spend_${randomUUID()}_key`, reference: "parallel_a" }),
    spendCredits({ userId, amount: 7, idempotencyKey: `spend_${randomUUID()}_key`, reference: "parallel_b" })
  ]);
  assert.equal(attempts.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(attempts.filter(x => x.status === "rejected").length, 1);
  const { db } = getFirebaseAdmin();
  const balance = await db.collection("creditBalances").doc(userId).get();
  assert.equal(balance.get("balance"), 3);
});


integration("Firestore ledger: missing materialized balance with prior ledger history fails closed", async () => {
  const userId = `test_${randomUUID()}`;
  const { db } = getFirebaseAdmin();
  await db.collection("creditLedger").doc(`legacy_${randomUUID()}`).set({
    userId, entryType: "grant", amount: 12, createdAt: new Date()
  });
  await assert.rejects(spendCredits({
    userId, amount: 1, idempotencyKey: `spend_${randomUUID()}_key`, reference: "legacy_balance_check"
  }), /balance is missing/);
  const created = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 5, billingInterval: "one_time"
  });
  const sessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
  await attachStripeCheckoutSession({ orderId: created.orderId, userId, checkoutSessionId: sessionId });
  await assert.rejects(applyVerifiedStripePayment({
    eventId: `evt_${randomUUID().replaceAll("-", "")}`, eventType: "checkout.session.completed",
    orderId: created.orderId, checkoutSessionId: sessionId, userId,
    amountMinor: 2500, currency: "myr", paymentStatus: "paid"
  }), /balance is missing/);
  const order = await db.collection("paymentOrders").doc(created.orderId).get();
  assert.equal(order.get("status"), "pending");
});

integration("Firestore ledger: malformed materialized balance fails closed", async () => {
  const userId = `test_${randomUUID()}`;
  const { db } = getFirebaseAdmin();
  await db.collection("creditBalances").doc(userId).set({ userId, balance: -4 });
  await assert.rejects(spendCredits({
    userId, amount: 1, idempotencyKey: `spend_${randomUUID()}_key`, reference: "malformed_balance_check"
  }), /malformed/);
  const created = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 5, billingInterval: "one_time"
  });
  const sessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
  await attachStripeCheckoutSession({ orderId: created.orderId, userId, checkoutSessionId: sessionId });
  await assert.rejects(applyVerifiedStripePayment({
    eventId: `evt_${randomUUID().replaceAll("-", "")}`, eventType: "checkout.session.completed",
    orderId: created.orderId, checkoutSessionId: sessionId, userId,
    amountMinor: 2500, currency: "myr", paymentStatus: "paid"
  }), /malformed/);
  const order = await db.collection("paymentOrders").doc(created.orderId).get();
  assert.equal(order.get("status"), "pending");
  const balance = await db.collection("creditBalances").doc(userId).get();
  assert.equal(balance.get("balance"), -4);
});

test("Firestore emulator integration suite is explicitly opt-in", { skip: emulatorEnabled }, () => {
  assert.equal(emulatorEnabled, false);
});

test.after(async () => {
  for (const app of getApps()) await deleteApp(app);
});


integration("Firestore ledger: verified expired session transitions pending order once", async () => {
  const userId = `test_${randomUUID()}`;
  const created = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  });
  const sessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
  await attachStripeCheckoutSession({ orderId: created.orderId, userId, checkoutSessionId: sessionId });
  const evidence = { sessionStatus: "expired", paymentStatus: "unpaid", expiresAt: Math.floor(Date.now() / 1000) - 60 };
  const first = await recordVerifiedPaymentOrderOutcome({ outcome: "expired", orderId: created.orderId, userId, checkoutSessionId: sessionId, evidence });
  const second = await recordVerifiedPaymentOrderOutcome({ outcome: "expired", orderId: created.orderId, userId, checkoutSessionId: sessionId, evidence });
  assert.equal(first.status, "expired");
  assert.equal(second.duplicate, true);
});

integration("Firestore ledger: paid order cannot be downgraded by verified failure", async () => {
  const userId = `test_${randomUUID()}`;
  const created = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  });
  const sessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
  await attachStripeCheckoutSession({ orderId: created.orderId, userId, checkoutSessionId: sessionId });
  await applyVerifiedStripePayment({
    eventId: `evt_${randomUUID().replaceAll("-", "")}`, eventType: "checkout.session.completed",
    orderId: created.orderId, checkoutSessionId: sessionId, userId,
    amountMinor: 2500, currency: "myr", paymentStatus: "paid"
  });
  await assert.rejects(recordVerifiedPaymentOrderOutcome({
    outcome: "failed", orderId: created.orderId, userId, checkoutSessionId: sessionId,
    evidence: { paymentIntentId: `pi_${randomUUID().replaceAll("-", "")}`, paymentIntentStatus: "canceled" }
  }), /cannot be downgraded/);
});

integration("Firestore ledger: expired transition rejects an active or paid session", async () => {
  const userId = `test_${randomUUID()}`;
  const created = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  });
  const sessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
  await attachStripeCheckoutSession({ orderId: created.orderId, userId, checkoutSessionId: sessionId });
  await assert.rejects(recordVerifiedPaymentOrderOutcome({
    outcome: "expired", orderId: created.orderId, userId, checkoutSessionId: sessionId,
    evidence: { sessionStatus: "open", paymentStatus: "unpaid", expiresAt: Math.floor(Date.now() / 1000) + 3600 }
  }), /requires an expired, unpaid/);
});


integration("Firestore ledger: verified canceled PaymentIntent marks pending order failed", async () => {
  const userId = `test_${randomUUID()}`;
  const created = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  });
  const sessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
  await attachStripeCheckoutSession({ orderId: created.orderId, userId, checkoutSessionId: sessionId });
  const result = await recordVerifiedPaymentOrderOutcome({
    outcome: "failed", orderId: created.orderId, userId, checkoutSessionId: sessionId,
    evidence: { paymentIntentId: `pi_${randomUUID().replaceAll("-", "")}`, paymentIntentStatus: "canceled" }
  });
  assert.equal(result.status, "failed");
  const { db } = getFirebaseAdmin();
  const order = await db.collection("paymentOrders").doc(created.orderId).get();
  assert.equal(order.get("status"), "failed");
  const ledger = await db.collection("creditLedger").where("orderId", "==", created.orderId).get();
  assert.equal(ledger.size, 0);
});

integration("Firestore ledger: late success evidence after expiry is routed to review", async () => {
  const userId = `test_${randomUUID()}`;
  const created = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  });
  const sessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
  await attachStripeCheckoutSession({ orderId: created.orderId, userId, checkoutSessionId: sessionId });
  await recordVerifiedPaymentOrderOutcome({
    outcome: "expired", orderId: created.orderId, userId, checkoutSessionId: sessionId,
    evidence: { sessionStatus: "expired", paymentStatus: "unpaid", expiresAt: Math.floor(Date.now() / 1000) - 60 }
  });
  await assert.rejects(applyVerifiedStripePayment({
    eventId: `evt_${randomUUID().replaceAll("-", "")}`, eventType: "checkout.session.completed",
    orderId: created.orderId, checkoutSessionId: sessionId, userId,
    amountMinor: 2500, currency: "myr", paymentStatus: "paid"
  }), /not pending/);
  const review = await recordVerifiedPaymentOrderOutcome({
    outcome: "review_required", orderId: created.orderId, userId, checkoutSessionId: sessionId,
    evidence: { reference: `evt_${randomUUID().replaceAll("-", "")}`, reason: "Late success evidence conflicts with expired order state." }
  });
  assert.equal(review.status, "review_required");
  const { db } = getFirebaseAdmin();
  const order = await db.collection("paymentOrders").doc(created.orderId).get();
  assert.equal(order.get("status"), "review_required");
  const ledger = await db.collection("creditLedger").where("orderId", "==", created.orderId).get();
  assert.equal(ledger.size, 0);
});

integration("Firestore ledger: failure evidence must be canonical canceled state", async () => {
  const userId = `test_${randomUUID()}`;
  const created = await createPendingPaymentOrder({
    userId, planId: "sandbox_plan", idempotencyKey: `idem_${randomUUID()}_key`,
    amountMinor: 2500, currency: "myr", creditsGrant: 25, billingInterval: "one_time"
  });
  const sessionId = `cs_test_${randomUUID().replaceAll("-", "")}`;
  await attachStripeCheckoutSession({ orderId: created.orderId, userId, checkoutSessionId: sessionId });
  await assert.rejects(recordVerifiedPaymentOrderOutcome({
    outcome: "failed", orderId: created.orderId, userId, checkoutSessionId: sessionId,
    evidence: { paymentIntentId: `pi_${randomUUID().replaceAll("-", "")}`, paymentIntentStatus: "processing" }
  }), /canceled PaymentIntent/);
  const { db } = getFirebaseAdmin();
  const order = await db.collection("paymentOrders").doc(created.orderId).get();
  assert.equal(order.get("status"), "pending");
});
