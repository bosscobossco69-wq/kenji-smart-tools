import test from "node:test";
import assert from "node:assert/strict";
import { createCheckoutSessionHandler } from "../api/stripe/create-checkout-session.js";

function response() {
  return {
    headers: {}, statusCode: null, payload: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

function request({method="POST", body={}, headers={}}={}) {
  return { method, body, headers };
}

const order = {
  orderId: "order_123456789",
  order: {
    userId: "user_1", status: "pending", planId: "credits_100",
    expectedAmountMinor: 2500, currency: "myr"
  }
};

test("creates a test Checkout Session using server order values and attaches it", async () => {
  const calls = {};
  const handler = createCheckoutSessionHandler({
    authenticate: async () => ({ uid: "user_1" }),
    createOrder: async args => { calls.order = args; return order; },
    createClient: () => ({
      checkout: { sessions: { create: async (params, options) => {
        calls.params = params; calls.options = options;
        return { id: "cs_test_123456", url: "https://checkout.stripe.com/test", customer: "cus_123" };
      } } }
    }),
    attachSession: async args => { calls.attach = args; },
    baseUrl: () => "https://kenji-smart-tools.vercel.app"
  });
  const res = response();
  await handler(request({body:{planId:"credits_100"},headers:{"idempotency-key":"request-key-123456"}}),res);

  assert.equal(res.statusCode,200);
  assert.equal(res.payload.mode,"test");
  assert.equal(calls.params.line_items[0].price_data.unit_amount,2500);
  assert.equal(calls.params.line_items[0].price_data.currency,"myr");
  assert.equal(calls.params.success_url,"https://kenji-smart-tools.vercel.app/payment/success?session_id={CHECKOUT_SESSION_ID}");
  assert.equal(calls.options.idempotencyKey,"kenji-checkout-order_123456789");
  assert.equal(calls.attach.checkoutSessionId,"cs_test_123456");
  assert.equal(calls.order.userId,"user_1");
});

test("rejects non-POST requests", async () => {
  const handler = createCheckoutSessionHandler();
  const res = response();
  await handler(request({method:"GET"}),res);
  assert.equal(res.statusCode,405);
  assert.equal(res.headers.Allow,"POST");
});

test("requires a verified user before creating an order", async () => {
  let orderCalled=false;
  const handler=createCheckoutSessionHandler({
    authenticate:async()=>{const e=new Error("Sign in required");e.statusCode=401;throw e;},
    createOrder:async()=>{orderCalled=true;}
  });
  const res=response();
  await handler(request({body:{planId:"credits_100"},headers:{"idempotency-key":"request-key-123456"}}),res);
  assert.equal(res.statusCode,401);
  assert.equal(orderCalled,false);
});

test("rejects missing idempotency key", async () => {
  const handler=createCheckoutSessionHandler({authenticate:async()=>({uid:"user_1"})});
  const res=response();
  await handler(request({body:{planId:"credits_100"}}),res);
  assert.equal(res.statusCode,400);
});

test("rejects unapproved base URL before creating an order", async () => {
  let orderCalled=false;
  const handler=createCheckoutSessionHandler({
    authenticate:async()=>({uid:"user_1"}),
    createOrder:async()=>{orderCalled=true;return order;},
    baseUrl:()=>"https://attacker.example"
  });
  const res=response();
  await handler(request({body:{planId:"credits_100"},headers:{"idempotency-key":"request-key-123456"}}),res);
  assert.equal(res.statusCode,503);
  assert.equal(orderCalled,false);
});

test("rejects non-test Checkout Session identifiers", async () => {
  const handler=createCheckoutSessionHandler({
    authenticate:async()=>({uid:"user_1"}),
    createOrder:async()=>order,
    createClient:()=>({checkout:{sessions:{create:async()=>({id:"cs_live_123",url:"https://checkout.stripe.com/live"})}}}),
    baseUrl:()=>"https://kenji-smart-tools.vercel.app"
  });
  const res=response();
  await handler(request({body:{planId:"credits_100"},headers:{"idempotency-key":"request-key-123456"}}),res);
  assert.equal(res.statusCode,503);
});
