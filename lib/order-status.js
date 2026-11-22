// Order status is derived from server records, not inferred from a declined payment.
// Never call a Checkout session 'expired' unless the backend recorded that status.
const FAILED = new Set(["failed", "payment_failed"]);
const EXPIRED = new Set(["checkout_expired", "expired"]);
const AWAITING = new Set(["checkout_pending", "checkout_created", "pending", "unpaid"]);
export function orderCategory(status) {
  if (status === "paid") return "paid";
  if (FAILED.has(status)) return "failed";
  if (EXPIRED.has(status)) return "expired";
  if (AWAITING.has(status)) return "awaiting";
  return "other";
}
export function orderSummary(orders) {
  return orders.reduce((totals, order) => {
    const category = orderCategory(order.status);
    totals[category] += 1;
    if (category === "paid" && order.currency === "usd" && Number.isSafeInteger(order.amount)) {
      totals.paidUsdCents += order.amount;
    }
    return totals;
  }, {paid:0,failed:0,expired:0,awaiting:0,other:0,paidUsdCents:0});
}
