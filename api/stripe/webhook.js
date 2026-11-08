// KENJI AI Workspace — Stripe webhook receiver scaffold.
// No event is acknowledged as processed and no membership/Credits are granted.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  // Stripe signature verification requires the exact raw request body and the
  // endpoint-specific STRIPE_WEBHOOK_SECRET. Do not parse or trust req.body here.
  // Returning 503 keeps processing disabled; Stripe may retry delivery.
  return res.status(503).json({
    error: "Stripe webhook processing is not configured yet.",
    code: "WEBHOOK_PROCESSING_NOT_READY"
  });
}
