// The deployment decides the namespace. Never infer it from a caller's metadata.
export function billingMode() {
  return process.env.VERCEL_ENV === "production" ? "live" : "test";
}
export function billingCollection() { return "billing_" + billingMode(); }
export function assertStripeKey(key, checkout = false) {
  const mode = billingMode();
  if (typeof key !== "string" || !key.startsWith(mode === "live" ? "sk_live_" : "sk_test_")) {
    throw new Error(mode === "live" ? "Live Stripe service is not configured." : "Preview requires a Stripe Test Mode key.");
  }
  if (checkout && mode === "live" && process.env.STRIPE_LIVE_CHECKOUT_ENABLED !== "true") {
    throw new Error("Live Stripe checkout is disabled.");
  }
}
export function assertStripeObject(object) {
  if (typeof object?.livemode !== "boolean" || object.livemode !== (billingMode() === "live")) {
    throw new Error("Stripe object environment mismatch.");
  }
}
export function billingDb(db) {
  const prefix = "billing_" + billingMode() + "_";
  return {
    collection: name => db.collection(prefix + name),
    collectionGroup: name => db.collectionGroup(name === "billing" ? billingCollection() : prefix + name),
    runTransaction: callback => db.runTransaction(callback),
    legacyDb: db
  };
}
export async function assertLegacyReviewed(db, uid) {
  if (billingMode() !== "live") return;
  const [legacy, current] = await Promise.all([
    db.legacyDb.collection("users").doc(uid).collection("billing").doc("current").get(),
    db.collection("users").doc(uid).collection(billingCollection()).doc("current").get()
  ]);
  if (legacy.exists && current.data()?.legacyReviewComplete !== true) {
    const error = new Error("Legacy billing review required. Contact kenjing3073@gmail.com; historical records are preserved.");
    error.code = "billing_legacy_review_required";
    throw error;
  }
}
