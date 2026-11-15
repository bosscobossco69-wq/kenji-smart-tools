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

function isMissingStripeResource(error) {
  return error?.statusCode === 404 || error?.raw?.statusCode === 404 ||
    error?.code === "resource_missing";
}

function getFirebaseUid(object) {
  // Only accept server-controlled Stripe metadata as an account identifier.
  // client_reference_id can be supplied through Payment Link URL parameters.
  const candidate = object?.metadata?.firebaseUID || object?.metadata?.firebase_uid;
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= 128
    ? candidate
    : null;
}


async function getOrderCreatedAtMs(db, orderId) {
  if (typeof orderId !== "string" || !orderId) return null;
  const orderSnap = await db.collection("billingOrders").doc(orderId).get();
  if (!orderSnap.exists) return null;
  const value = orderSnap.data()?.createdAt;
  const milliseconds = typeof value?.toMillis === "function"
    ? value.toMillis()
    : value instanceof Date
      ? value.getTime()
      : Number(value);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null;
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
    currentPeriodStart: unixDate(Number.isFinite(item?.current_period_start)
      ? item.current_period_start : subscription.current_period_start),
    currentPeriodEnd: unixDate(Number.isFinite(item?.current_period_end)
      ? item.current_period_end : subscription.current_period_end),
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
    let object = event.data.object;
    let uid = getFirebaseUid(object);
    let customer = null;
    const customerId = typeof object?.customer === "string" ? object.customer : object?.customer?.id;
    if (customerId) {
      try {
        customer = await services.stripe.customers.retrieve(customerId);
        if (customer?.deleted) customer = null;
      } catch (error) {
        if (!isMissingStripeResource(error)) throw error;
        customer = null;
      }
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
        } catch (error) {
          if (error?.code !== "auth/user-not-found") throw error;
        }
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

      if ([
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.async_payment_failed"
      ].includes(event.type)) {
        // Always reconcile against Stripe's current Checkout Session. Event
        // snapshots may be delivered out of order, including async success
        // before checkout.session.completed.
        object = await services.stripe.checkout.sessions.retrieve(object.id);
        const incomingPaymentStatus = event.type === "checkout.session.async_payment_succeeded"
          ? "paid"
          : event.type === "checkout.session.async_payment_failed"
            ? "failed"
            : object.payment_status || "unpaid";
        const orderId = object.metadata?.orderId || null;
        const orderCreatedAtMs = await getOrderCreatedAtMs(services.db, orderId);
        const paymentStatusRank = status => ({
          unpaid: 0,
          failed: 1,
          paid: 2,
          no_payment_required: 2
        }[status] ?? -1);
        await services.db.runTransaction(async transaction => {
          const current = await transaction.get(billingRef);
          const data = current.exists ? current.data() : {};
          const sameSession = data.checkoutSessionId === object.id;
          const currentSessionCreated = Number(data.checkoutSessionCreated || 0);
          const incomingSessionCreated = Number(object.created || 0);
          if (!sameSession && data.checkoutSessionId) {
            const currentOrderCreatedAtMs = Number(data.checkoutOrderCreatedAtMs || 0);
            if (orderCreatedAtMs && currentOrderCreatedAtMs) {
              if (orderCreatedAtMs < currentOrderCreatedAtMs) return;
              if (orderCreatedAtMs === currentOrderCreatedAtMs &&
                  data.checkoutOrderId !== orderId) {
                throw new Error("Cannot safely order distinct Checkout orders with identical creation time.");
              }
            } else if (incomingSessionCreated < currentSessionCreated) {
              return;
            } else if (incomingSessionCreated === currentSessionCreated) {
              throw new Error("Cannot safely order Checkout sessions created in the same second without order timestamps.");
            }
          }
          if (sameSession && event.created < Number(data.checkoutEventCreated || 0)) return;
          const previousPaymentStatus = sameSession ? data.checkoutPaymentStatus : null;
          const checkoutPaymentStatus =
            paymentStatusRank(previousPaymentStatus) > paymentStatusRank(incomingPaymentStatus)
              ? previousPaymentStatus
              : incomingPaymentStatus;
          transaction.set(billingRef, {
            ...common,
            checkoutSessionId: object.id,
            checkoutPaymentStatus,
            checkoutMode: object.mode || null,
            checkoutSessionCreated: incomingSessionCreated,
            checkoutOrderId: orderId,
            ...(orderCreatedAtMs ? { checkoutOrderCreatedAtMs: orderCreatedAtMs } : {}),
            checkoutEventCreated: sameSession
              ? Math.max(Number(data.checkoutEventCreated || 0), Number(event.created || 0))
              : Number(event.created || 0),
            checkoutPaymentUpdatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
        });
      } else if (event.type.startsWith("customer.subscription.")) {
        const subscription = object;
        const incomingCreated = Number(subscription.created || 0);
        const incomingOrderId = subscription.metadata?.orderId || null;
        const incomingOrderAt = await getOrderCreatedAtMs(services.db, incomingOrderId);
        const existingBilling = await billingRef.get();
        const existingData = existingBilling.exists ? existingBilling.data() : {};
        const existingSubscriptionId = existingData.stripeSubscriptionId || null;
        let existingSubscriptionCreated = Number(existingData.stripeSubscriptionCreated || 0);
        let existingOrderId = existingData.stripeSubscriptionOrderId || null;
        let existingOrderAt = Number(existingData.stripeSubscriptionOrderCreatedAtMs || 0);
        let existingSubscriptionMissing = false;
        if (existingSubscriptionId && existingSubscriptionId !== subscription.id &&
            (!existingSubscriptionCreated || existingSubscriptionCreated === incomingCreated ||
              (incomingCreated && existingSubscriptionCreated === incomingCreated))) {
          try {
            const existingSubscription = await services.stripe.subscriptions.retrieve(existingSubscriptionId);
            existingSubscriptionCreated = Number(existingSubscription.created || existingSubscriptionCreated || 0);
            existingOrderId = existingOrderId || existingSubscription.metadata?.orderId || null;
            existingOrderAt = existingOrderAt || Number(await getOrderCreatedAtMs(services.db, existingOrderId) || 0);
          } catch (error) {
            if (isMissingStripeResource(error)) {
              existingSubscriptionMissing = true;
            } else {
              throw error;
            }
          }
        }
        const sequenceRef = services.db.collection("stripeSnapshotSequences").doc(subscription.id);
        const snapshotSequence = await services.db.runTransaction(async transaction => {
          const current = await transaction.get(sequenceRef);
          const next = Number(current.data()?.value || 0) + 1;
          transaction.set(sequenceRef, { value: next, updatedAt: FieldValue.serverTimestamp() });
          return next;
        });
        let subscriptionSnapshot = subscription;
        try {
          // Always reconcile against current Stripe state, not the event snapshot.
          subscriptionSnapshot = await services.stripe.subscriptions.retrieve(subscription.id);
        } catch (error) {
          if (!(event.type === "customer.subscription.deleted" && isMissingStripeResource(error))) {
            throw error;
          }
          subscriptionSnapshot = { ...subscription, status: "canceled" };
        }
        await services.db.runTransaction(async transaction => {
          const current = await transaction.get(billingRef);
          const data = current.exists ? current.data() : {};
          const sequences = data.subscriptionSnapshotSequences || {};
          const previousSequence = Number(sequences[subscriptionSnapshot.id] || 0);
          if (snapshotSequence < previousSequence) return;
          const currentId = data.stripeSubscriptionId || null;
          const incomingCreated = Number(subscriptionSnapshot.created || 0);
          const transactionCurrentCreated = Number(data.stripeSubscriptionCreated || 0) ||
            (currentId === existingSubscriptionId ? existingSubscriptionCreated : 0);
          const transactionCurrentOrderId = data.stripeSubscriptionOrderId ||
            (currentId === existingSubscriptionId ? existingOrderId : null);
          const transactionCurrentOrderAt = Number(data.stripeSubscriptionOrderCreatedAtMs || 0) ||
            (currentId === existingSubscriptionId ? existingOrderAt : 0);
          if (currentId && currentId !== subscriptionSnapshot.id) {
            if (!incomingCreated) throw new Error("Incoming subscription creation timestamp is missing.");
            if (existingSubscriptionMissing && currentId === existingSubscriptionId) {
              // Stripe confirmed the previously stored subscription no longer exists.
            } else {
              if (!transactionCurrentCreated) throw new Error("Cannot safely order subscription replacement.");
              if (incomingCreated < transactionCurrentCreated) return;
              if (incomingCreated === transactionCurrentCreated) {
                if (!incomingOrderAt || !transactionCurrentOrderAt) {
                  throw new Error("Cannot safely order subscriptions created in the same second.");
                }
                if (incomingOrderAt < transactionCurrentOrderAt) return;
                if (incomingOrderAt === transactionCurrentOrderAt && incomingOrderId !== transactionCurrentOrderId) {
                  throw new Error("Subscription replacement order timestamps are ambiguous.");
                }
              }
            }
          }
          transaction.set(billingRef, {
            ...common,
            ...subscriptionData(subscriptionSnapshot),
            active: ["active", "trialing"].includes(subscriptionSnapshot.status),
            stripeSubscriptionId: subscriptionSnapshot.id,
            stripeSubscriptionCreated: incomingCreated,
            stripeSubscriptionOrderId: incomingOrderId,
            ...(incomingOrderAt ? { stripeSubscriptionOrderCreatedAtMs: incomingOrderAt } : {}),
            subscriptionSnapshotSequences: {
              ...sequences,
              [subscriptionSnapshot.id]: snapshotSequence
            }
          }, { merge: true });
        });
      } else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
        // Allocate before Stripe retrieval so a slower earlier request cannot win.
        const subscriptionId = typeof object.subscription === "string"
          ? object.subscription
          : object.subscription?.id || object.parent?.subscription_details?.subscription || null;
        if (!subscriptionId) throw new Error("Invoice event is missing a subscription reference.");
        const sequenceRef = services.db.collection("stripeSnapshotSequences").doc(subscriptionId);
        const snapshotSequence = await services.db.runTransaction(async transaction => {
          const current = await transaction.get(sequenceRef);
          const next = Number(current.data()?.value || 0) + 1;
          transaction.set(sequenceRef, { value: next, updatedAt: FieldValue.serverTimestamp() });
          return next;
        });
        const subscription = await services.stripe.subscriptions.retrieve(subscriptionId);
        const latestInvoiceId = typeof subscription.latest_invoice === "string"
          ? subscription.latest_invoice
          : subscription.latest_invoice?.id || null;
        if (!latestInvoiceId) throw new Error("Subscription has no latest invoice to reconcile.");
        const latestInvoice = await services.stripe.invoices.retrieve(latestInvoiceId);
        await services.db.runTransaction(async transaction => {
          const current = await transaction.get(billingRef);
          const data = current.exists ? current.data() : {};
          const sequences = data.invoiceSnapshotSequences || {};
          const previousSequence = Number(sequences[subscriptionId] || 0);
          if (snapshotSequence < previousSequence) return;
          if (data.stripeSubscriptionId && data.stripeSubscriptionId !== subscriptionId) {
            const currentCreated = Number(data.stripeSubscriptionCreated || 0);
            if (!currentCreated || Number(subscription.created || 0) > currentCreated) {
              throw new Error("Invoice belongs to a subscription not yet linked to the billing record.");
            }
            return;
          }
          transaction.set(billingRef, {
            ...common,
            latestInvoiceId: latestInvoice.id,
            latestInvoiceStatus: latestInvoice.status || "open",
            latestInvoiceAmountPaid: latestInvoice.amount_paid ?? null,
            latestInvoiceCurrency: latestInvoice.currency || null,
            paymentIssue: latestInvoice.status === "uncollectible" ||
              (latestInvoice.status === "open" && Boolean(latestInvoice.attempted) &&
                Number(latestInvoice.attempt_count || 0) > 0),
            invoiceSnapshotSequences: {
              ...sequences,
              [subscriptionId]: snapshotSequence
            }
          }, { merge: true });
        });
      }
    }

    if (!uid && (
      event.type.startsWith("checkout.session.") ||
      event.type.startsWith("customer.subscription.") ||
      event.type === "invoice.paid" ||
      event.type === "invoice.payment_failed"
    )) {
      throw new Error("Stripe billing event is not linked to a verified Firebase account yet.");
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
