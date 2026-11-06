import { getFirebaseAdmin, requireVerifiedUser } from "./_lib/firebase-admin.js";

const TRIAL_MS = 3 * 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return res.status(403).json({ error: "A same-origin request is required." });
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.host.toLowerCase() !== String(host).toLowerCase()) {
      return res.status(403).json({ error: "Request origin is not allowed." });
    }
  } catch {
    return res.status(403).json({ error: "Invalid request origin." });
  }

  try {
    const user = await requireVerifiedUser(req);
    const { db, Timestamp } = getFirebaseAdmin();
    const ref = db.collection("users").doc(user.uid);
    const now = Date.now();

    const result = await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (snapshot.exists) {
        const data = snapshot.data() || {};
        if (data.trialStartedAt && data.trialEndsAt) {
          const started = data.trialStartedAt.toMillis();
          const ends = data.trialEndsAt.toMillis();
          const status = data.subscriptionStatus === "active"
            ? "subscribed"
            : (now < ends ? "active" : "expired");
          if (data.trialStatus !== status && status !== "subscribed") {
            transaction.update(ref, { trialStatus: status });
          }
          return { trialStartedAt: started, trialEndsAt: ends, status };
        }
        // Existing account records without trial timestamps are initialized once.
      }

      const startedAt = Timestamp.fromMillis(now);
      const endsAt = Timestamp.fromMillis(now + TRIAL_MS);
      transaction.set(ref, {
        email: user.email || null,
        displayName: user.displayName || null,
        createdAt: snapshot.exists && snapshot.data()?.createdAt
          ? snapshot.data().createdAt
          : startedAt,
        emailVerifiedAt: startedAt,
        trialStartedAt: startedAt,
        trialEndsAt: endsAt,
        trialStatus: "active",
        subscriptionStatus: snapshot.exists ? (snapshot.data()?.subscriptionStatus || "none") : "none",
        planId: snapshot.exists ? (snapshot.data()?.planId || null) : null,
        entitlementUpdatedAt: startedAt
      }, { merge: true });
      return { trialStartedAt: now, trialEndsAt: now + TRIAL_MS, status: "active" };
    });

    return res.status(200).json({
      trial: result,
      message: "Trial status retrieved. This endpoint does not process payments."
    });
  } catch (error) {
    const status = Number(error.statusCode) || 503;
    return res.status(status).json({
      error: status === 503
        ? "Trial service is not configured yet. Please try again later."
        : error.message
    });
  }
}
