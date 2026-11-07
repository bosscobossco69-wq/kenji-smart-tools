// KENJI AI Workspace — ToyyibPay callback receiver scaffold.
// Hash validation follows ToyyibPay's published MD5 formula.
// No Credits are issued here: persistent order lookup + idempotent ledger are prerequisites.
import { createHash, timingSafeEqual } from "node:crypto";

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" ||
      !/^[a-f0-9]{32}$/i.test(a) || !/^[a-f0-9]{32}$/i.test(b)) return false;
  const left = Buffer.from(a.toLowerCase(), "hex");
  const right = Buffer.from(b.toLowerCase(), "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const body = req.body || {};
  const { status, order_id, refno, hash } = body;
  const secret = process.env.TOYYIBPAY_SECRET_KEY;

  if (!secret || !status || !order_id || !refno || !hash) {
    return res.status(400).json({ error: "Invalid callback payload." });
  }

  const expected = createHash("md5")
    .update(secret + String(status) + String(order_id) + String(refno) + "ok")
    .digest("hex");

  if (!safeEqualHex(String(hash), expected)) {
    return res.status(401).json({ error: "Callback signature validation failed." });
  }

  // A valid provider hash alone is not sufficient to credit an account.
  // We must load the pending order, verify billcode + amount with ToyyibPay,
  // and atomically insert a unique ledger event before acknowledging success.
  if (process.env.PAYMENT_LEDGER_READY !== "true") {
    return res.status(503).json({
      error: "Callback verified but payment ledger is not configured.",
      code: "PAYMENT_LEDGER_REQUIRED"
    });
  }

  return res.status(503).json({
    error: "Callback processing is locked until order verification and idempotent Credit posting are deployed.",
    code: "PAYMENT_PROCESSING_NOT_READY"
  });
}
