import inventoryHandler from "../lib/business-inventory-handler.js";
import { billingMode, billingCollection, billingDb, assertLegacyReviewed } from "../lib/billing-environment.js";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { preferenceRef, updateMarketingPreference } from "../lib/marketing-consent.js";

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
      return { auth: getAuth(app), db: billingDb(getFirestore(app)) };
    })();
  }
  return servicesPromise;
}

export default async function handler(req, res) {
  if (req.query?.action === "inventory") return inventoryHandler(req, res);
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Vary", "Authorization");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const marketingUpdate = req.method === "POST" && req.query?.action === "marketing_preference";
  if (req.method !== "GET" && !marketingUpdate) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  if (marketingUpdate && (typeof req.body?.marketingConsent !== "boolean" ||
      Object.keys(req.body||{}).length !== 1 ||
      req.headers["content-type"]?.split(";")[0] !== "application/json")) {
    return res.status(400).json({error:"A true or false marketing choice is required."});
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
    const identity = await auth.verifyIdToken(token, true);
    if (marketingUpdate) {
      const userRecord = await auth.getUser(identity.uid);
      if (userRecord.disabled || !userRecord.email) return res.status(403).json({error:"Account unavailable."});
      const result = await updateMarketingPreference(db,userRecord,req.body.marketingConsent,"account");
      return res.status(200).json({ok:true,...result});
    }
    const user = identity;
    if (!user.email || user.email_verified !== true) {
      return res.status(403).json({ error: "A verified email address is required." });
    }

    await assertLegacyReviewed(db, user.uid);
    const billingRef = db.collection("users").doc(user.uid).collection(billingCollection()).doc("current");
    const [snapshot, marketingSnapshot] = await Promise.all([billingRef.get(),preferenceRef(db,user.uid).get()]);
    const billing = snapshot.exists ? snapshot.data() : {};
    const balance = Number(billing.creditBalance ?? 0);
    const subscriptionStatus = typeof billing.status === "string" ? billing.status : "inactive";

    return res.status(200).json({
      creditDebt: Number.isSafeInteger(balance) && balance < 0 ? -balance : 0,
      billingEnvironment: billingMode(),
      creditBalance: Number.isFinite(balance) && balance >= 0 ? Math.floor(balance) : 0,
      subscriptionStatus,
      planActive: ["active", "trialing"].includes(subscriptionStatus),
      marketingConsent: marketingSnapshot.exists && marketingSnapshot.data()?.marketingConsent === true
    });
  } catch (error) {
    if (error?.code === "billing_legacy_review_required") return res.status(409).json({ error: error.message });
    const message = error?.message || "";
    const unavailable = message.includes("not configured") || message.includes("Legacy billing review") || message.includes("project mismatch");
    return res.status(unavailable ? 503 : 500).json({
      error: unavailable ? "Account billing service is not configured." : "Could not load account billing details."
    });
  }
}
