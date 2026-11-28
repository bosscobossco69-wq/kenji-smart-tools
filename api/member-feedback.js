import {createHmac,randomUUID} from "node:crypto";
import {isIP} from "node:net";
import {cert,getApps,initializeApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";
import {getFirestore,FieldValue} from "firebase-admin/firestore";
import {billingDb,billingMode} from "../lib/billing-environment.js";
import {notifyAdmin} from "../lib/admin-email-alerts.js";
const DAY=86400000;
const categories=["overall","design","usability","ai","speed","login","payment","support","feature","other"];
const features=["workspace","account","ai_reply","ai_support","credits","payment","website_service","age","tip","percentage","word","json","password","unit","case","qr","whatsapp","invoice","image"];
const placements=["home","footer","account","workspace","support","feedback","tools","services"];
const locales=["en","zh-CN","zh-TW","th","es","ms"];
const devices=["mobile","desktop"];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const err=(status,message)=>Object.assign(Error(message),{status});
function services(){const a=JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON||"null");if(!a||a.project_id!==process.env.FIREBASE_PROJECT_ID||!a.private_key)throw Error("configuration");const app=getApps()[0]||initializeApp({credential:cert(a),projectId:a.project_id});return {auth:getAuth(app),db:billingDb(getFirestore(app)),secret:a.private_key};}
function origin(req){const h=req.headers.host;return typeof h==="string"&&req.headers.origin==="https://"+h&&(["kenjismarttools.com","www.kenjismarttools.com","kenji-smart-tools.vercel.app"].includes(h)||(process.env.VERCEL_ENV!=="production"&&[process.env.VERCEL_URL,process.env.VERCEL_BRANCH_URL].includes(h)));}
async function identify(req,auth){const h=req.headers.authorization;if(typeof h!=="string"||!h.startsWith("Bearer ")||h.length>8500)throw err(401,"Sign in first.");try{const t=await auth.verifyIdToken(h.slice(7),true),u=await auth.getUser(t.uid);if(u.disabled||!u.emailVerified||!t.email_verified||!u.email||typeof t.email!=="string"||t.email.toLowerCase()!==u.email.toLowerCase())throw Error("unverified");return {uid:u.uid,email:u.email};}catch{throw err(403,"Verified account required.");}}
function admin(u){const email=(process.env.WEBSITE_ADMIN_EMAIL||"").trim().toLowerCase();if(!email||u.email.toLowerCase()!==email)throw err(403,"Administrator required.");}
function clean(v,max){if(typeof v!=="string"||v.length>max)throw err(400,"Invalid feedback text.");const s=v.trim();if(/(?:sk_(?:live|test)_|rk_(?:live|test)_|whsec_|-----BEGIN .*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]+|\b(?:\d[ -]?){13,19}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.test(s))throw err(400,"Remove credentials, email addresses and card numbers.");return s;}
const dateKey=t=>new Date(t).toISOString().slice(0,10);
const stamp=v=>typeof v?.toDate==="function"?v.toDate().toISOString():null;
const count=v=>Number.isSafeInteger(v)&&v>=0?v:0;
function add(map,key,delta=1){map[key]=count(map[key])+delta;}
function ratingMap(map,key,rating){const item=map[key]||{};map[key]={count:count(item.count)+1,sum:count(item.sum)+rating};}
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store, private");res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Vary","Authorization, Origin");
 if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed."});}
 if(!origin(req)||req.headers["content-type"]?.split(";")[0]!=="application/json")return res.status(403).json({error:"Invalid request origin."});
 const b=req.body;if(!b||typeof b!=="object"||Array.isArray(b)||JSON.stringify(b).length>5000)return res.status(400).json({error:"Invalid request."});
 try{
  const {auth,db,secret}=services(),now=Date.now(),day=dateKey(now),daily=db.collection("feedbackDaily").doc(day);
  // Anonymous click estimates: one counted click per network/day/placement; no Facebook API or pixel.
  if(b.action==="click"){
   if(!placements.includes(b.placement))throw err(400,"Invalid placement.");
   const ip=String(req.headers["x-vercel-forwarded-for"]||"").trim();if(!isIP(ip))throw err(503,"Click count unavailable.");
   const key=createHmac("sha256",secret).update("feedback-click:"+day+":"+ip+":"+b.placement).digest("hex");
   const marker=db.collection("feedbackClickDays").doc(day+"_"+key);
   let recorded=false;
   await db.runTransaction(async tx=>{recorded=false;const [m,d]=await Promise.all([tx.get(marker),tx.get(daily)]);if(m.exists)return;const data=d.data()||{};if(count(data.clickTotal)>=1000)return;const clicks={...(data.clicks||{})};add(clicks,b.placement);tx.set(marker,{expiresAt:new Date(now+3*DAY)});tx.set(daily,{clicks,clickTotal:count(data.clickTotal)+1},{merge:true});recorded=true;});
   return res.status(200).json({recorded});
  }
  const u=await identify(req,auth);
  const state=db.collection("feedbackState").doc(u.uid);
  if(b.action==="eligibility"){const s=(await state.get()).data()||{};return res.status(200).json({eligible:count(s.nextAt)<=now,nextAt:count(s.nextAt)});}
  if(b.action==="dismiss"){let nextAt=now+7*DAY;await db.runTransaction(async tx=>{const s=(await tx.get(state)).data()||{};nextAt=Math.max(count(s.nextAt),now+7*DAY);tx.set(state,{nextAt},{merge:true});});return res.status(200).json({nextAt});}
  if(b.action==="submit"){
   if(!Number.isInteger(b.rating)||b.rating<1||b.rating>5||!categories.includes(b.category)||!features.includes(b.feature)||!locales.includes(b.language)||!devices.includes(b.device)||typeof b.contactConsent!=="boolean")throw err(400,"Invalid feedback.");
   const comment=clean(b.comment??"",1000),id=randomUUID(),ticketId=b.rating<=2&&b.contactConsent?randomUUID():null;
   const status=b.rating<=2?"needs_attention":b.rating===3?"needs_improvement":"received";
   await db.runTransaction(async tx=>{
    const [s,d]=await Promise.all([tx.get(state),tx.get(daily)]);
    if(count(s.data()?.nextAt)>now)throw err(409,"Feedback invitation is on cooldown.");
    const data=d.data()||{};if(count(data.total)>=100)throw err(429,"Daily feedback limit reached.");
    const ratings={...(data.ratings||{})},byFeature={...(data.byFeature||{})},byDevice={...(data.byDevice||{})},byLanguage={...(data.byLanguage||{})},byCategory={...(data.byCategory||{})};
    add(ratings,String(b.rating));ratingMap(byFeature,b.feature,b.rating);ratingMap(byDevice,b.device,b.rating);ratingMap(byLanguage,b.language,b.rating);add(byCategory,b.category);
    tx.create(db.collection("memberFeedback").doc(id),{uid:u.uid,rating:b.rating,category:b.category,feature:b.feature,language:b.language,device:b.device,comment,status,contactConsent:b.contactConsent,ticketId,createdAt:FieldValue.serverTimestamp()});
    tx.set(state,{nextAt:now+30*DAY,lastFeedbackId:id},{merge:true});
    tx.set(daily,{total:count(data.total)+1,sum:count(data.sum)+b.rating,ratings,byFeature,byDevice,byLanguage,byCategory},{merge:true});
    if(ticketId)tx.create(db.collection("supportTickets").doc(ticketId),{uid:u.uid,contact:u.email,verified:true,message:"Member feedback "+id+" · "+b.rating+" star(s) · "+b.feature+(comment?"\n"+comment:""),status:"open",createdAt:FieldValue.serverTimestamp(),feedbackId:id});
   });
   let notification="not_required";if(b.rating<=2){try{const r=await notifyAdmin(db,"feedback_low",id,{orderId:ticketId||id,category:b.category,source:"member_feedback",stage:"rating_"+b.rating,environment:billingMode()});notification=r.status;}catch{notification="pending";}}
   return res.status(201).json({id,ticketId,notification,nextAt:now+30*DAY});
  }
  admin(u);
  if(b.action==="summary"){
   const days=[7,30,90].includes(b.days)?b.days:30;
   const keys=Array.from({length:days},(_,i)=>dateKey(now-i*DAY));
   const docs=await Promise.all(keys.map(k=>db.collection("feedbackDaily").doc(k).get()));
   return res.status(200).json({environment:billingMode(),days,series:docs.map((d,i)=>({date:keys[i],...(d.data()||{})}))});
  }
  if(b.action==="list"){
   const days=[7,30,90].includes(b.days)?b.days:30;
   const start=new Date(dateKey(now-(days-1)*DAY)+"T00:00:00Z");
   let q=db.collection("memberFeedback").where("createdAt",">=",start).orderBy("createdAt","desc");
   if(b.cursor!==undefined&&b.cursor!==null){if(typeof b.cursor!=="string"||!uuid.test(b.cursor))throw err(400,"Invalid cursor.");const marker=await db.collection("memberFeedback").doc(b.cursor).get();if(!marker.exists)throw err(400,"Invalid cursor.");q=q.startAfter(marker);}
   const page=await q.limit(51).get(),docs=page.docs.slice(0,50);
   return res.status(200).json({nextCursor:page.docs.length>50?docs[49].id:null,records:docs.map(d=>{const x=d.data();return {id:d.id,rating:x.rating,category:x.category,feature:x.feature,language:x.language,device:x.device,comment:x.comment,status:x.status,note:x.note||"",contactConsent:x.contactConsent===true,ticketId:x.ticketId||null,createdAt:stamp(x.createdAt)};})});
  }
  if(b.action==="resolve"){
   if(typeof b.id!=="string"||!uuid.test(b.id))throw err(400,"Invalid feedback ID.");
   const note=clean(b.note??"",1000),ref=db.collection("memberFeedback").doc(b.id);
   await db.runTransaction(async tx=>{const d=await tx.get(ref);if(!d.exists)throw err(404,"Feedback not found.");tx.update(ref,{status:"resolved",note,resolvedAt:FieldValue.serverTimestamp()});});
   return res.status(200).json({ok:true});
  }
  throw err(400,"Invalid action.");
 }catch(e){const status=[400,401,403,404,409,429,503].includes(e.status)?e.status:503;return res.status(status).json({error:status===503?"Feedback temporarily unavailable.":e.message});}
}
