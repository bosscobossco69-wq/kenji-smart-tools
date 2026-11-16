// Usage: node scripts/import-reviewed-live-billing.mjs reviewed.json [--apply]
// Never pass credentials on the command line. Dry run by default.
import fs from "node:fs";
import Stripe from "stripe";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { billingDb, billingCollection, assertStripeKey, assertStripeObject } from "../lib/billing-environment.js";

if (process.env.VERCEL_ENV !== "production") throw Error("Explicit production environment required for reviewed Live imports.");
assertStripeKey(process.env.STRIPE_SECRET_KEY);
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!Array.isArray(manifest)) throw Error("Expected an array of reviewed accounts.");
const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
if (!process.env.FIREBASE_PROJECT_ID || account.project_id !== process.env.FIREBASE_PROJECT_ID) throw Error("Firebase project mismatch.");
const app = getApps()[0] || initializeApp({ credential: cert(account), projectId: account.project_id });
const native = getFirestore(app), db = billingDb(native), stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const apply = process.argv.includes("--apply");
for (const entry of manifest) {
  if (typeof entry.uid !== "string" || !entry.uid || entry.uid.includes("/") ||
      !Number.isSafeInteger(entry.reviewedCreditBalance) ||
      typeof entry.reviewReference !== "string" || !entry.reviewReference ||
      typeof entry.legacyUpdateTime !== "string") throw Error("Invalid reviewed manifest entry.");
  const legacyRef = native.collection("users").doc(entry.uid).collection("billing").doc("current");
  const billingRef = db.collection("users").doc(entry.uid).collection(billingCollection()).doc("current");
  const ledgerRef = db.collection("users").doc(entry.uid).collection("creditLedger").doc("reviewed_legacy_opening_balance");
  let customer = null, subscription = null;
  if (entry.stripeCustomerId) {
    customer = await stripe.customers.retrieve(entry.stripeCustomerId);
    assertStripeObject(customer);
    if (customer.deleted || customer.metadata?.firebaseUID !== entry.uid) throw Error("Live customer ownership mismatch; resolve manually without importing test IDs.");
  }
  if (entry.stripeSubscriptionId) {
    subscription = await stripe.subscriptions.retrieve(entry.stripeSubscriptionId);
    assertStripeObject(subscription);
    if (!customer || subscription.customer !== customer.id || subscription.metadata?.firebaseUID !== entry.uid) throw Error("Live subscription ownership mismatch.");
  }
  const result = await native.runTransaction(async tx => {
    const [legacy, billing, ledger] = await Promise.all([tx.get(legacyRef), tx.get(billingRef), tx.get(ledgerRef)]);
    if (ledger.exists) return "already imported";
    if (!legacy.exists || `${legacy.updateTime.seconds}:${legacy.updateTime.nanoseconds}` !== entry.legacyUpdateTime) throw Error("Legacy record changed or was not found; review it again.");
    if (billing.data()?.stripeCustomerId && billing.data().stripeCustomerId !== customer?.id) throw Error("New Live customer differs; reconcile before importing.");
    const balance = Number(billing.data()?.creditBalance || 0);
    if (!Number.isSafeInteger(balance) || !Number.isSafeInteger(balance + entry.reviewedCreditBalance)) throw Error("Unsafe balance.");
    if (!apply) return "validated dry run";
    tx.set(billingRef, {
      creditBalance: balance + entry.reviewedCreditBalance,
      legacyReviewComplete: true, legacyReviewReference: entry.reviewReference,
      ...(customer ? { stripeCustomerId: customer.id } : {}),
      ...(subscription ? { stripeSubscriptionId: subscription.id, status: subscription.status, active: ["active", "trialing"].includes(subscription.status) } : {}),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    tx.create(ledgerRef, {
      type: "reviewed_legacy_opening_balance", credits: entry.reviewedCreditBalance,
      reviewReference: entry.reviewReference, legacyPath: legacyRef.path,
      legacyUpdateTime: entry.legacyUpdateTime, createdAt: FieldValue.serverTimestamp()
    });
    return "imported reviewed balance";
  });
  // No credentials, email addresses or ledger content are printed.
  console.log(result);
}
