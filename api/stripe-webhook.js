import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

export const config = { api: { bodyParser: false } };

const MAX_BODY_BYTES = 1024 * 1024;
let servicesPromise;

async function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === "string") return Buffer.from(req.rawBody);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Webhook payload too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function getServices() {
  if (!servicesPromise) {
    servicesPromise = (async () => {
      const stripeSecret = process.env.STRIPE_SECRET_KEY;
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (!stripeSecret || !webhookSecret || !projectId || !serviceAccountRaw) {
        throw new Error("Missing required server configuration.");
      }

      let serviceAccount;
      try {
        serviceAccount = JSON.parse(serviceAccountRaw);
      } catch {
        throw new Error("Firebase service account configuration is invalid.");
      }
      if (serviceAccount.project_id !== projectId) {
        throw new Error("Firebase project configuration does not match.");
      }

      const app = getApps()[0] || initializeApp({
        credential: cert(serviceAccount),
        projectId
      });
      return {
        stripe: new Stripe(stripeSecret),
        auth: getAuth(app),
        db: getFirestore(app)
      };
    })();
  }
  return servicesPromise;
}

function unixDate(seconds) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

function getFirebaseUid(object) {
  // Only accept server-controlled Stripe metadata. client_reference_id can be
  // supplied in a Payment Link URL and must never be trusted as an account ID.
  const candidate = object?.metadata?.firebaseUID || object?.metadata?.firebase_uid;
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= 128
    ? candidate
    : null;
}


function subscriptionData(subscription) {
  const item = subscription.items?.data?.[0];
  return {
    stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id || null,
    stripeSubscriptionId: subscription.id,
    status: subscription.status,
    priceId: item?.price?.id || null,
    currency: item?.price?.currency || null,
    interval: item?.price?.recurring?.interval || null,
    currentPeriodStart: unixDate(subscription.current_period_start),
    currentPeriodEnd: unixDate(subscription.current_period_end),
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    cancelAt: unixDate(subscription.cancel_at),
    updatedAt: FieldValue.serverTimestamp()
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  let services;
  try {
    services = await getServices();
  } catch {
    return res.status(503).json({ error: "Webhook service is not configured." });
  }

  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string") {
    return res.status(400).json({ error: "Missing Stripe signature." });
  }

  let event;
  try {
    const rawBody = await readRawBody(req);
    event = services.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch {
    return res.status(400).json({ error: "Invalid Stripe webhook signature or payload." });
  }

  const eventRef = services.db.collection("stripeWebhookEvents").doc(event.id);
  const processingToken = randomUUID();
  let alreadyProcessed = false;
  let claimed = false;
  try {
    await services.db.runTransaction(async transaction => {
      const existing = await transaction.get(eventRef);
      const current = existing.exists ? existing.data() : {};
      if (current.processed === true) {
        alreadyProcessed = true;
        return;
      }
      const leaseUntil = Number(current.processingLeaseUntilMs || 0);
      if (current.processingStatus === "processing" && leaseUntil > Date.now()) {
        return;
      }
      transaction.set(eventRef, {
        type: event.type,
        livemode: Boolean(event.livemode),
        processed: false,
        processingStatus: "processing",
        processingToken,
        processingLeaseUntilMs: Date.now() + 5 * 60 * 1000,
        attempts: FieldValue.increment(1),
        receivedAt: current.receivedAt || FieldValue.serverTimestamp()
      }, { merge: true });
      claimed = true;
    });
  } catch {
    return res.status(500).json({ error: "Could not claim Stripe event for processing." });
  }

  if (alreadyProcessed) {
    return res.status(200).json({ received: true, duplicate: true });
  }
  if (!claimed) {
    // Another invocation owns the active lease. A non-2xx response asks Stripe
    // to retry after the current processor finishes or its lease expires.
    return res.status(500).json({ error: "Stripe event is already being processed." });
  }

  try {
    const object = event.data.object;
    let uid = getFirebaseUid(object);
    let customer = null;
    const customerId = typeof object?.customer === "string" ? object.customer : object?.customer?.id;
    if (customerId) {
      try {
        customer = await services.stripe.customers.retrieve(customerId);
        if (customer?.deleted) customer = null;
      } catch {}
    }
    if (!uid) uid = getFirebaseUid(customer);

    // Payment Links may not carry Firebase UID metadata. In that case, match only
    // an exact, verified Firebase email from the Stripe customer/session.
    if (!uid) {
      const email = object?.customer_details?.email || object?.customer_email || customer?.email;
      if (typeof email === "string" && email.includes("@")) {
        try {
          const matchedUser = await services.auth.getUserByEmail(email);
          if (matchedUser.emailVerified) uid = matchedUser.uid;
        } catch {}
      }
    }

    if (uid) {
      // Verify that the UID belongs to a real Firebase account before granting billing state.
      const firebaseUser = await services.auth.getUser(uid);
      if (!firebaseUser.emailVerified) uid = null;
    }

    if (uid) {
      const billingRef = services.db.collection("users").doc(uid).collection("billing").doc("current");
      const common = {
        stripeCustomerId: typeof object?.customer === "string" ? object.customer : object?.customer?.id || null,
        lastStripeEventId: event.id,
        lastStripeEventType: event.type,
        updatedAt: FieldValue.serverTimestamp()
      };

      if (event.type === "checkout.session.completed") {
        await billingRef.set({
          ...common,
          checkoutSessionId: object.id,
          checkoutPaymentStatus: object.payment_status || null,
          checkoutMode: object.mode || null
        }, { merge: true });
      } else if (event.type.startsWith("customer.subscription.")) {
        const subscription = object;
        await billingRef.set({
          ...common,
          ...subscriptionData(subscription),
          active: ["active", "trialing"].includes(subscription.status)
        }, { merge: true });
      } else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
        await billingRef.set({
          ...common,
          latestInvoiceId: object.id,
          latestInvoiceStatus: event.type === "invoice.paid" ? "paid" : "payment_failed",
          latestInvoiceAmountPaid: object.amount_paid ?? null,
          latestInvoiceCurrency: object.currency || null
        }, { merge: true });
        if (event.type === "invoice.payment_failed") {
          await billingRef.set({ paymentIssue: true }, { merge: true });
        } else {
          await billingRef.set({ paymentIssue: false }, { merge: true });
        }
      }
    }

    await services.db.runTransaction(async transaction => {
      const current = await transaction.get(eventRef);
      if (current.data()?.processingToken !== processingToken) {
        throw new Error("Stripe event processing lease was lost.");
      }
      transaction.set(eventRef, {
        processed: true,
        processingStatus: "processed",
        processingToken: FieldValue.delete(),
        processingLeaseUntilMs: FieldValue.delete(),
        firebaseUid: uid || null,
        processedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    });

    return res.status(200).json({ received: true, linked: Boolean(uid) });
  } catch {
    // Return a failure so Stripe retries transient processing errors.
    return res.status(500).json({ error: "Stripe event processing failed." });
  }
}
