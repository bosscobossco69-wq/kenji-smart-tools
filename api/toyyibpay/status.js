// Public, non-sensitive ToyyibPay integration readiness probe.
// Reveals configuration booleans only; never returns keys, category codes or URLs.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const sandboxOrigin = "https://dev.toyyibpay.com";
  const configured = Boolean(
    process.env.TOYYIBPAY_SECRET_KEY &&
    process.env.TOYYIBPAY_CATEGORY_CODE
  );
  const sandboxOnly = !process.env.TOYYIBPAY_BASE_URL ||
    process.env.TOYYIBPAY_BASE_URL === sandboxOrigin;

  return res.status(200).json({
    provider: "ToyyibPay",
    mode: "sandbox-only",
    sandboxConfigurationPresent: configured && sandboxOnly,
    checkoutEnabled: false,
    creditIssuanceEnabled: false,
    ledgerReady: process.env.PAYMENT_LEDGER_READY === "true",
    nextStep: "Provision and verify the dedicated KENJI Workspace database and idempotent Credit ledger before enabling checkout."
  });
}
