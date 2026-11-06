import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Firebase server credentials are not configured.");
  let account;
  try {
    account = JSON.parse(raw);
  } catch {
    throw new Error("Firebase server credentials are invalid JSON.");
  }
  if (!account.project_id || !account.client_email || !account.private_key) {
    throw new Error("Firebase server credentials are incomplete.");
  }
  return account;
}

export function getFirebaseAdmin() {
  let app = getApps()[0];
  if (!app) {
    app = initializeApp({
      credential: cert(getServiceAccount()),
      projectId: process.env.FIREBASE_PROJECT_ID || "kenji-ai-workspace"
    });
  }
  return {
    auth: getAuth(app),
    db: getFirestore(app),
    Timestamp
  };
}

export async function requireVerifiedUser(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const error = new Error("Sign in is required.");
    error.statusCode = 401;
    throw error;
  }
  const { auth } = getFirebaseAdmin();
  let decoded;
  try {
    decoded = await auth.verifyIdToken(match[1], true);
  } catch {
    const error = new Error("Your session is invalid or expired. Please sign in again.");
    error.statusCode = 401;
    throw error;
  }
  const user = await auth.getUser(decoded.uid);
  if (!user.emailVerified) {
    const error = new Error("Please verify your email before starting the free trial.");
    error.statusCode = 403;
    throw error;
  }
  return user;
}
