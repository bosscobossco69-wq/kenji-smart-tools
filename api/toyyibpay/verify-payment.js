// KENJI AI Workspace — server-side ToyyibPay verification scaffold.
// Browser return parameters are untrusted and never confirm payment.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  if (process.env.PAYMENT_LEDGER_READY !== "true") {
    return res.status(503).json({
      error: "Payment verification is not available until the dedicated order ledger is configured.",
      code: "PAYMENT_LEDGER_REQUIRED"
    });
  }

  // TODO after a dedicated database is provisioned:
  // 1. Accept only an internal order ID (never a client-supplied amount).
  // 2. Load its billCode and expected amount from the database.
  // 3. Call ToyyibPay getBillTransactions server-to-server.
  // 4. Match billCode, external reference, amount and successful status.
  // 5. Atomically post one unique Credit ledger entry (idempotent).
  return res.status(503).json({
    error: "Verification is locked until persistent order lookup and idempotent Credit posting are implemented.",
    code: "PAYMENT_PROCESSING_NOT_READY"
  });
}
