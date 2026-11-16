const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

// Run the actual route code with isolated Firebase/Stripe boundaries, without credentials.
function load(file, env = {}) {
  const context = vm.createContext({ Buffer, Date, console, randomUUID, process: { env },
    FieldValue: { increment: n => ({ increment: n }), serverTimestamp: () => 'timestamp', delete: () => null } });
  const source = fs.readFileSync(file, 'utf8').replace(/^import .*;\n/gm, '')
    .replace('export const config', 'const config').replace('export default async function', 'async function');
  vm.runInContext(source, context);
  return context;
}
function store(initial = {}) {
  let records = structuredClone(initial);
  const ref = path => ({ path, collection: name => col(path + '/' + name), get: async () => snap(path) });
  const col = path => ({ doc: id => ref(path + '/' + id) });
  const snap = path => ({ exists: path in records, data: () => structuredClone(records[path]) });
  return { collection: col, read: path => records[path], async runTransaction(fn) {
    const writes = [];
    await fn({ get: async r => snap(r.path),
      set: (r, data) => writes.push([r.path, data]),
      create: (r, data) => { assert.ok(!(r.path in records)); writes.push([r.path, data]); } });
    for (const [path, data] of writes) {
      const current = records[path] || {};
      for (const [key, value] of Object.entries(data)) current[key] = value?.increment !== undefined ? (current[key] || 0) + value.increment : value;
      records[path] = current;
    }
  } };
}
const billing = 'users/u/billing/current';
const order = { uid: 'u', type: 'credit_pack', packId: 'mini', credits: 10000, amount: 500, currency: 'usd', stripeCheckoutSessionId: 'cs_1' };
const session = { id: 'cs_1', metadata: { orderId: 'o', firebaseUID: 'u', packId: 'mini' }, payment_status: 'paid', mode: 'payment', currency: 'usd', amount_total: 500 };
test('pack grants atomically to the shared billing balance and only once across events', async () => {
  const c = load('api/stripe-webhook.js');
  const db = store({ 'billingOrders/o': order, [billing]: { creditBalance: 7 } });
  await c.fulfillCreditPack({ db, session, uid: 'u', event: { id: 'e1' } });
  await c.fulfillCreditPack({ db, session, uid: 'u', event: { id: 'e2' } });
  assert.equal(db.read(billing).creditBalance, 10007);
  assert.equal(db.read('billingOrders/o').status, 'paid');
  assert.equal(db.read('users/u/creditLedger/stripe_pack_o').credits, 10000);
});
for (const [name, patch, orderPatch] of [
  ['unpaid', { payment_status: 'unpaid' }, {}], ['amount', { amount_total: 1 }, {}],
  ['currency', { currency: 'eur' }, {}], ['session', { id: 'cs_wrong' }, {}],
  ['owner', {}, { uid: 'other' }], ['order currency', {}, { currency: 'eur' }]
]) test(`pack rejects ${name} without granting`, async () => {
  const c = load('api/stripe-webhook.js');
  const db = store({ 'billingOrders/o': { ...order, ...orderPatch } });
  try { await c.fulfillCreditPack({ db, session: { ...session, ...patch }, uid: 'u', event: { id: 'e' } }); }
  catch (e) { assert.match(e.message, /match/); }
  assert.equal(db.read(billing), undefined);
  assert.equal(db.read('users/u/creditLedger/stripe_pack_o'), undefined);
});
for (const interval of ['month', 'year']) test(`${interval} subscription grants once per paid invoice`, async () => {
  const c = load('api/stripe-webhook.js');
  const db = store({ 'billingOrders/o': { uid: 'u', planId: 'lite', interval: interval === 'year' ? 'yearly' : 'monthly', priceId: 'price_1', currency: 'usd' } });
  const subscription = { id: 'sub_1', metadata: { orderId: 'o', planId: 'lite' }, items: { data: [{ current_period_start: 1769817600, price: { id: 'price_1', recurring: { interval } } }] } };
  const invoice = { id: 'in_1', status: 'paid', currency: 'usd', billing_reason: 'subscription_cycle', lines: { data: [{ price: { id: 'price_1' } }] } };
  for (let i = 0; i < 2; i++) await c.grantSubscriptionInvoice({ db, invoice, subscription, uid: 'u' });
  assert.equal(db.read(billing).creditBalance, 10000);
  assert.equal(db.read('users/u/creditLedger/stripe_invoice_in_1').credits, 10000);
  if (interval === 'year') assert.ok(db.read(billing).nextCreditGrantAt instanceof Date);
  await assert.rejects(c.grantSubscriptionInvoice({ db, invoice: { ...invoice, id: 'in_bad', status: 'open' }, subscription, uid: 'u' }), /paid USD/);
  await assert.rejects(c.grantSubscriptionInvoice({ db, invoice: { ...invoice, id: 'in_bad', currency: 'eur' }, subscription, uid: 'u' }), /paid USD/);
  await assert.rejects(c.grantSubscriptionInvoice({ db, invoice: { ...invoice, lines: { data: [] } }, subscription, uid: 'u' }), /supported/);
  assert.equal(db.read(billing).creditBalance, 10000);
});
for (const file of ['api/stripe-checkout.js', 'api/stripe-credit-checkout.js']) {
  for (const [env, key, flag] of [['preview', 'sk_live_dummy', undefined], ['production', 'sk_live_dummy', undefined], ['production', 'sk_test_dummy', 'true']]) {
    test(`${file} fails closed for ${env}/${key}/${flag}`, async () => {
      const c = load(file, { VERCEL_ENV: env, STRIPE_SECRET_KEY: key, STRIPE_LIVE_CHECKOUT_ENABLED: flag, FIREBASE_PROJECT_ID: 'p', FIREBASE_SERVICE_ACCOUNT_JSON: '{}' });
      await assert.rejects(c.getServices(), /disabled|Test Mode/);
    });
  }
}
test('invalid webhook signature stops before any Firestore access', async () => {
  const c = load('api/stripe-webhook.js');
  c.mockServices = { stripe: { webhooks: { constructEvent() { throw Error('bad signature'); } } } };
  vm.runInContext('servicesPromise = Promise.resolve(mockServices)', c);
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await c.handler({ method: 'POST', headers: { 'stripe-signature': 'invalid' }, rawBody: Buffer.from('{}') }, res);
  assert.equal(res.code, 400);
});
test('calendar grants preserve month-end anchors and metadata UID excludes client_reference_id', () => {
  const c = load('api/stripe-annual-credit-grant.js');
  assert.equal(c.addUtcMonth(new Date('2026-01-31T00:00:00Z'), 31).toISOString(), '2026-02-28T00:00:00.000Z');
  const w = load('api/stripe-webhook.js');
  assert.equal(w.getFirebaseUid({ client_reference_id: 'attacker' }), null);
  assert.equal(w.getFirebaseUid({ metadata: { firebaseUID: 'u' } }), 'u');
});
test('subscription guard scans all pages and blocks unpaid subscriptions', async () => {
  const c = load('api/stripe-checkout.js');
  const calls = [];
  const stripe = { subscriptions: { async list(params) {
    calls.push(params);
    return calls.length === 1 ? { data: [{ id: 'old', status: 'canceled' }], has_more: true } : { data: [{ id: 'blocking', status: 'unpaid' }], has_more: false };
  } } };
  assert.equal((await c.findActiveSubscription(stripe, 'cus_1')).id, 'blocking');
  assert.equal(calls[1].starting_after, 'old');
});
for (const processed of [true, false]) test(`webhook ${processed ? 'processed event is acknowledged' : 'active lease requests retry'}`, async () => {
  const c = load('api/stripe-webhook.js');
  const db = store({ 'stripeWebhookEvents/e1': { processed, processingStatus: 'processing', processingLeaseUntilMs: Date.now() + 300000 } });
  c.mockServices = { db, stripe: { webhooks: { constructEvent: () => ({ id: 'e1', type: 'checkout.session.completed' }) } } };
  vm.runInContext('servicesPromise = Promise.resolve(mockServices)', c);
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await c.handler({ method: 'POST', headers: { 'stripe-signature': 'mock' }, rawBody: Buffer.from('{}') }, res);
  assert.equal(res.code, processed ? 200 : 500);
  assert.equal(db.read(billing), undefined);
});
