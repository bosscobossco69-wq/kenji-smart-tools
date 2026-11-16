import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

let servicesPromise;
function getServices() {
  if (!servicesPromise) {
    servicesPromise = (async () => {
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const rawAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (!projectId || !rawAccount) throw new Error("Account service is not configured.");
      let account;
      try { account = JSON.parse(rawAccount); } catch { throw new Error("Firebase service account is invalid."); }
      if (account.project_id !== projectId) throw new Error("Firebase project mismatch.");
      const app = getApps()[0] || initializeApp({ credential: cert(account), projectId });
      return { auth: getAuth(app), db: getFirestore(app) };
    })();
  }
  return servicesPromise;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Vary", "Authorization");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const authorization = req.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Sign in is required." });
    }
    const token = authorization.slice(7);
    if (!token || token.length > 8192) {
      return res.status(401).json({ error: "Invalid authentication token." });
    }

    const { auth, db } = await getServices();
    const user = await auth.verifyIdToken(token, true);
    if (!user.email || user.email_verified !== true) {
      return res.status(403).json({ error: "A verified email address is required." });
    }

    const billingRef = db.collection("users").doc(user.uid).collection("billing").doc("current");
    const snapshot = await billingRef.get();
    const billing = snapshot.exists ? snapshot.data() : {};
    const balance = Number(billing.creditBalance ?? 0);
    const subscriptionStatus = typeof billing.status === "string" ? billing.status : "inactive";

    return res.status(200).json({
      creditBalance: Number.isFinite(balance) && balance >= 0 ? Math.floor(balance) : 0,
      subscriptionStatus,
      planActive: ["active", "trialing"].includes(subscriptionStatus)
    });
  } catch (error) {
    const message = error?.message || "";
    const unavailable = message.includes("not configured") || message.includes("project mismatch");
    return res.status(unavailable ? 503 : 500).json({
      error: unavailable ? "Account billing service is not configured." : "Could not load account billing details."
    });
  }
}
