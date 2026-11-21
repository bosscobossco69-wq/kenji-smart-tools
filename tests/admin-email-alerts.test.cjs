const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const vm = require("node:vm");

function fixture(configured = true) {
  const sent = [], records = new Map();
  const removed = Symbol("remove");
  const env = configured ? {
    RESEND_API_KEY: "re_fake_test_only",
    RESEND_FROM_EMAIL: "alerts@example.com",
    ADMIN_ALERT_EMAIL: "owner@example.com",
    VERCEL_ENV: "production"
  } : { VERCEL_ENV: "preview" };
  const context = vm.createContext({
    createHash, randomUUID, Date, Object, Number, String,
    AbortSignal, process: { env },
    FieldValue: { increment: n => ({ increment: n }), delete: () => removed, serverTimestamp: () => "timestamp" },
    fetch: async (url, options) => {
      sent.push({ url, options });
      return { ok: true, json: async () => ({ id: "email_sent_" + sent.length }) };
    },
    console
  });
  const source = fs.readFileSync("lib/admin-email-alerts.js", "utf8")
    .replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
  vm.runInContext(source, context);
  const doc = id => ({
    id,
    async create(data) {
      if (records.has(id)) throw Object.assign(new Error("duplicate"), { code: 6 });
      records.set(id, { ...data });
    }
  });
  const write = (id, data) => {
    const entry = { ...(records.get(id) || {}) };
    for (const [key, value] of Object.entries(data)) {
      if (value === removed) delete entry[key];
      else if (value && typeof value === "object" && "increment" in value) entry[key] = (entry[key] || 0) + value.increment;
      else entry[key] = value;
    }
    records.set(id, entry);
  };
  const db = {
    collection: () => ({ doc }),
    async runTransaction(callback) {
      return callback({
        get: async ref => ({
          exists: records.has(ref.id),
          data: () => records.get(ref.id)
        }),
        set: (ref, data) => write(ref.id, data)
      });
    }
  };
  return { context, db, sent, records };
}

test("one paid invoice sends only one private email", async () => {
  const f = fixture();
  const details = {
    amountUsd: 10, credits: 10000, plan: "lite",
    customerEmail: "private@example.com", projectDetails: "secret text"
  };
  await f.context.notifyAdmin(f.db, "subscription_paid", "in_demo", details);
  await f.context.notifyAdmin(f.db, "subscription_paid", "in_demo", details);
  assert.equal(f.sent.length, 1);
  const payload = f.sent[0].options.body;
  assert.ok(payload.includes("10000"));
  assert.ok(!payload.includes("private@example.com"));
  assert.ok(!payload.includes("secret text"));
  assert.ok(f.sent[0].options.headers["Idempotency-Key"].startsWith("kenji-alert-"));
  const key = f.context.alertId("subscription_paid", "in_demo");
  assert.equal(f.records.get(key).status, "sent");
});

test("unconfigured notification sender keeps a pending outbox record", async () => {
  const f = fixture(false);
  await f.context.notifyAdmin(f.db, "website_paid", "order_demo", { amountUsd: 99 });
  assert.equal(f.sent.length, 0);
  assert.equal(f.records.get(f.context.alertId("website_paid", "order_demo")).status, "pending");
});

test("unsafe type, blank and oversized alert references are refused", () => {
  const f = fixture();
  assert.throws(() => f.context.alertId("unrecognized", "test"));
  assert.throws(() => f.context.alertId("credit_paid", ""));
  assert.throws(() => f.context.alertId("credit_paid", "x".repeat(201)));
});
