import test from "node:test";
import assert from "node:assert/strict";
import { createStripeClient } from "../api/_lib/stripe-client.js";

test("creates a Stripe client only with a test-mode secret", () => {
  let received;
  class FakeStripe {
    constructor(key, options) {
      received = { key, options };
    }
  }

  const client = createStripeClient({
    secretKey: "sk_test_example",
    StripeConstructor: FakeStripe
  });

  assert.ok(client instanceof FakeStripe);
  assert.equal(received.key, "sk_test_example");
  assert.equal(received.options.maxNetworkRetries, 1);
  assert.equal(received.options.timeout, 10_000);
});

test("rejects live-mode secret keys", () => {
  assert.throws(
    () => createStripeClient({ secretKey: "sk_live_example" }),
    error => error.code === "STRIPE_TEST_KEY_REQUIRED"
  );
});

test("rejects publishable keys and malformed secrets", () => {
  for (const secretKey of ["pk_test_example", "whsec_example", "not-a-key"]) {
    assert.throws(
      () => createStripeClient({ secretKey }),
      error => error.code === "STRIPE_TEST_KEY_REQUIRED"
    );
  }
});

test("fails closed when the secret is missing", () => {
  assert.throws(
    () => createStripeClient({ secretKey: "" }),
    error => error.code === "STRIPE_SECRET_KEY_MISSING"
  );
});
