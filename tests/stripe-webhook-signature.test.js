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
