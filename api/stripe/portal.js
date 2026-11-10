// KENJI AI Workspace — Stripe Customer Portal scaffold.
// Fail-closed until authenticated customer mapping and billing records exist.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  // Future implementation must derive the user from a verified session and
  // load that user's Stripe customer ID server-side. Never accept customer IDs
  // or return URLs as authorization from the browser.
  return res.status(503).json({
    error: "Stripe Customer Portal is not enabled yet.",
    code: "BILLING_CUSTOMER_MAPPING_REQUIRED"
  });
}
