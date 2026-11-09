import { getActiveOneTimeCreditsPlan } from "./payment-plans.js";
import { createPendingPaymentOrder } from "./payment-ledger.js";

/**
 * The only supported path for creating a first-release Stripe order:
 * authenticate the Firebase user in the API handler, load a trusted active
 * one-time Credits plan from Firestore, then persist the pending order.
 * Subscription plans are intentionally rejected by the plan loader.
 */
export async function createOrderForActivePlan({ userId, planId, idempotencyKey }) {
  const plan = await getActiveOneTimeCreditsPlan(planId);
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
