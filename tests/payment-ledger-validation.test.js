import test from "node:test";
import assert from "node:assert/strict";
import {
  attachStripeCheckoutSession,
  applyVerifiedStripePayment
} from "../api/_lib/payment-ledger.js";

test("rejects malformed Checkout Session IDs before database access", async () => {
  await assert.rejects(
    attachStripeCheckoutSession({
      orderId: "order_test",
      userId: "user_test",
      checkoutSessionId: "not-a-session"
    }),
    /valid Stripe Checkout Session identifier/
  );
});

test("rejects malformed Stripe Customer IDs before database access", async () => {
  await assert.rejects(
    attachStripeCheckoutSession({
      orderId: "order_test",
      userId: "user_test",
      checkoutSessionId: "cs_test_123456",
      stripeCustomerId: "not-a-customer"
    }),
    /valid Stripe Customer identifier/
  );
});

test("rejects unsupported event types before database access", async () => {
  await assert.rejects(
    applyVerifiedStripePayment({
      eventId: "evt_123456",
      eventType: "payment_intent.payment_failed",
      orderId: "order_test",
      checkoutSessionId: "cs_test_123456",
      userId: "user_test",
      amountMinor: 1000,
      currency: "myr",
      paymentStatus: "paid"
    }),
    /not a supported paid Checkout event/
  );
});

test("rejects malformed Checkout Session IDs in verified payment input", async () => {
  await assert.rejects(
    applyVerifiedStripePayment({
      eventId: "evt_123456",
      eventType: "checkout.session.completed",
      orderId: "order_test",
      checkoutSessionId: "invalid_session",
      userId: "user_test",
      amountMinor: 1000,
      currency: "myr",
      paymentStatus: "paid"
    }),
    /valid Stripe Checkout Session identifier/
  );
});

test("rejects malformed PaymentIntent IDs in verified payment input", async () => {
  await assert.rejects(
    applyVerifiedStripePayment({
      eventId: "evt_123456",
      eventType: "checkout.session.completed",
      orderId: "order_test",
      checkoutSessionId: "cs_test_123456",
      paymentIntentId: "invalid_intent",
      userId: "user_test",
      amountMinor: 1000,
      currency: "myr",
      paymentStatus: "paid"
    }),
    /valid Stripe PaymentIntent identifier/
  );
});
