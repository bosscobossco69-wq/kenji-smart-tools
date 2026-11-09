import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyStripeSignature } from "../api/_lib/stripe-webhook-signature.js";

const secret = "whsec_test_only";
const now = 1_800_000_000;

function signatureFor(body, timestamp = now) {
  const digest = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), body]))
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

test("accepts a valid Stripe v1 signature", () => {
  const body = Buffer.from('{"id":"evt_test","type":"checkout.session.completed"}');
  assert.equal(verifyStripeSignature(body, signatureFor(body), secret, now), true);
});

test("rejects a modified request body", () => {
  const body = Buffer.from('{"id":"evt_test"}');
  assert.equal(verifyStripeSignature(Buffer.from('{"id":"evt_fake"}'), signatureFor(body), secret, now), false);
});

test("rejects an expired timestamp", () => {
  const body = Buffer.from("{}");
  assert.equal(verifyStripeSignature(body, signatureFor(body, now - 301), secret, now), false);
});

test("rejects malformed signatures and missing secrets", () => {
  const body = Buffer.from("{}");
  assert.equal(verifyStripeSignature(body, "t=abc,v1=xyz", secret, now), false);
  assert.equal(verifyStripeSignature(body, signatureFor(body), "", now), false);
});

test("accepts one valid signature among multiple v1 signatures", () => {
  const body = Buffer.from('{"id":"evt_multi"}');
  const valid = signatureFor(body);
  const invalid = "0".repeat(64);
  assert.equal(
    verifyStripeSignature(body, `t=${now},v1=${invalid},v1=${valid.split("v1=")[1]}`, secret, now),
    true
  );
});

test("rejects timestamps too far in the future", () => {
  const body = Buffer.from("{}");
  assert.equal(verifyStripeSignature(body, signatureFor(body, now + 301), secret, now), false);
});

test("rejects a signature made with the wrong secret", () => {
  const body = Buffer.from("{}");
  const wrongSecretDigest = createHmac("sha256", "whsec_wrong")
    .update(Buffer.concat([Buffer.from(`${now}.`), body]))
    .digest("hex");
  assert.equal(verifyStripeSignature(body, `t=${now},v1=${wrongSecretDigest}`, secret, now), false);
});

test("rejects non-Buffer raw bodies", () => {
  assert.equal(verifyStripeSignature("{}", signatureFor(Buffer.from("{}")), secret, now), false);
});

import webhookHandler from "../api/stripe/webhook.js";

function webhookResponse() {
  return {
    headers: {},
    statusCode: null,
    payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

function webhookRequest(method, body, signature) {
  return {
    method,
    headers: signature ? { "stripe-signature": signature } : {},
    async *[Symbol.asyncIterator]() {
      if (body?.length) yield body;
    }
  };
}

test("Stripe webhook rejects non-POST requests", async () => {
  const res = webhookResponse();
  await webhookHandler(webhookRequest("GET", Buffer.from("{}")), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "POST");
});

test("Stripe webhook fails closed when the signing secret is missing", async () => {
  const previous = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  try {
    const res = webhookResponse();
    await webhookHandler(webhookRequest("POST", Buffer.from("{}")), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.payload.code, "WEBHOOK_SECRET_MISSING");
  } finally {
    if (previous === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = previous;
  }
});

test("Stripe webhook rejects an invalid signature before event processing", async () => {
  const previous = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = secret;
  try {
    const body = Buffer.from('{"id":"evt_invalid","type":"checkout.session.completed"}');
    const res = webhookResponse();
    await webhookHandler(webhookRequest("POST", body, "t=1,v1=invalid"), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.error, "Invalid Stripe webhook signature.");
  } finally {
    if (previous === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = previous;
  }
});

test("Stripe webhook acknowledges valid signature but remains fail-closed pending ledger processing", async () => {
  const previous = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = secret;
  try {
    const body = Buffer.from('{"id":"evt_valid","type":"checkout.session.completed"}');
    const res = webhookResponse();
    await webhookHandler(webhookRequest("POST", body, signatureFor(body, Math.floor(Date.now() / 1000))), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.payload.code, "PAYMENT_LEDGER_NOT_READY");
  } finally {
    if (previous === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = previous;
  }
});
