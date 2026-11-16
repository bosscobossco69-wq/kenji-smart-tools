#!/usr/bin/env node
// Read-only release preflight. Checks presence/shape only; never prints secrets or contacts Stripe.
import { readFileSync } from "node:fs";

const mode = process.env.VERCEL_ENV === "production" ? "live" : "test";
const requiredPrices = [
  "STRIPE_PRICE_LITE_MONTHLY", "STRIPE_PRICE_LITE_YEARLY",
  "STRIPE_PRICE_PRO_MONTHLY", "STRIPE_PRICE_PRO_YEARLY",
  "STRIPE_PRICE_PRO_PLUS_MONTHLY", "STRIPE_PRICE_PRO_PLUS_YEARLY",
  "STRIPE_PRICE_ULTRA_MONTHLY", "STRIPE_PRICE_ULTRA_YEARLY"
];
const results = [];
function check(name, ok, detail) {
  results.push({ name, status: ok ? "pass" : "fail", ...(detail ? { detail } : {}) });
}
const key = process.env.STRIPE_SECRET_KEY || "";
check("Stripe key matches deployment", key.startsWith(mode === "live" ? "sk_live_" : "sk_test_"));
check("Stripe webhook signing secret is present", (process.env.STRIPE_WEBHOOK_SECRET || "").startsWith("whsec_"));
check("Firebase project ID configured", Boolean(process.env.FIREBASE_PROJECT_ID));
let account;
try { account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || ""); } catch { account = null; }
check("Firebase Admin project matches", Boolean(account?.project_id && account.project_id === process.env.FIREBASE_PROJECT_ID));
check("Firebase Admin service account", account?.type === "service_account" &&
  Boolean(account?.client_email && account?.private_key));
try {
  const url = new URL(process.env.SITE_URL || "");
  check("HTTPS SITE_URL origin", url.protocol === "https:" && !url.username &&
    !url.password && !url.search && !url.hash && url.pathname === "/");
} catch { check("HTTPS SITE_URL origin", false); }
check("AI provider configured", Boolean(process.env.GROQ_API_KEY));
check("Annual subscription CRON_SECRET configured", Boolean(process.env.CRON_SECRET));
try {
  const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  check("Annual Credits Cron exists", vercel.crons?.some(job =>
    job.path === "/api/stripe-annual-credit-grant" && Boolean(job.schedule)));
} catch { check("Annual Credits Cron exists", false); }
check("Subscription sales explicitly enabled", process.env.STRIPE_SUBSCRIPTIONS_ENABLED === "true");
check("All eight subscription Price IDs present", requiredPrices.every(name =>
  /^price_[a-zA-Z0-9]+$/.test(process.env[name] || "")));
const prices = requiredPrices.map(name => process.env[name] || "");
check("Subscription Price IDs are distinct", prices.every(Boolean) && new Set(prices).size === prices.length);
if (mode === "live") {
  check("Live Checkout explicitly enabled", process.env.STRIPE_LIVE_CHECKOUT_ENABLED === "true");
}
const trialEnabled = process.env.STRIPE_SUBSCRIPTION_TRIAL_ENABLED === "true";
results.push({ name: "Three-day trial", status: "info",
  detail: trialEnabled ? "enabled — requires separate Stripe lifecycle acceptance" : "off — no trial advertised" });
for (const result of results) {
  console.log(`[${result.status.toUpperCase()}] ${result.name}${result.detail ? ": " + result.detail : ""}`);
}
console.log("This check never verifies Stripe Price amounts, account permissions, Webhook delivery, or live payment.");
if (results.some(result => result.status === "fail")) process.exitCode = 1;
