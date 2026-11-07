// KENJI AI Workspace — ToyyibPay checkout scaffold.
// Deliberately fail-closed until a dedicated order/credit ledger is configured.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  // Never accept a price, category, or provider URL from the browser.
  // The server-side order ledger must be implemented before checkout can open.
  const required = [
    "TOYYIBPAY_SECRET_KEY",
    "TOYYIBPAY_CATEGORY_CODE",
    "TOYYIBPAY_BASE_URL",
    "PAYMENT_LEDGER_READY"
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length || process.env.PAYMENT_LEDGER_READY !== "true" ||
      process.env.TOYYIBPAY_CHECKOUT_ENABLED !== "true") {
    return res.status(503).json({
      error: "Checkout is not enabled yet.",
      code: "PAYMENTS_NOT_CONFIGURED",
      message: "A dedicated order and Credit ledger must be configured and tested before payments can be accepted."
    });
  }

  // Intentionally blocked: no bill can be created until server-side plans,
  // pending-order persistence, amount validation and idempotency are connected.
  return res.status(503).json({
    error: "Checkout remains locked until the payment ledger implementation is completed.",
    code: "PAYMENT_LEDGER_REQUIRED"
  });
}
