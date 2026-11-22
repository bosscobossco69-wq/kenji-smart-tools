import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { billingDb } from "../lib/billing-environment.js";

// Anonymous, approximate *browser/day* conversion counters.
// Does not store IP address, email, user agent, password or Firebase UID.
// No advertising emails are triggered by these events.
const EVENTS = new Set(["signup_link","signup_page","signup_submit","signup_error"]);
const COOKIE = "kenji_funnel_session";
let servicesPromise;
function services() {
  if (!servicesPromise) servicesPromise = (async () => {
    const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "null");
    if (!account?.private_key || account.project_id !== process.env.FIREBASE_PROJECT_ID) {
      throw new Error("Firebase service not configured");
    }
    const app = getApps()[0] || initializeApp({
      credential: cert(account), projectId: account.project_id
    });
    return { db: billingDb(getFirestore(app)), secret: account.private_key };
  })();
  return servicesPromise;
}
function signature(secret, value) {
  return createHmac("sha256", secret).update("kenji-conversion-v1:" + value).digest("hex");
}
function getCookie(header) {
  return String(header || "").split(";").map(x=>x.trim())
    .find(x=>x.startsWith(COOKIE+"="))?.slice(COOKIE.length+1) || "";
}
function cookieId(header, secret) {
  const value=getCookie(header);
  const parts=value.split(".");
  if(parts.length!==2 || !/^[a-f0-9]{32}$/.test(parts[0]) || !/^[a-f0-9]{64}$/.test(parts[1]))return null;
  const expected=Buffer.from(signature(secret,parts[0]),"hex");
  const actual=Buffer.from(parts[1],"hex");
  return timingSafeEqual(expected,actual)?parts[0]:null;
}
export async function recordFunnel(req,res) {
  res.setHeader("Cache-Control","no-store");
  res.setHeader("X-Content-Type-Options","nosniff");
  if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed"});}
  // Reject cross-site sends; require a real same-origin browser request.
  const origin=req.headers.origin,host=req.headers.host;
  if(typeof origin!=="string"||typeof host!=="string"||origin!=="https://"+host) {
    return res.status(403).json({error:"Origin not allowed"});
  }
  if(req.headers["sec-fetch-site"]==="cross-site")return res.status(403).json({error:"Origin not allowed"});
  if(!String(req.headers["content-type"]||"").startsWith("application/json"))return res.status(415).json({error:"JSON required"});
  const event=req.body?.event;
  if(typeof event!=="string"||!EVENTS.has(event)||JSON.stringify(req.body).length>150) {
    return res.status(400).json({error:"Invalid event"});
  }
  try {
    const {db,secret}=await services();
    let visitor=cookieId(req.headers.cookie,secret);
    if(!visitor) {
      visitor=randomBytes(16).toString("hex");
      res.setHeader("Set-Cookie",COOKIE+"="+visitor+"."+signature(secret,visitor)+"; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax");
    }
    const day=new Date().toISOString().slice(0,10);
    const uniqueRef=db.collection("conversionDedupe").doc(day+"_"+event+"_"+visitor);
    const totalRef=db.collection("conversionDaily").doc(day);
    let recorded=false;
    await db.runTransaction(async tx=>{
      const exists=await tx.get(uniqueRef);
      if(exists.exists)return;
      tx.create(uniqueRef,{event,day,createdAt:FieldValue.serverTimestamp()});
      tx.set(totalRef,{[event]:FieldValue.increment(1),updatedAt:FieldValue.serverTimestamp()},{merge:true});
      recorded=true;
    });
    return res.status(200).json({ok:true,recorded});
  }catch(error) {
    console.warn("[conversion-event] counter unavailable",{code:typeof error?.code==="string"?error.code:"server_error"});
    return res.status(503).json({error:"Conversion event unavailable"});
  }
}
