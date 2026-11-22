const test = require("node:test");
const assert = require("node:assert/strict");
test("billing statuses distinguish paid, failed, expired and awaiting",async()=>{
  const {orderCategory,orderSummary}=await import("../lib/order-status.js");
  assert.equal(orderCategory("paid"),"paid");
  assert.equal(orderCategory("payment_failed"),"failed");
  assert.equal(orderCategory("checkout_expired"),"expired");
  assert.equal(orderCategory("checkout_created"),"awaiting");
  assert.equal(orderCategory("checkout_pending"),"awaiting");
  assert.equal(orderCategory("checkout_completed"),"other");
  const result=orderSummary([
    {status:"paid",currency:"usd",amount:500},
    {status:"checkout_created",currency:"usd",amount:1000},
    {status:"checkout_expired",currency:"usd",amount:2000},
    {status:"payment_failed",currency:"usd",amount:3000},
    {status:"checkout_completed",currency:"usd",amount:6000}
  ]);
  assert.deepEqual(result,{paid:1,failed:1,expired:1,awaiting:1,other:1,paidUsdCents:500});
});
