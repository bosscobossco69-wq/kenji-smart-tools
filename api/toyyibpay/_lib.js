// Shared server-only ToyyibPay helper for Vercel functions.
// This helper intentionally permits Sandbox only. Live payments require a
// separate, reviewed implementation after merchant verification and approval.

const SANDBOX_ORIGIN = "https://dev.toyyibpay.com";

export function getToyyibPayConfig() {
  const secretKey = process.env.TOYYIBPAY_SECRET_KEY;
  const categoryCode = process.env.TOYYIBPAY_CATEGORY_CODE;
  const baseUrl = process.env.TOYYIBPAY_BASE_URL || SANDBOX_ORIGIN;

  if (!secretKey || !categoryCode) {
    throw new Error("TOYYIBPAY_CONFIGURATION_MISSING");
  }
  if (baseUrl !== SANDBOX_ORIGIN) {
    throw new Error("TOYYIBPAY_SANDBOX_ONLY");
  }

  return { secretKey, categoryCode, baseUrl: SANDBOX_ORIGIN };
}

export async function toyibPayPost(path, fields) {
  const config = getToyyibPayConfig();
  const allowedPaths = new Set([
    "/index.php/api/createBill",
    "/index.php/api/getBillTransactions"
  ]);
  if (!allowedPaths.has(path)) throw new Error("TOYYIBPAY_PATH_NOT_ALLOWED");

  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(fields || {})) {
    if (value !== undefined && value !== null) form.set(key, String(value));
  }
  form.set("userSecretKey", config.secretKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(config.baseUrl + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: controller.signal
    });
    const raw = await response.text();
    if (!response.ok) throw new Error("TOYYIBPAY_HTTP_ERROR");

    // Provider may return JSON or plain-text error codes even with HTTP 200.
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = raw.trim(); }
    if (typeof parsed === "string" && /^\[[A-Z0-9_-]+\]$/.test(parsed)) {
      throw new Error("TOYYIBPAY_PROVIDER_REJECTED_REQUEST");
    }
    return parsed;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("TOYYIBPAY_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
