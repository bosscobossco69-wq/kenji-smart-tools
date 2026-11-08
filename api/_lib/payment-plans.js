import { getFirebaseAdmin } from "./firebase-admin.js";

const ALLOWED_INTERVALS = new Set(["month", "year", "one_time"]);

/**
 * Load a purchasable plan from Firestore. The browser may provide only planId;
 * amount, currency, billing interval and Credits always come from this record.
 */
export async function getActivePaymentPlan(planId) {
  if (typeof planId !== "string" || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(planId)) {
    const error = new Error("Invalid membership plan.");
    error.statusCode = 400;
    throw error;
  }

  const { db } = getFirebaseAdmin();
  const snapshot = await db.collection("plans").doc(planId).get();
  if (!snapshot.exists) {
    const error = new Error("Membership plan was not found.");
    error.statusCode = 404;
    throw error;
  }

  const plan = snapshot.data() || {};
  if (plan.active !== true) {
    const error = new Error("This membership plan is not available.");
    error.statusCode = 409;
    throw error;
  }
  if (!Number.isSafeInteger(plan.unitAmountMinor) || plan.unitAmountMinor <= 0) {
    throw new Error("The server-side plan price is not configured correctly.");
  }
  if (String(plan.currency || "").toLowerCase() !== "myr") {
    throw new Error("The plan currency must be MYR.");
  }
  if (!Number.isSafeInteger(plan.creditsGrant) || plan.creditsGrant < 0) {
    throw new Error("The server-side Credits grant is not configured correctly.");
  }
  if (!ALLOWED_INTERVALS.has(plan.billingInterval)) {
    throw new Error("The plan billing interval is not configured correctly.");
  }

  return {
    id: snapshot.id,
    name: typeof plan.name === "string" ? plan.name : snapshot.id,
    unitAmountMinor: plan.unitAmountMinor,
    currency: "myr",
    creditsGrant: plan.creditsGrant,
    billingInterval: plan.billingInterval,
    active: true
  };
}
