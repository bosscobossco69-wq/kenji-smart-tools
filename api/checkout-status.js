import { billingCollection, billingDb, billingMode } from "../lib/billing-environment.js";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

let servicesPromise;
function services() {
  if (!servicesPromise) servicesPromise = (async () => {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!projectId || !raw) throw new Error("Billing service is not configured.");
    let account;
    try { account = JSON.parse(raw); } catch { throw new Error("Invalid Firebase configuration."); }
    if (account.project_id !== projectId) throw new Error("Firebase project mismatch.");
    const app = getApps()[0] || initializeApp({ credential: cert(account), projectId });
    return { auth: getAuth(app), db: billingDb(getFirestore(app)) };
  })();
  return servicesPromise;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Authorization");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const sessionId = req.query?.session_id;
  const intendedPrefix = billingMode() === "live" ? "cs_live_" : "cs_test_";
  if (typeof sessionId !== "string" || !/^cs_(live|test)_[A-Za-z0-9_]{10,250}$/.test(sessionId) ||
      !sessionId.startsWith(intendedPrefix)) {
    return res.status(400).json({ error: "Invalid checkout reference." });
  }
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ") ||
      authorization.length > 8200) return res.status(401).json({ error: "Sign in to verify your purchase." });
  try {
    const { auth, db } = await services();
    const user = await auth.verifyIdToken(authorization.slice(7), true);
    if (!user.email || user.email_verified !== true) return res.status(403).json({ error: "Verified account required." });
    const result = await db.collection("billingOrders")
      .where("stripeCheckoutSessionId", "==", sessionId).limit(2).get();
    if (result.empty) return res.status(200).json({ state: "pending" });
    if (result.size !== 1) return res.status(409).json({ error: "Billing order needs support review." });
    const doc = result.docs[0], order = doc.data();
    if (order.uid !== user.uid) return res.status(403).json({ error: "Checkout does not belong to this account." });
    if (order.type !== "credit_pack" || order.currency !== "usd") return res.status(400).json({ error: "Not a Credits purchase." });
    if (order.status !== "paid") return res.status(200).json({ state: "pending" });
    const ledger = await db.collection("users").doc(user.uid).collection("creditLedger")
      .doc("stripe_pack_" + doc.id).get();
    const entry = ledger.exists ? ledger.data() : null;
    if (!entry || entry.type !== "credit_pack_purchase" ||
        entry.orderId !== doc.id || entry.stripeCheckoutSessionId !== sessionId ||
        entry.credits !== order.credits || entry.amount !== order.amount || entry.currency !== order.currency) {
      return res.status(200).json({ state: "pending" });
    }
    return res.status(200).json({
      state: "paid",
      creditsGranted: order.credits,
      amount: order.amount,
      currency: "usd"
    });
  } catch (error) {
    const msg = error?.message || "";
    const unavailable = msg.includes("not configured") || msg.includes("mismatch");
    return res.status(unavailable ? 503 : 500).json({ error: "Payment verification temporarily unavailable. Do not pay again." });
  }
}
