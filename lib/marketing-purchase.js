import { billingCollection } from "./billing-environment.js";

// Fail closed: a known purchase, ambiguous paid state, or truncated query suppresses marketing.
// Used by BOTH the scheduled follow-up worker and the explicit admin test.
export function hasPurchasedFromRecords({billing, orders, websiteOrders, onboardingOrders, ledger}) {
  const account=billing||{};
  if (account.lastCreditOrderId || account.lastCreditGrantInvoiceId ||
      account.stripeSubscriptionId || account.lastAnnualCreditGrantAt ||
      ["active","trialing","past_due","unpaid"].includes(account.status)) return true;
  if (Number.isFinite(account.creditBalance) && account.creditBalance>0) return true;
  if (ledger.length>0 || orders.length>=100 || websiteOrders.length>=20 || onboardingOrders.length>=20) return true;
  const purchased=new Set(["paid","checkout_completed","succeeded","complete"]);
  return orders.some(o=>purchased.has(o.status) || o.stripePaymentIntentId) ||
    websiteOrders.some(o=>purchased.has(o.status) || o.stripePaymentIntentId) ||
    onboardingOrders.some(o=>purchased.has(o.status) || o.stripePaymentIntentId);
}
export async function hasRecordedPurchase(db, person) {
  if (!person?.uid || !person?.email) throw Error("Customer identity missing");
  const userRef=db.collection("users").doc(person.uid);
  const [billing,orders,websiteOrders,onboardingOrders,ledger]=await Promise.all([
    userRef.collection(billingCollection()).doc("current").get(),
    db.collection("billingOrders").where("uid","==",person.uid).limit(100).get(),
    db.collection("websiteOrders").where("buyerEmail","==",person.email).limit(20).get(),
    db.collection("websiteOrders").where("onboarding.contactEmail","==",person.email).limit(20).get(),
    userRef.collection("creditLedger").limit(1).get()
  ]);
  return hasPurchasedFromRecords({
    billing:billing.data()||{},
    orders:orders.docs.map(x=>x.data()),
    websiteOrders:websiteOrders.docs.map(x=>x.data()),
    onboardingOrders:onboardingOrders.docs.map(x=>x.data()),
    ledger:ledger.docs.map(x=>x.data())
  });
}
