import Stripe from "stripe";

/**
 * Return a Stripe SDK client only when an explicit test-mode secret is present.
 * Live keys are rejected even if accidentally configured in a Preview deployment.
 */
export function createStripeClient({
  secretKey = process.env.STRIPE_SECRET_KEY,
  StripeConstructor = Stripe
} = {}) {
  if (typeof secretKey !== "string" || secretKey.length === 0) {
    const error = new Error("Stripe Sandbox is not configured.");
    error.code = "STRIPE_SECRET_KEY_MISSING";
    throw error;
  }

  if (!secretKey.startsWith("sk_test_")) {
    const error = new Error("Only Stripe test-mode secret keys are permitted.");
    error.code = "STRIPE_TEST_KEY_REQUIRED";
    throw error;
  }

  return new StripeConstructor(secretKey, {
    maxNetworkRetries: 1,
    timeout: 10_000
  });
}
