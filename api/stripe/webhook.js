import { verifyStripeSignature } from "../_lib/stripe-webhook-signature.js";
import { createStripeClient } from "../_lib/stripe-client.js";
import { applyVerifiedStripePayment } from "../_lib/payment-ledger.js";

export const config = { api: { bodyParser: false } };

function json(res, status, payload) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(status).json(payload);
}

async function readRawBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("Webhook payload is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function createStripeWebhookHandler({
  createClient = createStripeClient,
  applyPayment = applyVerifiedStripePayment,
  signingSecret = () => process.env.STRIPE_WEBHOOK_SECRET
} = {}) {
  return async function handler(req, res) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: "Method not allowed." });
    }

    const secret = signingSecret();
    if (!secret) {
      return json(res, 503, { error: "Stripe webhook verification is not configured.", code: "WEBHOOK_SECRET_MISSING" });
    }

    let rawBody;
    try {
      rawBody = await readRawBody(req);
    } catch {
      return json(res, 413, { error: "Webhook payload is invalid or too large." });
    }

    if (!verifyStripeSignature(rawBody, req.headers["stripe-signature"], secret)) {
      return json(res, 400, { error: "Invalid Stripe webhook signature." });
    }

    let event;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return json(res, 400, { error: "Webhook payload is not valid JSON." });
    }
    if (!event || typeof event.id !== "string" || !event.id.startsWith("evt_") ||
        typeof event.type !== "string" || !event.data?.object) {
      return json(res, 400, { error: "Webhook event structure is invalid." });
    }

    const supported = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);
    if (!supported.has(event.type)) {
      return json(res, 200, { received: true, ignored: true });
    }

    try {
      const sessionId = event.data.object.id;
      if (typeof sessionId !== "string" || !sessionId.startsWith("cs_test_")) {
        return json(res, 400, { error: "Only Stripe Sandbox Checkout Sessions are accepted." });
      }

      // Retrieve the canonical Session from Stripe; never grant Credits from
      // metadata or amount fields in the webhook body alone.
      const stripe = createClient();
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["payment_intent"]
      });

      if (!session || session.id !== sessionId || session.livemode !== false) {
        return json(res, 400, { error: "Canonical Stripe Session is not a Sandbox Session." });
      }

      // Delayed payment methods may complete before funds are paid. The
      // async_payment_succeeded event will perform the grant when paid.
      if (session.payment_status !== "paid") {
        return json(res, 200, { received: true, pending: true });
      }

      const orderId = session.metadata?.orderId;
      const userId = session.metadata?.userId;
      const paymentIntentId = typeof session.payment_intent === "string"
        ? session.payment_intent : session.payment_intent?.id;
      if (typeof orderId !== "string" || !orderId || typeof userId !== "string" || !userId ||
          typeof paymentIntentId !== "string" || !paymentIntentId.startsWith("pi_") ||
          !Number.isSafeInteger(session.amount_total) || session.amount_total <= 0 ||
          session.currency !== "myr") {
        return json(res, 400, { error: "Canonical Stripe payment details are incomplete or unsupported." });
      }

      const result = await applyPayment({
        eventId: event.id,
        eventType: event.type,
        orderId,
        checkoutSessionId: session.id,
        paymentIntentId,
        userId,
        amountMinor: session.amount_total,
        currency: session.currency,
        paymentStatus: session.payment_status
      });

      return json(res, 200, { received: true, processed: true, duplicate: Boolean(result?.duplicate) });
    } catch (error) {
      // A 5xx response asks Stripe to retry transient failures. No success is
      // acknowledged if canonical retrieval or the atomic ledger write fails.
      return json(res, 503, {
        error: "Verified Stripe event could not be processed.",
        code: error?.code || "WEBHOOK_PROCESSING_FAILED"
      });
    }
  };
}

export default createStripeWebhookHandler();
