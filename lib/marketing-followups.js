import { createHash, randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { billingCollection } from "./billing-environment.js";
import { unsubscribeSignature } from "./marketing-consent.js";

const DAY=86400000;
const STAGES = [
  {id:"welcome",afterDays:1,subject:"Welcome to KENJI Smart Tools",
   body:"Thanks for joining KENJI Smart Tools! Explore our free browser tools and AI Customer Reply at https://kenjismarttools.com/."},
  {id:"tips",afterDays:3,subject:"Get more from your free KENJI account",
   body:"Try our free tools for quick daily tasks. For extra AI replies, you can explore optional pay-as-you-go Credits at https://kenjismarttools.com/workspace/billing.html. No subscription is required."},
  {id:"reminder",afterDays:7,subject:"Your KENJI tools are still here",
   body:"Your KENJI Smart Tools account is available whenever you need it. Explore browser tools and optional AI Credits at https://kenjismarttools.com/. This is our last onboarding reminder."}
];
const MAX_SENDS=5;
const LEASE_MS=180000;
function asMillis(x) {return typeof x?.toMillis==="function"?x.toMillis():x instanceof Date?x.getTime():null;}
function messageFor(stage,uid) {
 const url="https://kenjismarttools.com/unsubscribe.html?uid="+encodeURIComponent(uid)+"&signature="+unsubscribeSignature(uid);
 return stage.body+"\n\nUnsubscribe from optional product emails: "+url+"\nYour account and transactional receipts will continue to work.";
}
// This worker is disabled unless explicitly enabled after testing.
export async function runMarketingFollowups({db,auth}) {
 if(process.env.VERCEL_ENV!=="production"||process.env.MARKETING_EMAILS_ENABLED!=="true") return {enabled:false,sent:0,skipped:0};
 if(!process.env.RESEND_API_KEY||!process.env.RESEND_FROM_EMAIL||!process.env.CRON_SECRET) return {enabled:true,error:"configuration_missing",sent:0};
 let sent=0,skipped=0;
 const users=await db.collection("marketingPreferences").where("marketingConsent","==",true).limit(100).get();
 for(const record of users.docs){
   if(sent>=MAX_SENDS)break;
   const pref=record.data();
   const uid=record.id;
   if(pref.uid!==uid||!pref.consentedAt||!pref.email) {skipped++;continue;}
   try{
     const person=await auth.getUser(uid);
     if(person.disabled||!person.emailVerified||!person.email||person.email.toLowerCase()!==pref.email.toLowerCase()||
        person.email.toLowerCase()===(process.env.WEBSITE_ADMIN_EMAIL||"").toLowerCase()) {skipped++;continue;}
     const born=Date.parse(person.metadata.creationTime||"");
     const consented=asMillis(pref.consentedAt);
     if(!Number.isFinite(born)||!Number.isFinite(consented)||consented<born-60000){skipped++;continue;}
     const age=(Date.now()-born)/DAY;
     const eligible=STAGES.filter(x=>age>=x.afterDays&&age<x.afterDays+5);
     if(!eligible.length){skipped++;continue;}
     // Fail closed on ambiguous payments or purchase-reconciliation errors.
     const [billing,orders,webOrders]=await Promise.all([
       db.collection("users").doc(uid).collection(billingCollection()).doc("current").get(),
       db.collection("billingOrders").where("uid","==",uid).limit(100).get(),
       db.collection("websiteOrders").where("buyerEmail","==",person.email).limit(20).get()
     ]);
     const account=billing.data()||{};
     if(account.lastCreditOrderId||account.lastCreditGrantInvoiceId||
        ["active","trialing","past_due"].includes(account.status) ||
        orders.size===100||orders.docs.some(x=>x.data().status==="paid")||
        webOrders.size===20||webOrders.docs.some(x=>x.data().status==="paid")){skipped++;continue;}
     for(const stage of eligible){
       if(sent>=MAX_SENDS)break;
       const id=createHash("sha256").update(uid+":"+stage.id+":"+consented).digest("hex");
       const ref=db.collection("marketingEmailSends").doc(id);
       const lease=randomUUID();let acquired=false;
       await db.runTransaction(async tx=>{
         const [attempt,savedPref]=await Promise.all([tx.get(ref),tx.get(record.ref)]);
         if(!savedPref.exists||savedPref.data().marketingConsent!==true||
            asMillis(savedPref.data().consentedAt)!==consented) return;
         const prior=attempt.data(),now=Date.now();
         if(prior?.status==="sent"||Number(prior?.attempts||0)>=3||
            (prior?.status==="sending"&&Number(prior.leaseUntilMs||0)>now))return;
         tx.set(ref,{uid,stage:stage.id,status:"sending",lease,
           leaseUntilMs:now+LEASE_MS,attempts:FieldValue.increment(1),
           updatedAt:FieldValue.serverTimestamp()}, {merge:true});
         acquired=true;
       });
       if(!acquired)continue;
       try{
         const response=await fetch("https://api.resend.com/emails",{
           method:"POST",headers:{Authorization:"Bearer "+process.env.RESEND_API_KEY,
             "Content-Type":"application/json","Idempotency-Key":"kenji-followup-"+id},
           body:JSON.stringify({from:process.env.RESEND_FROM_EMAIL,to:[person.email],
             subject:stage.subject,text:messageFor(stage,uid)}),
           signal:AbortSignal.timeout(9000)
         });
         if(!response.ok)throw Error("provider_"+response.status);
         const delivered=await response.json();
         if(typeof delivered.id!=="string")throw Error("missing_message_id");
         await ref.set({status:"sent",messageId:delivered.id,sentAt:FieldValue.serverTimestamp(),
           lease:FieldValue.delete(),leaseUntilMs:FieldValue.delete()}, {merge:true});
         sent++;
       }catch{
         await ref.set({status:"pending",lease:FieldValue.delete(),leaseUntilMs:FieldValue.delete(),
           lastAttemptAt:FieldValue.serverTimestamp()},{merge:true});
       }
     }
   }catch{skipped++;}
 }
 return {enabled:true,scanned:users.size,sent,skipped,limited:users.size===100};
}
