// Manual subscription/legacy support cases only. Automatic pack adjustments must
// use signed webhooks, not this script. Usage: node ... reviewed-case.json [--apply]
import fs from "node:fs";
import { createHash } from "node:crypto";
import Stripe from "stripe";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { assertStripeKey, assertStripeObject, billingDb, billingCollection } from "../lib/billing-environment.js";
if (process.env.VERCEL_ENV !== "production") throw Error("Explicit production environment required.");
assertStripeKey(process.env.STRIPE_SECRET_KEY);
const entry = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!entry.uid || entry.uid.includes("/") || !entry.caseId || !entry.reviewReference || !entry.chargeId ||
    !Number.isSafeInteger(entry.creditsDelta) || entry.creditsDelta === 0) throw Error("Invalid reviewed case.");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const charge = await stripe.charges.retrieve(entry.chargeId);
assertStripeObject(charge);
const customer = await stripe.customers.retrieve(typeof charge.customer === "string" ? charge.customer : charge.customer?.id);
assertStripeObject(customer);
if (customer.deleted || customer.metadata?.firebaseUID !== entry.uid) throw Error("Payment ownership needs manual reconciliation.");
const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
if (!process.env.FIREBASE_PROJECT_ID || account.project_id !== process.env.FIREBASE_PROJECT_ID) throw Error("Firebase mismatch.");
const app = getApps()[0] || initializeApp({ credential: cert(account), projectId: account.project_id });
const db = billingDb(getFirestore(app));
let packOrderRef = null;
if (charge.payment_intent) {
  const intent = await stripe.paymentIntents.retrieve(typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent.id);
  assertStripeObject(intent);
  if (intent.metadata?.purchaseType === "credit_pack" && intent.metadata?.orderId) {
    packOrderRef = db.collection("billingOrders").doc(intent.metadata.orderId);
  }
}
const state = await db.collection("stripeChargeAdjustments").doc(charge.id).get();
if (Number.isSafeInteger(state.data()?.revokedCredits)) throw Error("Payment already belongs to automatic pack adjustments; replay its webhook instead.");
const user = db.collection("users").doc(entry.uid);
const billingRef = user.collection(billingCollection()).doc("current");
const ledgerRef = user.collection("creditLedger").doc("reviewed_case_" + createHash("sha256").update(entry.caseId).digest("hex"));
const result = await db.runTransaction(async tx => {
  const [billing, ledger, packOrder] = await Promise.all([
    tx.get(billingRef), tx.get(ledgerRef), packOrderRef ? tx.get(packOrderRef) : null
  ]);
  if (packOrder?.exists) throw Error("Isolated pack order uses automatic webhook adjustments; manual debit refused.");
  if (ledger.exists) {
    const previous = ledger.data();
    if (previous.credits !== entry.creditsDelta || previous.stripeChargeId !== charge.id) throw Error("Case ID was already used for a different adjustment.");
    return "already applied";
  }
  if (!billing.exists || billing.data().legacyReviewComplete !== true) throw Error("Import and review legacy billing first.");
  const balance = Number(billing.data().creditBalance || 0);
  if (!Number.isSafeInteger(balance) || !Number.isSafeInteger(balance + entry.creditsDelta)) throw Error("Unsafe balance.");
  if (!process.argv.includes("--apply")) return "validated dry run";
  tx.set(billingRef, { creditBalance: balance + entry.creditsDelta, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  tx.create(ledgerRef, { type: "reviewed_support_adjustment", credits: entry.creditsDelta, stripeChargeId: charge.id,
    caseId: entry.caseId, reviewReference: entry.reviewReference, createdAt: FieldValue.serverTimestamp() });
  return "applied reviewed case";
});
console.log(result);
