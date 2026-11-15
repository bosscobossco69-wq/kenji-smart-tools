import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

export const config = { api: { bodyParser: false } };

const MAX_BODY_BYTES = 1024 * 1024;

const PLAN_CREDITS = { lite: 10000, pro: 30000, pro_plus: 100000, ultra: 400000 };
const CREDIT_PACKS = {
  mini: { amount: 500, credits: 10000 }, basic: { amount: 2000, credits: 50000 },
  pro: { amount: 3500, credits: 100000 }, business: { amount: 15000, credits: 500000 }
};
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

function addUtcMonth(date) {
  const next = new Date(date);
  const anchorDay = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(anchorDay, lastDay));
  return next;
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
    planId: subscription.metadata?.planId || null,
    orderId: subscription.metadata?.orderId || null,
    status: subscription.status,
    priceId: item?.price?.id || null,
    currency: item?.price?.currency || null,
    interval: item?.price?.recurring?.interval || null,
    currentPeriodStart: unixDate(Number.isFinite(item?.current_period_start) ? item.current_period_start : subscription.current_period_start),
    currentPeriodEnd: unixDate(Number.isFinite(item?.current_period_end) ? item.current_period_end : subscription.current_period_end),
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    cancelAt: unixDate(subscription.cancel_at),
    updatedAt: FieldValue.serverTimestamp()
  };
}

async function fulfillCreditPack({ db, session, uid, event }) {
  const meta = session.metadata || {};
  const orderId = typeof meta.orderId === "string" ? meta.orderId : "";
  const pack = CREDIT_PACKS[meta.packId];
  if (!orderId || !pack) throw new Error("Invalid credit pack metadata.");
  if (session.payment_status !== "paid") return;
  if (!uid || meta.firebaseUID !== uid) throw new Error("Credit pack payment has no verified Firebase user.");
  if (session.mode !== "payment" || session.currency !== "usd" || session.amount_total !== pack.amount) {
    throw new Error("Credit pack payment mismatch.");
  }

  const orderRef = db.collection("billingOrders").doc(orderId);
  const billingRef = db.collection("users").doc(uid).collection("billing").doc("current");
  const ledgerRef = db.collection("users").doc(uid).collection("creditLedger").doc("stripe_pack_" + orderId);

  await db.runTransaction(async tx => {
    const [orderSnap, ledgerSnap] = await Promise.all([tx.get(orderRef), tx.get(ledgerRef)]);
    if (!orderSnap.exists) throw new Error("Credit order not found.");
    const order = orderSnap.data();
    if (order.uid !== uid || order.type !== "credit_pack" || order.packId !== meta.packId ||
        order.credits !== pack.credits || order.amount !== pack.amount ||
        order.stripeCheckoutSessionId !== session.id) {
      throw new Error("Credit order does not match payment.");
    }
    if (ledgerSnap.exists || order.status === "paid") return;

    tx.set(billingRef, {
      creditBalance: FieldValue.increment(pack.credits),
      lastCreditOrderId: orderId,
      lastStripeEventId: event.id,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    tx.create(ledgerRef, {
      type: "credit_pack_purchase",
      source: "stripe_checkout",
      orderId,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
      stripeEventId: event.id,
      credits: pack.credits,
      amount: pack.amount,
      currency: "usd",
      createdAt: FieldValue.serverTimestamp()
    });
    tx.set(orderRef, {
      status: "paid",
      stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
      stripeEventId: event.id,
      paidAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });
}

async function grantSubscriptionInvoice({ db, invoice, subscription, uid }) {
  if (!uid || !subscription) throw new Error("Paid subscription invoice is not linked to a verified user.");
  if (!["subscription_create", "subscription_cycle"].includes(invoice.billing_reason)) return;

  const metadata = subscription.metadata || {};
  const orderId = metadata.orderId;
  const planId = metadata.planId;
  const credits = PLAN_CREDITS[planId];
  const item = subscription.items?.data?.[0];
  const interval = item?.price?.recurring?.interval;
  const invoicePriceIds = (invoice.lines?.data || []).map(line =>
    line.price?.id || line.pricing?.price_details?.price
  ).filter(Boolean);

  if (!orderId || !credits || !["month", "year"].includes(interval) ||
      !item?.price?.id || !invoicePriceIds.includes(item.price.id)) {
    throw new Error("Paid invoice does not match a supported subscription plan.");
  }

  const orderRef = db.collection("billingOrders").doc(orderId);
  const billingRef = db.collection("users").doc(uid).collection("billing").doc("current");
  const ledgerRef = db.collection("users").doc(uid).collection("creditLedger").doc("stripe_invoice_" + invoice.id);

  await db.runTransaction(async tx => {
    const [orderSnap, ledgerSnap] = await Promise.all([tx.get(orderRef), tx.get(ledgerRef)]);
    if (!orderSnap.exists) throw new Error("Checkout order was not found for paid invoice.");
    const order = orderSnap.data();
    const expectedInterval = interval === "year" ? "yearly" : "monthly";
    if (order.uid !== uid || order.planId !== planId || order.interval !== expectedInterval ||
        order.priceId !== item.price.id || order.currency !== "usd") {
      throw new Error("Paid invoice does not match its pending Checkout order.");
    }
    if (ledgerSnap.exists) return;

    tx.set(billingRef, {
      creditBalance: FieldValue.increment(credits),
      lastCreditGrantInvoiceId: invoice.id,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    tx.create(ledgerRef, {
      type: interval === "year" ? "annual_subscription_initial_grant" : "subscription_cycle_grant",
      source: "stripe_invoice",
      stripeInvoiceId: invoice.id,
      stripeSubscriptionId: subscription.id,
      orderId,
      planId,
      credits,
      currency: invoice.currency || null,
      amountPaid: invoice.amount_paid ?? null,
      createdAt: FieldValue.serverTimestamp()
    });
    if (interval === "year") {
      // Stripe API versions using the Basil model expose billing periods on subscription items.
      // Keep the subscription-level fallback for older API responses.
      const periodStartSeconds = Number.isFinite(item?.current_period_start)
        ? item.current_period_start
        : subscription.current_period_start;
      const periodStart = unixDate(periodStartSeconds);
      if (!periodStart) throw new Error("Annual subscription period start is missing.");
      tx.set(billingRef, {
        nextCreditGrantAt: addUtcMonth(periodStart),
        annualCreditGrantSubscriptionId: subscription.id,
        annualCreditGrantPlanId: planId,
        annualCreditGrantAnchorDay: periodStart.getUTCDate()
      }, { merge: true });
    }
    tx.set(orderRef, {
      status: "paid",
      lastPaidInvoiceId: invoice.id,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });
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
      // Firestore may rerun this callback after a transaction conflict.
      // Reset closure flags on every attempt so stale values cannot leak.
      alreadyProcessed = false;
      claimed = false;
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
    let object = event.data.object;
    let snapshotSequence = null;
    let latestInvoiceSnapshot = null;
    let invoiceSubscription = null;
    const isInvoiceEvent = event.type === "invoice.paid" || event.type === "invoice.payment_failed";
    let snapshotSubscriptionId = event.type.startsWith("customer.subscription.")
      ? object.id
      : (typeof object.subscription === "string"
        ? object.subscription
        : object.subscription?.id || object.parent?.subscription_details?.subscription || null);

    // Use a Firestore-issued monotonic sequence instead of Date.now(): two
    // concurrent handlers can start in the same millisecond. The sequence is
    // allocated before Stripe retrieval, so slower earlier responses cannot win.
    const allocateSnapshotSequence = async subscriptionId => {
      if (!subscriptionId) return null;
      const sequenceRef = services.db.collection("stripeSnapshotSequences").doc(subscriptionId);
      return services.db.runTransaction(async transaction => {
        const current = await transaction.get(sequenceRef);
        const next = Number(current.data()?.value || 0) + 1;
        transaction.set(sequenceRef, { value: next, updatedAt: FieldValue.serverTimestamp() });
        return next;
      });
    };

    if (snapshotSubscriptionId) {
      snapshotSequence = await allocateSnapshotSequence(snapshotSubscriptionId);
    }

    if (event.type.startsWith("customer.subscription.")) {
      object = await services.stripe.subscriptions.retrieve(object.id);
    } else if (isInvoiceEvent) {
      object = await services.stripe.invoices.retrieve(object.id);
      snapshotSubscriptionId = typeof object.subscription === "string"
        ? object.subscription
        : object.subscription?.id || object.parent?.subscription_details?.subscription || snapshotSubscriptionId;
      if (snapshotSubscriptionId && snapshotSequence === null) {
        snapshotSequence = await allocateSnapshotSequence(snapshotSubscriptionId);
      }
      if (snapshotSubscriptionId) {
        invoiceSubscription = await services.stripe.subscriptions.retrieve(snapshotSubscriptionId);
        const latestInvoiceId = typeof invoiceSubscription.latest_invoice === "string"
          ? invoiceSubscription.latest_invoice
          : invoiceSubscription.latest_invoice?.id || null;
        if (latestInvoiceId) {
          latestInvoiceSnapshot = await services.stripe.invoices.retrieve(latestInvoiceId);
        }
      }
    }
    let uid = getFirebaseUid(object) || getFirebaseUid(invoiceSubscription);
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

    const isPackCheckout = [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded"
    ].includes(event.type) && object?.metadata?.purchaseType === "credit_pack";
    if (isPackCheckout) {
      await fulfillCreditPack({ db: services.db, session: object, uid, event });
    } else if (event.type === "invoice.paid" && invoiceSubscription) {
      await grantSubscriptionInvoice({ db: services.db, invoice: object, subscription: invoiceSubscription, uid });
    }

    if (uid) {
      const billingRef = services.db.collection("users").doc(uid).collection("billing").doc("current");
      const common = {
        stripeCustomerId: typeof object?.customer === "string" ? object.customer : object?.customer?.id || null,
        lastStripeEventId: event.id,
        lastStripeEventType: event.type,
        updatedAt: FieldValue.serverTimestamp()
      };

      if (event.type === "checkout.session.completed" ||
          event.type === "checkout.session.async_payment_succeeded") {
        await services.db.runTransaction(async transaction => {
          const current = await transaction.get(billingRef);
          const data = current.exists ? current.data() : {};
          const lastCreated = Number(data.checkoutEventCreated || 0);
          if (event.created < lastCreated) return;
          transaction.set(billingRef, {
            ...common,
            checkoutSessionId: object.id,
            checkoutPaymentStatus: object.payment_status || null,
            checkoutMode: object.mode || null,
            checkoutEventCreated: event.created
          }, { merge: true });
        });
      } else if (event.type.startsWith("customer.subscription.")) {
        const subscription = object;
        // Backfill the creation timestamp for billing records written before
        // this watermark was introduced. Fetch outside the transaction so no
        // Stripe network request runs inside a Firestore transaction callback.
        const existingBilling = await billingRef.get();
        const existingBillingData = existingBilling.exists ? existingBilling.data() : {};
        const existingSubscriptionId = existingBillingData.stripeSubscriptionId || null;
        let existingSubscriptionCreated = Number(existingBillingData.stripeSubscriptionCreated || 0);
        let existingSubscriptionMissing = false;
        if (existingSubscriptionId && !existingSubscriptionCreated) {
          try {
            const existingSubscription = await services.stripe.subscriptions.retrieve(existingSubscriptionId);
            existingSubscriptionCreated = Number(existingSubscription.created || 0);
            if (!existingSubscriptionCreated) {
              throw new Error("Existing subscription response has no creation timestamp.");
            }
          } catch (error) {
            const isNotFound = error?.statusCode === 404 ||
              error?.raw?.statusCode === 404 ||
              error?.code === "resource_missing";
            if (isNotFound) {
              // Terminal recovery: Stripe confirms the stored subscription no
              // longer exists. The incoming, signature-verified subscription
              // event may replace this stale pointer if the billing record has
              // not changed since the preflight read.
              existingSubscriptionMissing = true;
            } else {
              // Rate limits, network errors, authentication/configuration
              // failures and unknown errors remain retryable/non-acknowledged.
              throw error;
            }
          }
        }
        await services.db.runTransaction(async transaction => {
          const current = await transaction.get(billingRef);
          const data = current.exists ? current.data() : {};
          const subscriptionId = subscription.id;
          const sequences = data.subscriptionSnapshotSequences || {};
          const previousSequence = Number(sequences[subscriptionId] || 0);
          if (snapshotSequence === null || snapshotSequence < previousSequence) return;

          // Keep the shared billing document pointed at the newest subscription.
          // Per-subscription sequence watermarks prevent a replacement subscription
          // starting at sequence 1 from being blocked by its predecessor's counter.
          const incomingCreated = Number(subscription.created || 0);
          const currentSubscriptionId = data.stripeSubscriptionId || null;
          let currentCreated = Number(data.stripeSubscriptionCreated || 0);
          if (currentSubscriptionId && currentSubscriptionId !== subscriptionId && !currentCreated) {
            // Only apply the pre-fetched watermark if the billing record still
            // points to the same subscription that was fetched above.
            if (currentSubscriptionId !== existingSubscriptionId || !existingSubscriptionCreated) return;
            currentCreated = existingSubscriptionCreated;
          }
          if (currentSubscriptionId && currentSubscriptionId !== subscriptionId) {
            if (currentSubscriptionId !== existingSubscriptionId) return;
            if (existingSubscriptionMissing) {
              if (!incomingCreated) return;
            } else {
              if (!incomingCreated || !currentCreated) return;
              if (incomingCreated < currentCreated) return;
              if (incomingCreated === currentCreated && subscriptionId < currentSubscriptionId) return;
            }
          }

          transaction.set(billingRef, {
            ...common,
            ...subscriptionData(subscription),
            active: ["active", "trialing"].includes(subscription.status),
            stripeSubscriptionId: subscriptionId,
            stripeSubscriptionCreated: incomingCreated,
            subscriptionSnapshotSequences: {
              ...sequences,
              [subscriptionId]: snapshotSequence
            }
          }, { merge: true });
        });
      } else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
        // Only the subscription's current latest invoice may update the
        // displayed payment state; an older invoice event cannot replace it.
        if (latestInvoiceSnapshot) {
          const invoiceStatus = latestInvoiceSnapshot.status || "open";
          await services.db.runTransaction(async transaction => {
            const current = await transaction.get(billingRef);
            const data = current.exists ? current.data() : {};
            const invoiceSequences = data.invoiceSnapshotSequences || {};
            const previousInvoiceSequence = Number(invoiceSequences[snapshotSubscriptionId] || 0);
            // An invoice from a superseded subscription must not replace the
            // payment status shown for the current subscription.
            if (!snapshotSubscriptionId ||
                data.stripeSubscriptionId !== snapshotSubscriptionId ||
                snapshotSequence === null ||
                snapshotSequence < previousInvoiceSequence) return;
            transaction.set(billingRef, {
              ...common,
              latestInvoiceId: latestInvoiceSnapshot.id,
              latestInvoiceStatus: invoiceStatus,
              latestInvoiceAmountPaid: latestInvoiceSnapshot.amount_paid ?? null,
              latestInvoiceCurrency: latestInvoiceSnapshot.currency || null,
              paymentIssue: invoiceStatus === "uncollectible" ||
                (invoiceStatus === "open" && Boolean(latestInvoiceSnapshot.attempted) &&
                  Number(latestInvoiceSnapshot.attempt_count || 0) > 0),
              invoiceSnapshotSequences: {
                ...invoiceSequences,
                [snapshotSubscriptionId]: snapshotSequence
              }
            }, { merge: true });
          });
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
