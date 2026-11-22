import { createHmac, timingSafeEqual } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";

// Signatures are scoped to one Firebase UID and never reveal credentials.
const TOKEN_VERSION = "v1";
export function unsubscribeSignature(uid) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) throw new Error("Unsubscribe signing configuration missing");
  return createHmac("sha256", secret).update("marketing-unsubscribe:" + TOKEN_VERSION + ":" + uid).digest("hex");
}
export function validUnsubscribeSignature(uid, signature) {
  if (typeof uid !== "string" || uid.length < 4 || uid.length > 128 ||
      !/^[A-Za-z0-9_-]+$/.test(uid) || typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected=Buffer.from(unsubscribeSignature(uid),"hex");
  return timingSafeEqual(expected,Buffer.from(signature,"hex"));
}
export function preferenceRef(db, uid) {
  return db.collection("marketingPreferences").doc(uid);
}
export async function updateMarketingPreference(db, user, optedIn, source) {
  if(typeof optedIn!=="boolean" || !["signup","account"].includes(source)) throw new Error("Invalid marketing preference");
  const uid = user.uid;
  const verified = user.emailVerified === true;
  const ref = preferenceRef(db, uid);
  // A non-verified user can request opt-in at signup, but sending is forbidden until verified.
  await ref.set({
    uid,
    email: user.email,
    marketingConsent: optedIn,
    consentSource: source,
    consentVersion: TOKEN_VERSION,
    consentUpdatedAt: FieldValue.serverTimestamp(),
    ...(optedIn ? {consentedAt: FieldValue.serverTimestamp(),unsubscribedAt:FieldValue.delete()}:
      {unsubscribedAt:FieldValue.serverTimestamp(),consentedAt:FieldValue.delete()}),
    followupState: "not_scheduled",
    updatedAt:FieldValue.serverTimestamp()
  },{merge:true});
  return {marketingConsent:optedIn,emailVerified:verified};
}
export async function unsubscribeBySignature(db, uid, signature) {
  if (!validUnsubscribeSignature(uid, signature)) return false;
  const ref=preferenceRef(db,uid);
  await db.runTransaction(async tx=>{
    const doc=await tx.get(ref);
    if(!doc.exists) return;
    tx.set(ref,{
      marketingConsent:false,
      unsubscribedAt:FieldValue.serverTimestamp(),
      consentUpdatedAt:FieldValue.serverTimestamp(),
      followupState:"unsubscribed",
      updatedAt:FieldValue.serverTimestamp()
    },{merge:true});
  });
  return true;
}
