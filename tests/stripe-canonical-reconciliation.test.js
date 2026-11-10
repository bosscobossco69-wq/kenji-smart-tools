import test from "node:test";
import assert from "node:assert/strict";
import { reconcileStripeRefundOrDispute } from "../api/_lib/stripe-canonical-reconciliation.js";

function fixture(overrides = {}) {
  const calls = [];
  const paymentIntent = { id: "pi_test_1", livemode: false, status: "succeeded", latest_charge: "ch_test_1" };
  const charge = { id: "ch_test_1", livemode: false, payment_intent: "pi_test_1", paid: true, amount: 5000, currency: "myr" };
  const session = {
    id: "cs_test_1", livemode: false, payment_status: "paid", status: "complete",
    payment_intent: "pi_test_1", amount_total: 5000, currency: "myr",
    metadata: { orderId: "order_1", userId: "user_1" }, customer: "cus_test_1"
  };
  const refund = {
    id: "re_test_1", livemode: false, status: "succeeded", amount: 1200,
    currency: "myr", payment_intent: "pi_test_1", charge: "ch_test_1"
  };
  const dispute = {
    id: "dp_test_1", livemode: false, status: "needs_response",
    amount: 5000, currency: "myr", payment_intent: "pi_test_1", charge: "ch_test_1"
  };
  Object.assign(paymentIntent, overrides.paymentIntent);
  Object.assign(charge, overrides.charge);
  Object.assign(session, overrides.session);
  Object.assign(refund, overrides.refund);
  Object.assign(dispute, overrides.dispute);
  const stripe = {
    refunds: { retrieve: async id => { calls.push(["refund", id]); return refund; } },
    disputes: { retrieve: async id => { calls.push(["dispute", id]); return dispute; } },
    charges: { retrieve: async id => { calls.push(["charge", id]); return charge; } },
    paymentIntents: { retrieve: async id => { calls.push(["pi", id]); return paymentIntent; } },
    checkout: { sessions: { retrieve: async id => { calls.push(["session", id]); return session; } } }
  };
  const order = {
    orderId: "order_1", provider: "stripe", status: "paid", userId: "user_1",
    providerPaymentIntentId: "pi_test_1", providerCheckoutSessionId: "cs_test_1",
    providerCustomerId: "cus_test_1", expectedAmountMinor: 5000, currency: "myr"
  };
  Object.assign(order, overrides.order);
  return { stripe, calls, order, refund, dispute };
}

test("refund reconciliation retrieves canonical objects and validates order linkage", async () => {
  const f = fixture();
  const result = await reconcileStripeRefundOrDispute({
    event: { id: "evt_test_1", type: "refund.updated", data: { object: { id: "re_test_1", amount: 1, currency: "usd" } } },
    stripe: f.stripe,
    findOrderByPaymentIntent: async id => { assert.equal(id, "pi_test_1"); return f.order; }
  });
  assert.equal(result.kind, "refund");
  assert.equal(result.refundId, "re_test_1");
  assert.equal(result.amountMinor, 1200);
  assert.equal(result.orderId, "order_1");
  assert.deepEqual(f.calls.map(x => x[0]), ["refund", "charge", "pi", "session"]);
});

test("dispute reconciliation retrieves canonical objects and validates order linkage", async () => {
  const f = fixture();
  const result = await reconcileStripeRefundOrDispute({
    event: { type: "charge.dispute.created", data: { object: { id: "dp_test_1" } } },
    stripe: f.stripe,
    findOrderByPaymentIntent: async () => f.order
  });
  assert.equal(result.kind, "dispute");
  assert.equal(result.disputeId, "dp_test_1");
  assert.equal(result.disputeStatus, "needs_response");
});

test("refund event payload amount and currency are never trusted", async () => {
  const f = fixture({ refund: { amount: 1200, currency: "myr" } });
  const result = await reconcileStripeRefundOrDispute({
    event: { type: "refund.created", data: { object: { id: "re_test_1", amount: 999999, currency: "usd" } } },
    stripe: f.stripe,
    findOrderByPaymentIntent: async () => f.order
  });
  assert.equal(result.amountMinor, 1200);
  assert.equal(result.currency, "myr");
});

for (const [name, overrides] of [
  ["Live refund", { refund: { livemode: true } }],
  ["wrong charge PaymentIntent", { charge: { payment_intent: "pi_other" } }],
  ["wrong Checkout Session", { session: { payment_intent: "pi_other" } }],
  ["wrong order owner metadata", { session: { metadata: { orderId: "order_1", userId: "attacker" } } }],
  ["wrong customer", { session: { customer: "cus_other" } }],
  ["wrong paid amount", { session: { amount_total: 4999 } }]
]) {
  test(`reconciliation fails closed for ${name}`, async () => {
    const f = fixture(overrides);
    await assert.rejects(() => reconcileStripeRefundOrDispute({
      event: { type: "refund.created", data: { object: { id: "re_test_1" } } },
      stripe: f.stripe,
      findOrderByPaymentIntent: async () => f.order
    }));
  });
}

test("pending refund is returned as pending and is not treated as a completed refund", async () => {
  const f = fixture({ refund: { status: "pending" } });
  const result = await reconcileStripeRefundOrDispute({
    event: { type: "refund.updated", data: { object: { id: "re_test_1" } } },
    stripe: f.stripe,
    findOrderByPaymentIntent: async () => f.order
  });
  assert.equal(result.refundStatus, "pending");
  assert.equal(result.shouldRecordRefund, false);
});

test("unknown event types are rejected without retrieving Stripe objects", async () => {
  const f = fixture();
  await assert.rejects(() => reconcileStripeRefundOrDispute({
    event: { type: "charge.refunded", data: { object: { id: "ch_test_1" } } },
    stripe: f.stripe,
    findOrderByPaymentIntent: async () => f.order
  }));
  assert.equal(f.calls.length, 0);
});
