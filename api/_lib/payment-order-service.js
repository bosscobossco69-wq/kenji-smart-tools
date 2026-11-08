import { getActivePaymentPlan } from "./payment-plans.js";
import { createPendingPaymentOrder } from "./payment-ledger.js";

/**
 * The only supported path for creating a Stripe order:
 * load trusted plan values from Firestore, then persist the pending order.
 * Call only after the API handler has authenticated the Firebase user.
 */
export async function createOrderForActivePlan({ userId, planId, idempotencyKey }) {
  const plan = await getActivePaymentPlan(planId);
  return createPendingPaymentOrder({
    userId,
    planId: plan.id,
    idempotencyKey,
    amountMinor: plan.unitAmountMinor,
    currency: plan.currency,
    creditsGrant: plan.creditsGrant,
    billingInterval: plan.billingInterval
  });
}
