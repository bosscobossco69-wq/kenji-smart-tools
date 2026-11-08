import { createHmac, timingSafeEqual } from "node:crypto";

export const config = {
  api: { bodyParser: false }
};

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

/**
 * Verify Stripe's v1 signature over the exact raw request bytes.
 * The secret must be the endpoint-specific Sandbox signing secret.
 */
function verifyStripeSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof header !== "string" || !secret) return false;
  const fields = header.split(",").map(part => part.split("=", 2));
  const timestamp = fields.find(([key]) => key === "t")?.[1];
  const signatures = fields.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || !/^\d+$/.test(timestamp) || !signatures.length) return false;
  const timestampNumber = Number(timestamp);
  if (!Number.isSafeInteger(timestampNumber) || Math.abs(nowSeconds - timestampNumber) > 300) return false;

  const expected = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
    .digest();
  return signatures.some(signature => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    const supplied = Buffer.from(signature, "hex");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Method not allowed." });
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return json(res, 503, {
      error: "Stripe webhook verification is not configured.",
      code: "WEBHOOK_SECRET_MISSING"
    });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch {
    return json(res, 413, { error: "Webhook payload is invalid or too large." });
  }

  const signature = req.headers["stripe-signature"];
  if (!verifyStripeSignature(rawBody, signature, secret)) {
    return json(res, 400, { error: "Invalid Stripe webhook signature." });
  }

  // Signature verification alone must never activate a plan or grant Credits.
  // Database provisioning, event idempotency and atomic reconciliation remain
  // mandatory; keep returning 503 so Stripe retries rather than losing events.
  return json(res, 503, {
    error: "Verified webhook received, but payment ledger processing is not enabled.",
    code: "PAYMENT_LEDGER_NOT_READY"
  });
}
