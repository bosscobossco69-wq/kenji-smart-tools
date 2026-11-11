import Stripe from "stripe";
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
  const metadataUid = object?.metadata?.firebaseUID || object?.metadata?.firebase_uid;
  const clientReference = object?.client_reference_id;
  const candidate = metadataUid || clientReference;
  return typeof candidate === "string" && candidate.length <= 128 ? candidate : null;
}

async function resolveUid(stripe, object) {
  const direct = getFirebaseUid(object);
  if (direct) {
    try {
      await getServicesAuth().verifyIdToken; // Keep the resolution path independent of client input.
    } catch {}
    return direct;
  }
  const customerId = typeof object?.customer === "string"
    ? object.customer
    : object?.customer?.id;
  if (!customerId) return null;
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer && !customer.deleted) return getFirebaseUid(customer);
  } catch {}
  return null;
}

let cachedAuth;
function getServicesAuth() {
  return cachedAuth;
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
    cachedAuth = services.auth;
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
  try {
    await services.db.runTransaction(async transaction => {
      const existing = await transaction.get(eventRef);
      if (existing.exists) return;
      transaction.create(eventRef, {
        type: event.type,
        livemode: Boolean(event.livemode),
        processed: false,
        receivedAt: FieldValue.serverTimestamp()
      });
    });
  } catch {
    return res.status(500).json({ error: "Could not record Stripe event." });
  }

  const eventRecord = await eventRef.get();
  if (eventRecord.data()?.processed === true) {
    return res.status(200).json({ received: true, duplicate: true });
  }

  try {
    const object = event.data.object;
    let uid = getFirebaseUid(object);
    if (!uid) {
      const customerId = typeof object?.customer === "string" ? object.customer : object?.customer?.id;
      if (customerId) {
        try {
          const customer = await services.stripe.customers.retrieve(customerId);
          if (customer && !customer.deleted) uid = getFirebaseUid(customer);
        } catch {}
      }
    }

    if (uid) {
      // Verify that the UID belongs to a real Firebase account before granting billing state.
      await services.auth.getUser(uid);
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

    await eventRef.set({
      processed: true,
      firebaseUid: uid || null,
      processedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    return res.status(200).json({ received: true, linked: Boolean(uid) });
  } catch {
    // Return a failure so Stripe retries transient processing errors.
    return res.status(500).json({ error: "Stripe event processing failed." });
  }
}
