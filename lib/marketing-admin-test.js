import { FieldValue } from "firebase-admin/firestore";
import { preferenceRef, unsubscribeSignature } from "./marketing-consent.js";
import { hasRecordedPurchase } from "./marketing-purchase.js";

const MAX_PER_DAY=1;
function dayUTC(){return new Date().toISOString().slice(0,10);}
export function eligibleForMarketingTest(person,pref,adminEmail) {
  if(!person?.uid || person.disabled || !person.emailVerified || !person.email ||
     person.email.toLowerCase()!==String(adminEmail||"").trim().toLowerCase())
    return "verified_admin_required";
  if(!pref || pref.uid!==person.uid || pref.email?.toLowerCase()!==person.email.toLowerCase() ||
      pref.marketingConsent!==true || !pref.consentedAt || pref.unsubscribedAt) return "consent_required";
  return "eligible";
}
export async function adminMarketingTestStatus({db,person,adminEmail}) {
  if(process.env.VERCEL_ENV!=="production")return {eligible:false,reason:"production_only"};
  if(!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL || !process.env.CRON_SECRET)
    return {eligible:false,reason:"sender_unavailable"};
  const preference=await preferenceRef(db,person.uid).get();
  const allowed=eligibleForMarketingTest(person,preference.data(),adminEmail);
  if(allowed!=="eligible")return {eligible:false,reason:allowed};
  // Same as the scheduled campaign purchase gate: do not send to buyers.
  if(await hasRecordedPurchase(db,person))return {eligible:false,reason:"purchase_detected"};
  const sentRef=db.collection("marketingAdminTests").doc(person.uid+"_"+dayUTC());
  if((await sentRef.get()).exists)return {eligible:false,reason:"already_attempted_today"};
  return {eligible:true,reason:"ready"};
}
export async function sendAdminMarketingTest({db,person,adminEmail}) {
  const status=await adminMarketingTestStatus({db,person,adminEmail});
  if(!status.eligible)return {...status,sent:false};
  const ref=db.collection("marketingAdminTests").doc(person.uid+"_"+dayUTC());
  const preference=preferenceRef(db,person.uid);
  const consented=(await preference.get()).data()?.consentedAt?.toMillis?.();
  if(!Number.isFinite(consented))return {sent:false,reason:"consent_required"};
  // Single-use claim is permanent even if Resend returns an ambiguous error.
  // This is deliberate to prevent repeated sends and requires manual review on failure.
  let claimed=false;
  await db.runTransaction(async tx=>{
    const [prior,latest]=await Promise.all([tx.get(ref),tx.get(preference)]);
    if(prior.exists)return;
    const p=latest.data();
    if(p?.marketingConsent!==true||p?.unsubscribedAt||
       p.consentedAt?.toMillis?.()!==consented)return;
    tx.create(ref,{uid:person.uid,status:"attempting",createdAt:FieldValue.serverTimestamp()});
    claimed=true;
  });
  if(!claimed)return {sent:false,reason:"consent_changed_or_attempted"};
  try {
    // Re-read purchase evidence directly before provider submission.
    if(await hasRecordedPurchase(db,person)){
      await ref.set({status:"suppressed_purchase",checkedAt:FieldValue.serverTimestamp()},{merge:true});
      return {sent:false,reason:"purchase_detected"};
    }
    const latest=(await preference.get()).data();
    if(eligibleForMarketingTest(person,latest,adminEmail)!=="eligible"||
       latest.consentedAt?.toMillis?.()!==consented){
      await ref.set({status:"suppressed_consent",checkedAt:FieldValue.serverTimestamp()},{merge:true});
      return {sent:false,reason:"consent_changed"};
    }
    const unsubscribe="https://kenjismarttools.com/unsubscribe.html?uid="+
       encodeURIComponent(person.uid)+"&signature="+unsubscribeSignature(person.uid);
    const text="KENJI Smart Tools — marketing test email\n\n"+
      "This message was sent only because the verified site administrator expressly clicked the single-recipient test button. "+
      "It demonstrates the same optional product email format used by KENJI. "+
      "No purchase or subscription is required.\n\n"+
      "Unsubscribe from optional product emails: "+unsubscribe+"\n"+
      "Security and transaction receipts are unaffected.";
    const response=await fetch("https://api.resend.com/emails",{
      method:"POST",
      headers:{Authorization:"Bearer "+process.env.RESEND_API_KEY,
        "Content-Type":"application/json",
        "Idempotency-Key":"kenji-admin-marketing-test-"+person.uid+"-"+dayUTC()},
      body:JSON.stringify({from:process.env.RESEND_FROM_EMAIL,to:[person.email],
        subject:"[KENJI TEST] Optional product email & unsubscribe",text}),
      signal:AbortSignal.timeout(9000)
    });
    if(!response.ok)throw Error("provider_rejected_"+response.status);
    const delivered=await response.json();
    if(typeof delivered?.id!=="string"||!delivered.id)throw Error("provider_missing_id");
    await ref.set({status:"accepted",messageId:delivered.id,
      updatedAt:FieldValue.serverTimestamp()},{merge:true});
    return {sent:true,reason:"accepted_by_provider"};
  }catch{
    try{await ref.set({status:"delivery_unconfirmed",updatedAt:FieldValue.serverTimestamp()},{merge:true});}catch{}
    return {sent:false,reason:"delivery_unconfirmed_check_resend_before_retrying"};
  }
}
