import Stripe from "stripe";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { assertStripeKey, assertStripeObject, billingDb, billingCollection, assertLegacyReviewed } from "../lib/billing-environment.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  if (!req.headers.authorization?.startsWith("Bearer ")) return res.status(401).json({ error: "Sign in is required." });
  try {
    assertStripeKey(process.env.STRIPE_SECRET_KEY);
    const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
    const projectId = process.env.FIREBASE_PROJECT_ID;
    if (!projectId || account.project_id !== projectId) throw Error("Configuration mismatch.");
    const app = getApps()[0] || initializeApp({ credential: cert(account), projectId });
    const user = await getAuth(app).verifyIdToken(req.headers.authorization.slice(7), true);
    if (!user.email_verified) return res.status(403).json({ error: "Verify your email first." });
    const db = billingDb(getFirestore(app));
    await assertLegacyReviewed(db, user.uid);
    const billing = await db.collection("users").doc(user.uid).collection(billingCollection()).doc("current").get();
    const customerId = billing.data()?.stripeCustomerId;
    if (!customerId) return res.status(409).json({ error: "No linked billing account. Contact billing support for historical subscriptions." });
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const customer = await stripe.customers.retrieve(customerId);
    assertStripeObject(customer);
    if (customer.deleted || customer.metadata?.firebaseUID !== user.uid) throw Error("Customer ownership mismatch.");
    const origin = new URL(process.env.SITE_URL || "");
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.port) throw Error("Invalid site origin.");
    const session = await stripe.billingPortal.sessions.create({ customer: customer.id, return_url: origin.origin + "/workspace/billing.html" });
    return res.status(200).json({ url: session.url });
  } catch {
    return res.status(503).json({ error: "Billing management is unavailable. Contact kenjing3073@gmail.com to cancel or request a refund." });
  }
}
