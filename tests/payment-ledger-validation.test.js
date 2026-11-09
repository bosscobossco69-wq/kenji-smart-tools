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

import { normalizeActivePaymentPlan } from "../api/_lib/payment-plans.js";

const validPlan = {
  active: true,
  name: "Credits Pack",
  unitAmountMinor: 2500,
  currency: "myr",
  creditsGrant: 25,
  billingInterval: "one_time"
};

test("normalizes a valid active MYR one-time Credits plan", () => {
  assert.deepEqual(normalizeActivePaymentPlan("credits_basic", validPlan), {
    id: "credits_basic",
    name: "Credits Pack",
    unitAmountMinor: 2500,
    currency: "myr",
    creditsGrant: 25,
    billingInterval: "one_time",
    active: true
  });
});

test("rejects inactive or malformed server-side plan records", () => {
  assert.throws(() => normalizeActivePaymentPlan("credits_basic", { ...validPlan, active: false }), {
    message: "This membership plan is not available."
  });
  assert.throws(() => normalizeActivePaymentPlan("credits_basic", null), /plan record is invalid/);
  assert.throws(() => normalizeActivePaymentPlan("../admin", validPlan), /Invalid membership plan/);
});

test("rejects non-MYR currency and invalid price or Credits values", () => {
  assert.throws(() => normalizeActivePaymentPlan("credits_basic", { ...validPlan, currency: "usd" }), /currency must be MYR/);
  assert.throws(() => normalizeActivePaymentPlan("credits_basic", { ...validPlan, unitAmountMinor: 0 }), /plan price is not configured/);
  assert.throws(() => normalizeActivePaymentPlan("credits_basic", { ...validPlan, unitAmountMinor: Number.MAX_SAFE_INTEGER + 1 }), /plan price is not configured/);
  assert.throws(() => normalizeActivePaymentPlan("credits_basic", { ...validPlan, creditsGrant: -1 }), /Credits grant is not configured/);
  assert.throws(() => normalizeActivePaymentPlan("credits_basic", { ...validPlan, creditsGrant: 1.5 }), /Credits grant is not configured/);
});

test("normalizes supported interval values but rejects unknown intervals", () => {
  for (const billingInterval of ["one_time", "month", "year"]) {
    assert.equal(normalizeActivePaymentPlan("credits_basic", { ...validPlan, billingInterval }).billingInterval, billingInterval);
  }
  assert.throws(() => normalizeActivePaymentPlan("credits_basic", { ...validPlan, billingInterval: "weekly" }), /billing interval is not configured/);
});
