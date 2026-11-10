import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createStripeWebhookHandler } from "../api/stripe/webhook.js";

const secret = "whsec_injected_test";
function signed(body) {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), body]))
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}
function resMock() {
  return { statusCode: null, payload: null, headers: {},
    setHeader(k,v){this.headers[k]=v;},
    status(n){this.statusCode=n;return this;},
    json(v){this.payload=v;return this;}
  };
}
function reqMock(body) {
  return { method:"POST", headers:{"stripe-signature":signed(body)},
    async *[Symbol.asyncIterator](){yield body;}
  };
}

test("webhook retrieves canonical Sandbox Session before applying payment", async () => {
  let retrieved, applied;
  const handler=createStripeWebhookHandler({
    signingSecret:()=>secret,
    createClient:()=>({checkout:{sessions:{retrieve:async(id,opts)=>{
      retrieved={id,opts};
      return {
        id,livemode:false,payment_status:"paid",amount_total:2500,currency:"myr",
        metadata:{orderId:"order_1",userId:"user_1"},
        payment_intent:{id:"pi_123"}
      };
    }}}}),
    applyPayment:async input=>{applied=input;return {duplicate:false,applied:true};}
  });
  const body=Buffer.from(JSON.stringify({
    id:"evt_123",type:"checkout.session.completed",
    data:{object:{id:"cs_test_123"}}
  }));
  const res=resMock();
  await handler(reqMock(body),res);
  assert.equal(res.statusCode,200);
  assert.equal(retrieved.id,"cs_test_123");
  assert.deepEqual(retrieved.opts.expand,["payment_intent"]);
  assert.equal(applied.amountMinor,2500);
  assert.equal(applied.paymentIntentId,"pi_123");
  assert.equal(applied.userId,"user_1");
});

test("webhook does not grant Credits when canonical Session is unpaid", async () => {
  let applied=false;
  const handler=createStripeWebhookHandler({
    signingSecret:()=>secret,
    createClient:()=>({checkout:{sessions:{retrieve:async id=>({
      id,livemode:false,payment_status:"unpaid"
    })}}}),
    applyPayment:async()=>{applied=true;}
  });
  const body=Buffer.from(JSON.stringify({
    id:"evt_124",type:"checkout.session.completed",
    data:{object:{id:"cs_test_124"}}
  }));
  const res=resMock();
  await handler(reqMock(body),res);
  assert.equal(res.statusCode,200);
  assert.equal(res.payload.pending,true);
  assert.equal(applied,false);
});

test("webhook rejects Live-mode Checkout Sessions", async () => {
  const handler=createStripeWebhookHandler({
    signingSecret:()=>secret,
    createClient:()=>({checkout:{sessions:{retrieve:async id=>({
      id,livemode:true,payment_status:"paid"
    })}}}),
    applyPayment:async()=>{throw new Error("must not run");}
  });
  const body=Buffer.from(JSON.stringify({
    id:"evt_125",type:"checkout.session.completed",
    data:{object:{id:"cs_test_125"}}
  }));
  const res=resMock();
  await handler(reqMock(body),res);
  assert.equal(res.statusCode,400);
});

for (const eventType of [
  "refund.created",
  "refund.updated",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed"
]) {
  test(`webhook safely ignores ${eventType} until canonical reconciliation is implemented`, async () => {
    let clientCreated = false;
    let ledgerCalled = false;
    const handler = createStripeWebhookHandler({
      signingSecret: () => secret,
      createClient: () => {
        clientCreated = true;
        throw new Error("Unsupported event must not retrieve or mutate Stripe objects.");
      },
      applyPayment: async () => { ledgerCalled = true; }
    });
    const body = Buffer.from(JSON.stringify({
      id: "evt_unsupported_123",
      type: eventType,
      data: { object: { id: "re_untrusted_or_dp_untrusted", livemode: false, amount: 1, currency: "myr" } }
    }));
    const res = resMock();
    await handler(reqMock(body), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.ignored, true);
    assert.equal(clientCreated, false);
    assert.equal(ledgerCalled, false);
  });
}
