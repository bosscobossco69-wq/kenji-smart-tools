import Stripe from "stripe";
import { createHash } from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { assertStripeKey } from "../lib/billing-environment.js";

// One-owner, one-time migration. Fail closed on any unknown historical entitlement.
// Does not modify or delete any legacy document or transfer Test credits into Live.
const OWNER_UID = "aWPvlPvNgwdtWapvKLB9aFzPqQi2";
const OWNER_EMAIL = "kenjing3073@gmail.com";
const EXPECTED_STRIPE_ACCOUNT = "acct_1UKcnJLpz7LOZhY6";
const REFERENCE = "kenji-live-zero-opening-2026-11-19";
const OPENING_LEDGER_ID = "reviewed_legacy_opening_balance";

function assert(condition, code) { if (!condition) { const e = Error(code); e.auditCode = code; throw e; } }
function safeArrayEqual(a,b) { return JSON.stringify(a) === JSON.stringify(b); }
function mode(value) {
  if (typeof value !== "string") return "unknown";
  if (value.startsWith("cs_test_")) return "test";
  if (value.startsWith("cs_live_")) return "live";
  return "unknown";
}
function digest(docs) {
  const items = docs.map(d => {
    const v = d.data();
    return [d.id, String(v.type||""), Number(v.credits), String(v.status||""), String(v.stripeCheckoutSessionId||"")];
  }).sort((a,b)=>a[0].localeCompare(b[0]));
  return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}
function ordersDigest(docs) {
  return createHash("sha256").update(JSON.stringify(docs.map(d => {
    const v = d.data();
    return [d.id, String(v.status||""), String(v.stripeCheckoutSessionId||""), String(v.type||"")];
  }).sort((a,b)=>a[0].localeCompare(b[0])))).digest("hex");
}
function validateLegacy(legacy, ledger, orders) {
  assert(legacy.exists, "LEGACY_MISSING");
  const old = legacy.data();
  assert(old.creditBalance === 19998, "LEGACY_BALANCE_CHANGED");
  assert(old.checkoutPaymentStatus === "paid" && mode(old.checkoutSessionId) === "test", "LEGACY_PAYMENT_NOT_TEST");
  assert(!old.stripeCustomerId && !old.stripeSubscriptionId, "LEGACY_CUSTOMER_OR_SUBSCRIPTION");
  assert(ledger.length === 6, "LEDGER_COUNT_CHANGED");
  const purchases = ledger.filter(d=>d.data().type==="credit_pack_purchase");
  const usage = ledger.filter(d=>d.data().type==="ai_reply_usage");
  assert(purchases.length === 1 && usage.length === 5, "LEDGER_TYPES_UNKNOWN");
  assert(purchases[0].data().credits === 10000 && mode(purchases[0].data().stripeCheckoutSessionId) === "test", "PURCHASE_NOT_TEST");
  assert(usage.every(d=>d.data().credits === -1 && ["refunded","completed"].includes(d.data().status)), "AI_USAGE_UNEXPECTED");
  assert(orders.length <= 50 && orders.every(d => {
    const o=d.data();const m=mode(o.stripeCheckoutSessionId);
    return o.uid===legacy.ref.parent.parent.id &&
      m!=="live" && ["checkout_created","checkout_pending","checkout_creation_failed","cancelled","expired","failed"].includes(o.status);
  }), "LEGACY_ORDER_REQUIRES_REVIEW");
  return {legacyUpdateTime:legacy.updateTime.seconds+":"+legacy.updateTime.nanoseconds,ledgerHash:digest(ledger),ordersHash:ordersDigest(orders)};
}
function checkedOrigin(req) {
  if (req.method!=="POST") return;
  const origin=req.headers.origin,host=req.headers.host;
  assert(typeof origin==="string" && typeof host==="string" && new URL(origin).origin==="https://"+host, "ORIGIN_INVALID");
}
async function stripePreflight(stripe) {
  const account=await stripe.accounts.retrieve();
  assert(account.id===EXPECTED_STRIPE_ACCOUNT, "STRIPE_ACCOUNT_MISMATCH");
  const [payments,sessions,customers,subscriptions]=await Promise.all([
    stripe.paymentIntents.list({limit:1}), stripe.checkout.sessions.list({limit:1}),
    stripe.customers.list({limit:1}), stripe.subscriptions.list({limit:1})
  ]);
  assert([payments,sessions,customers,subscriptions].every(x=>x.data.length===0 && x.has_more===false),"LIVE_STRIPE_DATA_REQUIRES_REVIEW");
}
export default async function handler(req,res) {
  res.setHeader("Cache-Control","no-store, private");
  res.setHeader("Vary","Authorization");
  res.setHeader("X-Content-Type-Options","nosniff");
  if(!["GET","POST"].includes(req.method)) return res.status(405).json({error:"Unsupported method."});
  let stage="initial";
  try {
    assert(process.env.VERCEL_ENV==="production","PRODUCTION_ONLY");
    checkedOrigin(req);
    const bearer=req.headers.authorization;
    assert(typeof bearer==="string" && bearer.startsWith("Bearer ") && bearer.length < 8200,"AUTH_REQUIRED");
    const account=JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON||"{}");
    assert(account.project_id==="kenji-ai-workspace" && process.env.FIREBASE_PROJECT_ID===account.project_id,"FIREBASE_PROJECT_MISMATCH");
    stage="firebase_init";
    const app=getApps()[0]||initializeApp({credential:cert(account),projectId:account.project_id});
    stage="auth_verify";
    const user=await getAuth(app).verifyIdToken(bearer.slice(7),true);
    assert(user.uid===OWNER_UID && user.email_verified===true && user.email?.toLowerCase()===OWNER_EMAIL,"OWNER_ONLY");
    assertStripeKey(process.env.STRIPE_SECRET_KEY);
    stage="stripe_initialize";
    const stripe=new Stripe(process.env.STRIPE_SECRET_KEY);
    // Check actual Production Stripe credentials, not an unrelated connected account.
    stage="stripe_live_preflight";
    await stripePreflight(stripe);
    const db=getFirestore(app);
    const oldUser=db.collection("users").doc(user.uid);
    const oldRef=oldUser.collection("billing").doc("current");
    const liveUser=db.collection("billing_live_users").doc(user.uid);
    const liveRef=liveUser.collection("billing_live").doc("current");
    const markerRef=liveUser.collection("creditLedger").doc(OPENING_LEDGER_ID);
    const ledgerQuery=oldUser.collection("creditLedger").limit(51);
    const orderQuery=db.collection("billingOrders").where("uid","==",user.uid).limit(51);
    stage="firestore_read";
    const [legacy,live,marker,ledgers,orders]=await Promise.all([
      oldRef.get(),liveRef.get(),markerRef.get(),ledgerQuery.get(),orderQuery.get()
    ]);
    if(live.exists || marker.exists) {
      if(live.data()?.legacyReviewComplete===true && marker.exists && marker.data()?.reviewReference===REFERENCE && marker.data()?.credits===0)
        return res.status(200).json({status:"already_complete",liveCredits:live.data().creditBalance??0});
      assert(false,"LIVE_RECORD_ALREADY_EXISTS");
    }
    stage="history_validation";
    const snapshot=validateLegacy(legacy,ledgers.docs,orders.docs);
    const proof=createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    if(req.method==="GET") return res.status(200).json({
      status:"ready",oldCreditsPreserved:legacy.data().creditBalance,liveOpeningCredits:0,
      historicalLedgerRecords:ledgers.size,historicalOrders:orders.size,stripeLiveAccountVerified:true,
      reviewReference:REFERENCE,proof
    });
    assert(req.body?.approval==="START_LIVE_AT_ZERO" && req.body?.proof===proof,"APPROVAL_OR_PROOF_INVALID");
    // Re-read all historical and destination records inside the transaction, before writing anything.
    stage="migration_transaction";
    const result=await db.runTransaction(async tx=>{
      const [oldNow,liveNow,markerNow,ledgerNow,ordersNow]=await Promise.all([
        tx.get(oldRef),tx.get(liveRef),tx.get(markerRef),tx.get(ledgerQuery),tx.get(orderQuery)
      ]);
      assert(!liveNow.exists && !markerNow.exists,"CONCURRENT_MIGRATION");
      const current=validateLegacy(oldNow,ledgerNow.docs,ordersNow.docs);
      assert(safeArrayEqual(current,snapshot),"HISTORY_CHANGED_RETRY");
      tx.create(liveRef,{
        creditBalance:0,legacyReviewComplete:true,legacyReviewReference:REFERENCE,
        status:"inactive",active:false,
        legacySourcePath:oldRef.path,
        reviewedLegacyUpdateTime:snapshot.legacyUpdateTime,
        updatedAt:FieldValue.serverTimestamp()
      });
      tx.create(markerRef,{
        type:"reviewed_legacy_opening_balance",credits:0,reviewReference:REFERENCE,
        legacyPath:oldRef.path,legacyUpdateTime:snapshot.legacyUpdateTime,
        historicalLedgerDigest:snapshot.ledgerHash,
        historicalOrdersDigest:snapshot.ordersHash,
        createdAt:FieldValue.serverTimestamp()
      });
      return "migration_complete";
    },{maxAttempts:3});
    stage="post_write_verify";
    const [after,markerAfter]=await Promise.all([liveRef.get(),markerRef.get()]);
    assert(after.data()?.legacyReviewComplete===true && after.data()?.creditBalance===0 && markerAfter.exists,"POST_WRITE_VERIFICATION_FAILED");
    return res.status(200).json({status:result,liveCredits:0,legacyPreserved:true,reviewReference:REFERENCE});
  } catch(e) {
    const code=typeof e.auditCode==="string" ? e.auditCode : "PREFLIGHT_FAILED";
    const className=typeof e?.type==="string" && /^Stripe[A-Za-z]{2,40}$/.test(e.type)?e.type:undefined;
    const firestoreCode=typeof e?.code==="string" && /^(permission-denied|failed-precondition|unavailable|not-found|unauthenticated)$/.test(e.code)?e.code:undefined;
    console.error("[zero-live-migration]",{code,stage,stripeErrorType:className,firestoreCode});
    const status=["OWNER_ONLY","AUTH_REQUIRED"].includes(code)?403:code==="LIVE_RECORD_ALREADY_EXISTS"?409:code==="PRODUCTION_ONLY"?503:code==="ORIGIN_INVALID"?403:422;
    return res.status(status).json({error:"Migration blocked by safety check.",check:code,stage,reason:className||firestoreCode||null});
  }
}
