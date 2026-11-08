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
