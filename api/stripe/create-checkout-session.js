// KENJI AI Workspace — Stripe Checkout scaffold.
// Fail-closed: no Stripe request is made until a dedicated order/entitlement ledger is deployed.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  // Never trust a browser-supplied price, currency, plan entitlement, or success URL.
  // Future implementation must authenticate a verified user, load a server-side
  // plan, persist a pending order, and enforce idempotency before calling Stripe.
  return res.status(503).json({
    error: "Stripe Checkout is not enabled yet.",
    code: "PAYMENT_LEDGER_REQUIRED",
    message: "A dedicated order and entitlement ledger must be configured and tested first."
  });
}
