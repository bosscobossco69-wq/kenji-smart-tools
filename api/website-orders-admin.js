import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { billingDb } from "../lib/billing-environment.js";
import { adminEmailConfigured, notifyAdmin } from "../lib/admin-email-alerts.js";

const allowedStatuses = new Set(["new", "in_progress", "delivered", "on_hold"]);
let services;
async function getServices(){
  if(!services) services=(async()=>{
    const raw=process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const account=JSON.parse(raw||"null");
    if(!account||account.project_id!==process.env.FIREBASE_PROJECT_ID) throw Error("Firebase server configuration missing");
    const app=getApps()[0]||initializeApp({credential:cert(account),projectId:account.project_id});
    return {auth:getAuth(app),db:billingDb(getFirestore(app))};
  })();
  return services;
}
const toISO=v=>typeof v?.toDate==="function"?v.toDate().toISOString():null;
const safeOrder=(id,data)=>({
  orderId:id,packageId:data.packageId||null,amount:data.amount||0,currency:data.currency||"usd",
  paymentStatus:data.status||"unknown",workflowStatus:data.workflowStatus||"new",
  customerEmail:data.buyerEmail||null,createdAt:toISO(data.createdAt),paidAt:toISO(data.paidAt),
  onboardingSubmittedAt:toISO(data.onboardingSubmittedAt),
  onboarding:data.onboarding?{
    businessName:data.onboarding.businessName||"",contactEmail:data.onboarding.contactEmail||"",
    projectDetails:data.onboarding.projectDetails||""
  }:null,
  adminNote:data.adminNote||"",
  stripeCheckoutSessionId:data.stripeCheckoutSessionId||null
});
export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store, private");
  res.setHeader("X-Content-Type-Options","nosniff");
  if(!["GET","POST"].includes(req.method)){res.setHeader("Allow","GET, POST");return res.status(405).json({error:"Method not allowed."});}
  try{
    const configuredEmail=(process.env.WEBSITE_ADMIN_EMAIL||"").trim().toLowerCase();
    if(!configuredEmail) return res.status(503).json({error:"Website order administration is not configured."});
    const h=req.headers.authorization||"";
    if(typeof h!=="string"||!h.startsWith("Bearer ")||h.length>8500)return res.status(401).json({error:"Sign in required."});
    const {auth,db}=await getServices();
    const identity=await auth.verifyIdToken(h.slice(7),true);
    if(!identity.email_verified||identity.email?.toLowerCase()!==configuredEmail) return res.status(403).json({error:"Administrator account required."});
    const currentUser=await auth.getUser(identity.uid);
    if(currentUser.disabled||!currentUser.emailVerified||currentUser.email?.toLowerCase()!==configuredEmail)return res.status(403).json({error:"Administrator verification failed."});
    // Read-only diagnostics: only the verified administrator may inspect isolated Test webhook processing.
    // Never return Firebase UIDs, Stripe customers, payment details or secrets.
    if(req.method==="GET" && req.query?.view==="sandbox_webhook"){
      const snapshot=await db.legacyDb.collection("billing_test_stripeWebhookEvents")
        .orderBy("receivedAt","desc").limit(12).get();
      return res.status(200).json({
        environment:"sandbox",count:snapshot.size,
        events:snapshot.docs.map(doc=>{
          const d=doc.data();
          return {
            id:doc.id,type:typeof d.type==="string"?d.type:null,
            processingStatus:typeof d.processingStatus==="string"?d.processingStatus:"unknown",
            processed:d.processed===true,
            attempts:Number.isSafeInteger(d.attempts)?d.attempts:0,
            receivedAt:toISO(d.receivedAt),processedAt:toISO(d.processedAt)
          };
        })
      });
    }
    // Unified live overview. Read-only; sampled limits are disclosed in the response.
    // Never count unfinished Checkout as a declined payment or test traffic as revenue.
    if(req.method==="GET" && req.query?.view==="customer_overview"){
      const isLive=process.env.VERCEL_ENV==="production";
      const [usersPage,websitePage,billingPage,webhookPage]=await Promise.all([
        auth.listUsers(1000),
        db.collection("websiteOrders").orderBy("createdAt","desc").limit(100).get(),
        db.collection("billingOrders").orderBy("createdAt","desc").limit(100).get(),
        db.collection("stripeWebhookEvents").orderBy("receivedAt","desc").limit(80).get()
      ]);
      const users=usersPage.users.map(u=>({
        uid:u.uid,email:u.email||null,name:u.displayName||null,
        emailVerified:u.emailVerified===true,
        createdAt:u.metadata.creationTime||null,
        lastSignInAt:u.metadata.lastSignInTime||null,
        disabled:u.disabled===true
      }));
      const userMap=new Map(users.map(u=>[u.uid,u]));
      const website=websitePage.docs.map(d=>{
        const x=d.data();return {
          id:d.id,kind:"Website service",product:x.packageId||"Website service",
          email:x.buyerEmail||x.onboarding?.contactEmail||null,
          amount:Number.isSafeInteger(x.amount)?x.amount:null,currency:x.currency||"usd",
          status:x.status||"unknown",
          createdAt:toISO(x.createdAt),paidAt:toISO(x.paidAt),
          workflowStatus:x.workflowStatus||"new"
        };
      });
      const billing=billingPage.docs.map(d=>{
        const x=d.data();return {
          id:d.id,kind:x.type==="credit_pack"?"Credits": "Subscription",
          product:x.packId||x.planId||"Checkout",
          email:userMap.get(x.uid)?.email||null,
          amount:Number.isSafeInteger(x.amount)?x.amount:null,currency:x.currency||"usd",
          status:x.status||"unknown",
          createdAt:toISO(x.createdAt),paidAt:toISO(x.paidAt),
          workflowStatus:null
        };
      });
      const orders=[...website,...billing].sort((a,b)=>(b.createdAt||"").localeCompare(a.createdAt||""));
      const isPaid=s=>s==="paid";
      // 'pending' does not mean Stripe declined a charge. Only explicit failed states qualify.
      const isFailed=s=>["payment_failed","failed"].includes(s);
      const totals=orders.reduce((out,o)=>{
        if(isPaid(o.status)){out.paid++;if(o.currency==="usd"&&o.amount!==null)out.paidUsdCents+=o.amount;}
        else if(isFailed(o.status))out.failed++;
        else out.pending++;
        return out;
      },{paid:0,failed:0,pending:0,paidUsdCents:0});
      const webhookFailures=webhookPage.docs.filter(d=>d.data().type==="invoice.payment_failed")
        .map(d=>({eventId:d.id,receivedAt:toISO(d.data().receivedAt),
          processed:d.data().processed===true}));
      const activity=[
        ...users.map(u=>({kind:"registration",email:u.email,time:u.createdAt,detail:u.emailVerified?"Email verified":"Email unverified"})),
        ...orders.map(o=>({kind:isPaid(o.status)?"payment_success":isFailed(o.status)?"payment_failed":"checkout_created",
          email:o.email,time:isPaid(o.status)?o.paidAt||o.createdAt:o.createdAt,
          detail:o.kind+" · "+o.product+" · "+o.status})),
        ...webhookFailures.map(e=>({kind:"invoice_payment_failed",email:null,time:e.receivedAt,
          detail:"Stripe invoice payment failed; webhook "+(e.processed?"processed":"not confirmed")}))
      ].filter(x=>x.time).sort((a,b)=>b.time.localeCompare(a.time)).slice(0,60);
      return res.status(200).json({
        environment:isLive?"live":"preview_test",
        generatedAt:new Date().toISOString(),
        scope:{firebaseUsers:users.length,usersTruncated:Boolean(usersPage.pageToken),
          websiteOrders:website.length,websiteOrdersTruncated:websitePage.size===100,
          billingOrders:billing.length,billingOrdersTruncated:billingPage.size===100,
          webhookEventsSampled:webhookPage.size},
        summary:{registrations:users.length,verifiedUsers:users.filter(u=>u.emailVerified).length,
          ...totals,invoiceFailureEvents:webhookFailures.length},
        users:users.sort((a,b)=>(b.createdAt||"").localeCompare(a.createdAt||"")).slice(0,75),
        orders:orders.slice(0,100),activity
      });
    }
    // Use the existing protected administrator endpoint: no extra Vercel function.
    if(req.method==="POST" && req.body?.action==="test_email"){
      if(Object.keys(req.body).length!==1) return res.status(400).json({error:"Invalid test request."});
      if(!adminEmailConfigured()) return res.status(503).json({error:"Admin email is not configured."});
      const day=new Date().toISOString().slice(0,10);
      try{
        const result=await notifyAdmin(db,"admin_test","smoke:"+day,{
          source:"admin_dashboard",environment:process.env.VERCEL_ENV==="production"?"live":"test"
        });
        return res.status(200).json({status:result.status,message:result.status==="sent"
          ?"Test email accepted by Resend. Check delivery logs and inbox."
          :"Test already processed or currently sending. Check logs and inbox."});
      }catch(error){
        console.warn("[website-orders-admin] Email test not confirmed.",{code:typeof error?.code==="string"?error.code:"failed"});
        return res.status(503).json({error:"Test send not confirmed. Check Resend and Firestore before retrying."});
      }
    }
    const collection=db.collection("websiteOrders");
    if(req.method==="GET"){
      const snapshot=await collection.orderBy("createdAt","desc").limit(60).get();
      return res.status(200).json({orders:snapshot.docs.map(d=>safeOrder(d.id,d.data())),count:snapshot.size});
    }
    const body=req.body&&typeof req.body==="object"&&!Array.isArray(req.body)?req.body:{};
    const orderId=typeof body.orderId==="string"?body.orderId:"";
    const workflowStatus=typeof body.workflowStatus==="string"?body.workflowStatus:"";
    const adminNote=typeof body.adminNote==="string"?body.adminNote:"";
    if(!/^[a-z0-9-]{36}$/.test(orderId)||!allowedStatuses.has(workflowStatus)||adminNote.length>1500)
      return res.status(400).json({error:"Invalid order update."});
    const ref=collection.doc(orderId);
    await db.runTransaction(async tx=>{
      const old=await tx.get(ref);
      if(!old.exists)throw Object.assign(new Error("Order not found"),{statusCode:404});
      if(old.data().status!=="paid")throw Object.assign(new Error("Only paid orders can enter the delivery workflow."),{statusCode:409});
      tx.set(ref,{workflowStatus,adminNote:adminNote.trim(),workflowUpdatedAt:FieldValue.serverTimestamp(),
        updatedAt:FieldValue.serverTimestamp()}, {merge:true});
    });
    return res.status(200).json({updated:true,orderId,workflowStatus});
  }catch(e){
    const code=Number(e?.statusCode||0);
    if(code===404||code===409)return res.status(code).json({error:e.message});
    if(e?.code?.startsWith?.("auth/"))return res.status(401).json({error:"Sign in again."});
    console.error("[website-orders-admin]",{code:typeof e?.code==="string"?e.code:"server_error"});
    return res.status(503).json({error:"Order administration is unavailable. Please try again."});
  }
}
