import { adminEmailConfigured, deliverAdminAlert } from "../lib/admin-email-alerts.js";
import { billingMode, billingDb, assertStripeKey, assertStripeObject } from "../lib/billing-environment.js";
import Stripe from "stripe";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { runMarketingFollowups } from "../lib/marketing-followups.js";

const PLAN_CREDITS = { lite: 10000, pro: 30000, pro_plus: 100000, ultra: 400000 };
let servicesPromise;

function getServices() {
  if (!servicesPromise) {
    servicesPromise = (async () => {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      assertStripeKey(stripeKey);
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const rawAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (!stripeKey || !projectId || !rawAccount) throw new Error("Billing service is not configured.");
      let account;
      try { account = JSON.parse(rawAccount); } catch { throw new Error("Firebase service account is invalid."); }
      if (account.project_id !== projectId) throw new Error("Firebase project mismatch.");
      const app = getApps()[0] || initializeApp({ credential: cert(account), projectId });
      return { stripe: new Stripe(stripeKey), db: billingDb(getFirestore(app)), auth:getAuth(app) };
    })();
  }
  return servicesPromise;
}

function asDate(value) {
  if (value?.toDate) return value.toDate();
  if (value instanceof Date) return value;
  return null;
}

function stripePeriodStart(subscription) {
  const item = subscription.items?.data?.[0];
  const seconds = Number.isFinite(item?.current_period_start)
    ? item.current_period_start
    : subscription.current_period_start;
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

function addUtcMonth(date, anchorDay) {
  const next = new Date(date);
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(anchorDay, lastDay));
  return next;
}

function monthKey(date) {
  return date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== "Bearer " + secret) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  try {
    const { stripe, db, auth } = await getServices();
    const now = new Date();
    const query = db.collectionGroup("billing").where("interval", "==", "year");
    const pageSize = 200;
    let lastDoc = null;
    let scanned = 0;
    let granted = 0;
    let skipped = 0;
    let failed = 0;

    while (true) {
      let pageQuery = query.limit(pageSize);
      if (lastDoc) pageQuery = pageQuery.startAfter(lastDoc);
      const snapshot = await pageQuery.get();
      if (snapshot.empty) break;
      scanned += snapshot.size;
      lastDoc = snapshot.docs[snapshot.docs.length - 1];

      for (const doc of snapshot.docs) {
        if (!doc.ref.path.startsWith("billing_" + billingMode() + "_users/")) { skipped++; continue; }
        const data = doc.data();
        const dueAt = asDate(data.nextCreditGrantAt);
        const periodEnd = asDate(data.currentPeriodEnd);
        const currentPeriodStart = asDate(data.currentPeriodStart);
        const grantPeriodStart = asDate(data.annualCreditGrantPeriodStart);
        const subscriptionId = data.stripeSubscriptionId;
        const uid = doc.ref.parent.parent?.id;
        const planId = data.annualCreditGrantPlanId || data.planId;
        const credits = PLAN_CREDITS[planId];

        if (!data.active || !dueAt || dueAt > now || !periodEnd || dueAt >= periodEnd ||
            !currentPeriodStart || !grantPeriodStart ||
            currentPeriodStart.getTime() !== grantPeriodStart.getTime() ||
            !subscriptionId || !uid || !credits ||
            data.annualCreditGrantSubscriptionId !== subscriptionId) {
          skipped++;
          continue;
        }

        try {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          assertStripeObject(subscription);
          const livePeriodStart = stripePeriodStart(subscription);
          if (!["active", "trialing"].includes(subscription.status) ||
              !livePeriodStart || livePeriodStart.getTime() !== grantPeriodStart.getTime() ||
              (subscription.cancel_at_period_end && now >= periodEnd)) {
            // The grant schedule must belong to the currently paid annual
            // Stripe period, not merely match possibly stale Firestore dates.
            // This closes the gap when Stripe has renewed but invoice.paid is delayed.
            skipped++;
            continue;
          }

          const billingRef = doc.ref;
          const ledgerRef = db.collection("users").doc(uid).collection("creditLedger")
            .doc("annual_" + subscriptionId + "_" + monthKey(dueAt));
          let didGrant = false;

          await db.runTransaction(async tx => {
            didGrant = false;
            const [billingSnap, ledgerSnap] = await Promise.all([tx.get(billingRef), tx.get(ledgerRef)]);
            if (!billingSnap.exists || ledgerSnap.exists) return;
            const current = billingSnap.data();
            const currentDue = asDate(current.nextCreditGrantAt);
            const currentEnd = asDate(current.currentPeriodEnd);
            const currentPeriodStart = asDate(current.currentPeriodStart);
            const grantPeriodStart = asDate(current.annualCreditGrantPeriodStart);
            if (current.stripeSubscriptionId !== subscriptionId ||
                current.annualCreditGrantSubscriptionId !== subscriptionId ||
                !current.active || !currentDue || currentDue.getTime() !== dueAt.getTime() ||
                !currentPeriodStart || !grantPeriodStart ||
                currentPeriodStart.getTime() !== grantPeriodStart.getTime() ||
                livePeriodStart.getTime() !== grantPeriodStart.getTime() ||
                currentDue > new Date() || !currentEnd || currentDue >= currentEnd) return;

            const balance = Number(current.creditBalance ?? 0);
            if (!Number.isSafeInteger(balance)) throw new Error("Invalid Credits balance.");

            tx.create(ledgerRef, {
              type: "annual_subscription_monthly_grant",
              source: "scheduled_subscription_credit",
              stripeSubscriptionId: subscriptionId,
              planId,
              credits,
              grantMonth: monthKey(dueAt),
              createdAt: FieldValue.serverTimestamp()
            });
            tx.set(billingRef, {
              creditBalance: balance + credits,
              nextCreditGrantAt: addUtcMonth(currentDue, Number(current.annualCreditGrantAnchorDay) || currentDue.getUTCDate()),
              lastAnnualCreditGrantAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp()
            }, { merge: true });
            didGrant = true;
          });

          if (didGrant) granted++;
          else skipped++;
        } catch {
          failed++;
        }
      }
    }

    // Reuse this existing daily Cron so the Hobby plan function count stays unchanged.
    // Email failures must never roll back annual Credit grants.
    let retriedAlerts = 0;
    if (adminEmailConfigured()) {
      try {
        const pending = await db.collection("adminEmailAlerts").where("status", "==", "pending").limit(8).get();
        for (const alert of pending.docs) {
          try {
            const result = await deliverAdminAlert(db, alert.id);
            if (result.status === "sent") retriedAlerts++;
          } catch { console.warn("[kenji-admin-alert] Pending email retry failed."); }
        }
      } catch { console.warn("[kenji-admin-alert] Unable to read pending email alerts."); }
    }
    // Isolate optional marketing errors from essential annual Credits and admin alerts.
    // Disabled until the environment flag is explicitly enabled after safety checks.
    let marketing={enabled:false,sent:0};
    try { marketing=await runMarketingFollowups({db,auth}); }
    catch { console.warn("[kenji-marketing] Optional follow-up job skipped."); }
    return res.status(200).json({ ok: true, scanned, granted, skipped, failed, retriedAlerts, marketing });
  } catch {
    return res.status(500).json({ error: "Annual Credits grant job failed." });
  }
}
