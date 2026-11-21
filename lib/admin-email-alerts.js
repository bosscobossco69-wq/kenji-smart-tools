import { createHash, randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";

// Alerts are server-side only. Neither Stripe customer data nor user-submitted text is emailed.
// The database passed here is the billingDb wrapper, so Preview and Production remain separate.
const TYPES = new Set(["website_paid", "website_onboarding", "credit_paid", "subscription_paid", "billing_failure", "system_failure", "admin_test"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LEASE_MS = 120000;
const MAX_ATTEMPTS = 20;

export function adminEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY &&
    EMAIL_PATTERN.test(process.env.RESEND_FROM_EMAIL || "") &&
    EMAIL_PATTERN.test(process.env.ADMIN_ALERT_EMAIL || process.env.WEBSITE_ADMIN_EMAIL || ""));
}
export function alertId(type, reference) {
  if (!TYPES.has(type) || typeof reference !== "string" || reference.length < 1 || reference.length > 200) {
    throw new Error("Invalid administrator alert type or reference.");
  }
  return createHash("sha256").update(type + ":" + reference).digest("hex");
}
function cleanDetails(details) {
  const permitted = ["orderId", "package", "plan", "amountUsd", "credits", "source", "category", "stage", "environment"];
  const result = {};
  for (const key of permitted) {
    const value = details?.[key];
    if (typeof value === "string" && value.length <= 100 && /^[\w .:+-]*$/.test(value)) result[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
  }
  return result;
}
function subjectFor(type) {
  return ({
    website_paid: "Website service payment received",
    website_onboarding: "Website project details submitted",
    credit_paid: "Credits payment and allocation",
    subscription_paid: "Subscription invoice paid and Credits granted",
    billing_failure: "Billing action requires attention",
    system_failure: "Website system error requires attention",
    admin_test: "Administrator email delivery test"
  })[type];
}
function messageFor(type, details) {
  const lines = ["KENJI Smart Tools administrative notification", "Event: " + subjectFor(type)];
  for (const [key, value] of Object.entries(details)) lines.push(key + ": " + String(value));
  lines.push("", "Open the protected KENJI admin dashboard or Stripe/Firebase console to inspect the record.");
  lines.push("This email intentionally excludes card details, customer emails, credentials and submitted project text.");
  return lines.join("\n");
}
async function sendEmail(type, id, details) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.RESEND_API_KEY,
      "Content-Type": "application/json",
      "Idempotency-Key": "kenji-alert-" + id
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL,
      to: [process.env.ADMIN_ALERT_EMAIL || process.env.WEBSITE_ADMIN_EMAIL],
      subject: "[KENJI " + (process.env.VERCEL_ENV === "production" ? "LIVE" : "TEST") + "] " + subjectFor(type),
      text: messageFor(type, details)
    }),
    signal: AbortSignal.timeout(8000)
  });
  // Do not log response bodies; providers may include recipient and other private details.
  if (!response.ok) {
    const error = new Error("Email provider rejected the notification.");
    error.status = response.status;
    throw error;
  }
  const json = await response.json();
  if (typeof json?.id !== "string" || !json.id) throw new Error("Email provider returned no message identifier.");
  return json.id;
}
export async function deliverAdminAlert(db, id) {
  if (!adminEmailConfigured()) return { status: "not_configured" };
  const ref = db.collection("adminEmailAlerts").doc(id);
  const token = randomUUID();
  let work;
  await db.runTransaction(async tx => {
    work = null;
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return;
    const data = snapshot.data();
    const now = Date.now();
    if (data.status === "sent" || Number(data.attempts || 0) >= MAX_ATTEMPTS ||
        (data.status === "sending" && Number(data.leaseUntilMs || 0) > now)) return;
    work = { type: data.type, details: cleanDetails(data.details) };
    tx.set(ref, {
      status: "sending", leaseToken: token, leaseUntilMs: now + LEASE_MS,
      attempts: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });
  if (!work) return { status: "skipped" };
  try {
    const messageId = await sendEmail(work.type, id, work.details);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (snap.data()?.leaseToken !== token) return;
      tx.set(ref, {
        status: "sent", messageId, sentAt: FieldValue.serverTimestamp(),
        leaseToken: FieldValue.delete(), leaseUntilMs: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    });
    return { status: "sent" };
  } catch (error) {
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (snap.data()?.leaseToken !== token) return;
      tx.set(ref, {
        status: "pending", lastProviderStatus: Number(error?.status || 0) || null,
        lastAttemptAt: FieldValue.serverTimestamp(),
        leaseToken: FieldValue.delete(), leaseUntilMs: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    });
    throw error;
  }
}
export async function notifyAdmin(db, type, reference, details = {}) {
  const id = alertId(type, reference);
  const ref = db.collection("adminEmailAlerts").doc(id);
  await ref.create({
    type, details: cleanDetails(details), status: "pending",
    attempts: 0, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
  }).catch(error => {
    if (error?.code !== 6 && error?.code !== "already-exists") throw error;
  });
  return deliverAdminAlert(db, id);
}
export async function notifyAdminSafely(db, type, reference, details = {}) {
  try { await notifyAdmin(db, type, reference, details); }
  catch { console.warn("[kenji-admin-alert] Notification queued or delivery failed.", { type }); }
}
export function errorAlertReference(source, stage) {
  const bucket = Math.floor(Date.now() / (60 * 60 * 1000));
  return String(source).slice(0, 40) + ":" + String(stage).slice(0, 40) + ":" + bucket;
}
