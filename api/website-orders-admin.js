import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { billingDb } from "../lib/billing-environment.js";

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
