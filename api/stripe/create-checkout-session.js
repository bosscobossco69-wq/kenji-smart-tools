import { createStripeClient } from "../_lib/stripe-client.js";
import { requireVerifiedUser } from "../_lib/firebase-admin.js";
import { createOrderForActivePlan } from "../_lib/payment-order-service.js";
import { attachStripeCheckoutSession } from "../_lib/payment-ledger.js";

function json(res, status, payload) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(status).json(payload);
}

function configuredBaseUrl(value) {
  if (typeof value !== "string" || !value) throw new Error("APP_BASE_URL is not configured.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("APP_BASE_URL must be a clean HTTPS origin.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("APP_BASE_URL must not include a path.");
  }
  const host = url.hostname.toLowerCase();
  if (host !== "kenji-smart-tools.vercel.app" && !host.endsWith(".vercel.app")) {
    throw new Error("APP_BASE_URL host is not an approved KENJI deployment host.");
  }
  return url.origin;
}

export function createCheckoutSessionHandler({
  authenticate = requireVerifiedUser,
  createOrder = createOrderForActivePlan,
  attachSession = attachStripeCheckoutSession,
  createClient = createStripeClient,
  baseUrl = () => process.env.APP_BASE_URL
} = {}) {
  return async function handler(req, res) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: "Method not allowed." });
    }

    try {
      const user = await authenticate(req);
      const planId = req.body?.planId;
      const idempotencyKey = req.headers["idempotency-key"] || req.body?.idempotencyKey;
      if (typeof planId !== "string" || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(planId)) {
        return json(res, 400, { error: "A valid planId is required." });
      }
      if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length < 16 || idempotencyKey.length > 200) {
        return json(res, 400, { error: "A valid Idempotency-Key of 16–200 characters is required." });
      }

      const origin = configuredBaseUrl(baseUrl());
      const orderResult = await createOrder({
        userId: user.uid,
        planId,
        idempotencyKey: idempotencyKey.trim()
      });
      const order = orderResult.order;
      if (!order || order.status !== "pending" || order.userId !== user.uid ||
          !Number.isSafeInteger(order.expectedAmountMinor) || order.expectedAmountMinor <= 0 ||
          order.currency !== "myr" || typeof order.planId !== "string") {
        throw new Error("The pending payment order is invalid.");
      }

      const stripe = createClient();
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [{
          quantity: 1,
          price_data: {
            currency: order.currency,
            unit_amount: order.expectedAmountMinor,
            product_data: { name: order.planId }
          }
        }],
        client_reference_id: orderResult.orderId,
        metadata: {
          orderId: orderResult.orderId,
          userId: user.uid,
          planId: order.planId
        },
        success_url: `${origin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/pricing?payment=cancelled`
      }, { idempotencyKey: `kenji-checkout-${orderResult.orderId}` });

      if (!session || typeof session.id !== "string" || !session.id.startsWith("cs_test_") ||
          typeof session.url !== "string" || !session.url.startsWith("https://")) {
        throw new Error("Stripe did not return a valid Sandbox Checkout Session.");
      }

      await attachSession({
        orderId: orderResult.orderId,
        userId: user.uid,
        checkoutSessionId: session.id,
        stripeCustomerId: typeof session.customer === "string" ? session.customer : null
      });

      return json(res, 200, {
        checkoutUrl: session.url,
        orderId: orderResult.orderId,
        mode: "test"
      });
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode : 503;
      return json(res, status, {
        error: status === 503 ? "Stripe Sandbox Checkout is unavailable." : error.message,
        code: error?.code || "CHECKOUT_UNAVAILABLE"
      });
    }
  };
}

export default createCheckoutSessionHandler();
