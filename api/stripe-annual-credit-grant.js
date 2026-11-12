import Stripe from "stripe";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const PLAN_CREDITS = { lite: 10000, pro: 30000, pro_plus: 100000, ultra: 400000 };
let servicesPromise;

function getServices() {
  if (!servicesPromise) {
    servicesPromise = (async () => {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const rawAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (!stripeKey || !projectId || !rawAccount) throw new Error("Billing service is not configured.");
      let account;
      try { account = JSON.parse(rawAccount); } catch { throw new Error("Firebase service account is invalid."); }
      if (account.project_id !== projectId) throw new Error("Firebase project mismatch.");
      const app = getApps()[0] || initializeApp({ credential: cert(account), projectId });
      return { stripe: new Stripe(stripeKey), db: getFirestore(app) };
    })();
  }
  return servicesPromise;
}

function asDate(value) {
  if (value?.toDate) return value.toDate();
  if (value instanceof Date) return value;
  return null;
}

function addUtcMonth(date) {
  const next = new Date(date);
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const secret = process.env.CRON_SECRET;
  const authorization = req.headers.authorization;
  if (!secret || authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  try {
    const { stripe, db } = await getServices();
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
      const data = doc.data();
      const dueAt = asDate(data.nextCreditGrantAt);
      const periodEnd = asDate(data.currentPeriodEnd);
      const subscriptionId = data.stripeSubscriptionId;
      const uid = doc.ref.parent.parent?.id;
      const planId = data.annualCreditGrantPlanId || data.planId;
      const credits = PLAN_CREDITS[planId];

      if (!data.active || !dueAt || dueAt > now || !periodEnd || dueAt >= periodEnd ||
          !subscriptionId || !uid || !credits || data.annualCreditGrantSubscriptionId !== subscriptionId) {
        skipped++;
        continue;
      }

      try {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        if (!["active", "trialing"].includes(subscription.status) ||
            subscription.cancel_at_period_end && now >= periodEnd) {
          skipped++;
          continue;
        }

        const ledgerRef = db.collection("users").doc(uid).collection("creditLedger")
          .doc(`annual_${subscriptionId}_${monthKey(dueAt)}`);
        const userRef = db.collection("users").doc(uid);
        let didGrant = false;

        await db.runTransaction(async transaction => {
          didGrant = false;
          const [billingSnap, ledgerSnap, userSnap] = await Promise.all([
            transaction.get(doc.ref), transaction.get(ledgerRef), transaction.get(userRef)
          ]);
          if (!billingSnap.exists || ledgerSnap.exists) return;
          const current = billingSnap.data();
          const currentDue = asDate(current.nextCreditGrantAt);
          const currentEnd = asDate(current.currentPeriodEnd);
          if (current.stripeSubscriptionId !== subscriptionId ||
              current.annualCreditGrantSubscriptionId !== subscriptionId ||
              !current.active || !currentDue || currentDue.getTime() !== dueAt.getTime() ||
              currentDue > new Date() || !currentEnd || currentDue >= currentEnd) return;

          const balance = Number(userSnap.exists ? userSnap.data()?.creditsBalance || 0 : 0);
          if (!Number.isSafeInteger(balance) || balance < 0) throw new Error("Invalid Credits balance.");

          transaction.create(ledgerRef, {
            type: "annual_subscription_monthly_grant",
            source: "scheduled_subscription_credit",
            stripeSubscriptionId: subscriptionId,
            planId,
            credits,
            grantMonth: monthKey(dueAt),
            createdAt: FieldValue.serverTimestamp()
          });
          transaction.set(userRef, {
            creditsBalance: balance + credits,
            creditsUpdatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
          transaction.set(doc.ref, {
            nextCreditGrantAt: addUtcMonth(currentDue),
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

    return res.status(200).json({ ok: true, scanned, granted, skipped, failed });
  } catch {
    return res.status(500).json({ error: "Annual Credits grant job failed." });
  }
}
