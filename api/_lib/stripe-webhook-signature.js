import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify Stripe's v1 signature over exact raw request bytes.
 * Uses a five-minute tolerance to limit replay exposure.
 */
export function verifyStripeSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!Buffer.isBuffer(rawBody) || typeof header !== "string" || typeof secret !== "string" || !secret) {
    return false;
  }
  const fields = header.split(",").map(part => part.trim().split("=", 2));
  const timestamp = fields.find(([key]) => key === "t")?.[1];
  const signatures = fields.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || !/^\\d+$/.test(timestamp) || !signatures.length) return false;
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
