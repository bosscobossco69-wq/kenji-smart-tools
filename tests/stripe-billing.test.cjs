const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID, createHash } = require('node:crypto');

// Run the actual route code with isolated Firebase/Stripe boundaries, without credentials.
function load(file, env = {}) {
  const context = vm.createContext({ Buffer, Date, URL, console, randomUUID, createHash, process: { env },
    FieldValue: { increment: n => ({ increment: n }), serverTimestamp: () => 'timestamp', delete: () => null } });
  const helper = fs.readFileSync('lib/billing-environment.js', 'utf8').replace(/^export /gm, '');
  vm.runInContext(helper, context);
  if (file === 'api/stripe-webhook.js' || file === 'lib/stripe-adjustments.js') {
    const adjustments = fs.readFileSync('lib/stripe-adjustments.js', 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(adjustments, context);
    if (file === 'lib/stripe-adjustments.js') return context;
  }
  const source = fs.readFileSync(file, 'utf8').replace(/^import .*;\n/gm, '')
    .replace('export const config', 'const config').replace('export default async function', 'async function');
  vm.runInContext(source, context);
  return context;
}
function store(initial = {}) {
  let records = structuredClone(initial), queue = Promise.resolve();
  const col = path => ({ doc: id => ref(path + '/' + id) });
  const snap = path => ({ exists: path in records, data: () => structuredClone(records[path]) });
  function write(path, data, merge = true) {
    const current = merge ? records[path] || {} : {};
    for (const [key, value] of Object.entries(data)) current[key] = value?.increment !== undefined ? (current[key] || 0) + value.increment : value;
    records[path] = current;
  }
  const ref = path => ({ path, collection: name => col(path + '/' + name), get: async () => snap(path),
    set: async (data, options) => write(path, data, options?.merge),
    create: async data => { assert.ok(!(path in records)); write(path, data, false); } });
  return { collection: col, read: path => records[path], paths: () => Object.keys(records),
    collectionGroup: name => ({ name }),
    async runTransaction(fn) {
      const run = queue.then(async () => {
        const writes = [];
        const result = await fn({ get: async r => snap(r.path),
          set: (r, data, options) => writes.push(() => write(r.path, data, options?.merge)),
          delete: r => writes.push(() => { delete records[r.path]; }),
          create: (r, data) => { assert.ok(!(r.path in records)); writes.push(() => write(r.path, data, false)); } });
        for (const operation of writes) operation();
        return result;
      });
      queue = run.catch(() => {});
      return run;
    }
  };
}
const billing = 'users/u/billing_test/current';
const order = { uid: 'u', type: 'credit_pack', packId: 'mini', credits: 10000, amount: 500, currency: 'usd', stripeCheckoutSessionId: 'cs_1' };
const session = { id: 'cs_1', metadata: { orderId: 'o', firebaseUID: 'u', packId: 'mini' }, payment_status: 'paid', payment_intent: 'pi_1', mode: 'payment', currency: 'usd', amount_total: 500 };
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
      await assert.rejects(c.getServices(), /disabled|Test Mode|not configured/);
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
  c.mockServices = { db, stripe: { webhooks: { constructEvent: () => ({ livemode: false, id: 'e1', type: 'checkout.session.completed' }) } } };
  vm.runInContext('servicesPromise = Promise.resolve(mockServices)', c);
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await c.handler({ method: 'POST', headers: { 'stripe-signature': 'mock' }, rawBody: Buffer.from('{}') }, res);
  assert.equal(res.code, processed ? 200 : 500);
  assert.equal(db.read(billing), undefined);
});
test('Checkout reconciliation retrieves current metadata before binding and grants only once', async () => {
  const c = load('api/stripe-webhook.js');
  const db = store({ 'billingOrders/o': { ...order, createdAt: 1000 }, [billing]: { creditBalance: 3, pendingSubscriptionCheckout: { orderId: 'o', sessionId: 'cs_1' } } });
  let deliveries = 0;
  const verified = [];
  c.mockServices = { db, auth: { async getUser(uid) { verified.push(uid); return { emailVerified: true }; } }, stripe: {
    webhooks: { constructEvent: () => ({ livemode: false, id: 'fresh_' + (++deliveries), created: 10, type: 'checkout.session.completed', data: { object: { id: 'cs_1', metadata: { firebaseUID: 'stale' } } } }) },
    paymentIntents: { retrieve: async () => ({ livemode: false, latest_charge: { id: 'ch_1', livemode: false, amount: 500, currency: 'usd', payment_intent: 'pi_1' } }) },
    checkout: { sessions: { retrieve: async () => ({ ...session, payment_intent: 'pi_1', livemode: false, created: 9, metadata: { ...session.metadata, purchaseType: 'credit_pack' } }) } }
  } };
  vm.runInContext('servicesPromise = Promise.resolve(mockServices)', c);
  for (let i = 0; i < 2; i++) {
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await c.handler({ method: 'POST', headers: { 'stripe-signature': 'mock' }, rawBody: Buffer.from('{}') }, res);
    assert.equal(res.code, 200);
  }
  assert.deepEqual(verified, ['u', 'u']);
  assert.equal(db.read(billing).creditBalance, 10003);
  assert.equal(db.read(billing).pendingSubscriptionCheckout, null);
  assert.equal(db.read('billingOrders/o').status, 'paid');
});
test('unlinked billing events retry and release their processing lease without email matching', async () => {
  const c = load('api/stripe-webhook.js');
  const db = store();
  c.mockServices = { db, auth: { getUserByEmail() { throw Error('email lookup must not occur'); } }, stripe: {
    webhooks: { constructEvent: () => ({ livemode: false, id: 'unlinked', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } }) },
    checkout: { sessions: { retrieve: async () => ({ livemode: false, id: 'cs_1', customer_email: 'someone@example.com', payment_status: 'paid' }) } }
  } };
  vm.runInContext('servicesPromise = Promise.resolve(mockServices)', c);
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await c.handler({ method: 'POST', headers: { 'stripe-signature': 'mock' }, rawBody: Buffer.from('{}') }, res);
  assert.equal(res.code, 500);
  assert.equal(db.read('stripeWebhookEvents/unlinked').processingStatus, 'retryable');
  assert.equal(db.read('stripeWebhookEvents/unlinked').processed, false);
  assert.equal(db.read(billing), undefined);
});
test('order timestamps retain nanosecond ordering', () => {
  const c = load('api/stripe-webhook.js');
  assert.ok(c.timestampOrderKey({ seconds: 100, nanoseconds: 1 }) < c.timestampOrderKey({ seconds: 100, nanoseconds: 2 }));
});

test('Test and Live namespace every root, balance, customer, ledger and Cron group independently', async () => {
  const native = store({ 'users/u/billing/current': { creditBalance: 123, stripeCustomerId: 'legacy' } });
  for (const [environment, mode] of [['preview', 'test'], ['production', 'live']]) {
    const c = load('api/account-billing.js', { VERCEL_ENV: environment });
    const db = c.billingDb(native);
    await db.collection('users').doc('u').collection(c.billingCollection()).doc('current').set({ creditBalance: mode === 'test' ? 10000 : 5, stripeCustomerId: mode + '_customer' });
    await db.collection('billingOrders').doc('same-order').set({ mode });
    assert.equal(db.collectionGroup('billing').name, 'billing_' + mode);
    assert.equal(db.collection('stripeWebhookEvents').doc('e').path, 'billing_' + mode + '_stripeWebhookEvents/e');
    assert.equal(db.collection('users').doc('u').collection('creditLedger').doc('r').path, 'billing_' + mode + '_users/u/creditLedger/r');
  }
  assert.equal(native.read('billing_test_users/u/billing_test/current').creditBalance, 10000);
  assert.equal(native.read('billing_live_users/u/billing_live/current').creditBalance, 5);
  assert.equal(native.read('users/u/billing/current').creditBalance, 123);
  assert.equal(native.read('users/u/billing/current').stripeCustomerId, 'legacy');
});
test('legacy Live accounts are held for review without migrating or deleting history', async () => {
  const c = load('api/account-billing.js', { VERCEL_ENV: 'production' });
  const native = store({ 'users/u/billing/current': { creditBalance: 123 } });
  await assert.rejects(c.assertLegacyReviewed(c.billingDb(native), 'u'), /Legacy billing review/);
  assert.equal(native.paths().length, 1);
  await native.collection('billing_live_users').doc('u').collection('billing_live').doc('current').set({ legacyReviewComplete: true, creditBalance: 123 });
  await c.assertLegacyReviewed(c.billingDb(native), 'u');
  assert.equal(native.read('users/u/billing/current').creditBalance, 123);
});
for (const [environment, livemode] of [['preview', true], ['production', false]]) test(`${environment} webhook rejects cross-mode signed events before writes`, async () => {
  const c = load('api/stripe-webhook.js', { VERCEL_ENV: environment });
  const db = store();
  c.mockServices = { db, stripe: { webhooks: { constructEvent: () => ({ livemode, id: 'wrong-mode' }) } } };
  vm.runInContext('servicesPromise = Promise.resolve(mockServices)', c);
  const res = response();
  await c.handler({ method: 'POST', headers: { 'stripe-signature': 'valid-mock' }, rawBody: Buffer.from('{}') }, res);
  assert.equal(res.code, 400);
  assert.equal(db.paths().length, 0);
});
function response() { return { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; }
function adjustmentFixture() {
  const c = load('lib/stripe-adjustments.js');
  const native = store({
    'billing_test_billingOrders/o': { ...order, stripePaymentIntentId: 'pi_1' },
    'billing_test_users/u/billing_test/current': { creditBalance: 3000 },
    'billing_test_users/u/creditLedger/stripe_pack_o': { credits: 10000, stripePaymentIntentId: 'pi_1' }
  });
  const state = { refunded: 0, pending: 0, disputed: false, disputeStatus: 'needs_response' };
  const stripe = {
    charges: { retrieve: async () => ({ id: 'ch_1', livemode: false, payment_intent: 'pi_1', amount: 500, currency: 'usd', disputed: state.disputed }) },
    paymentIntents: { retrieve: async () => ({ id: 'pi_1', livemode: false, metadata: { firebaseUID: 'u', orderId: 'o', purchaseType: 'credit_pack' } }) },
    refunds: { list: async () => ({ data: [
      { livemode: false, amount: state.refunded, status: 'succeeded' },
      { livemode: false, amount: state.pending, status: 'pending' }
    ], has_more: false }) },
    disputes: { retrieve: async () => ({ id: 'dp_1', livemode: false, charge: 'ch_1', status: state.disputeStatus }) }
  };
  const event = (type = 'charge.refunded', id = 'e') => ({ type, id, data: { object: type.startsWith('charge.dispute.') ? { id: 'dp_1', charge: 'ch_1' } : { id: 'ch_1' } } });
  return { c, native, db: c.billingDb(native), state, stripe, event };
}
test('partial refunds reconcile cumulatively, ignore pending amounts and do not debit on replay', async () => {
  const f = adjustmentFixture(); f.state.refunded = 100; f.state.pending = 100;
  await f.c.reconcileAdjustment({ ...f, event: f.event() });
  assert.equal(f.native.read('billing_test_users/u/billing_test/current').creditBalance, 1000);
  await f.c.reconcileAdjustment({ ...f, event: f.event('charge.refunded', 'another-delivery') });
  assert.equal(f.native.read('billing_test_users/u/billing_test/current').creditBalance, 1000);
  f.state.refunded = 500;
  await f.c.reconcileAdjustment({ ...f, event: f.event() });
  assert.equal(f.native.read('billing_test_users/u/billing_test/current').creditBalance, -7000);
  assert.equal(f.native.paths().filter(p => p.includes('/creditLedger/stripe_adjustment_')).length, 2);
});
test('dispute hold, won restore and refunds share one cap without duplicate revocation', async () => {
  const f = adjustmentFixture(); f.state.disputed = true;
  await f.c.reconcileAdjustment({ ...f, event: f.event('charge.dispute.created') });
  assert.equal(f.native.read('billing_test_users/u/billing_test/current').creditBalance, -7000);
  f.state.refunded = 100;
  await f.c.reconcileAdjustment({ ...f, event: f.event() });
  assert.equal(f.native.read('billing_test_users/u/billing_test/current').creditBalance, -7000);
  f.state.disputeStatus = 'won';
  await f.c.reconcileAdjustment({ ...f, event: f.event('charge.dispute.closed') });
  assert.equal(f.native.read('billing_test_users/u/billing_test/current').creditBalance, 1000);
  await f.c.reconcileAdjustment({ ...f, event: f.event('charge.dispute.closed') });
  assert.equal(f.native.read('billing_test_users/u/billing_test/current').creditBalance, 1000);
});
test('lost dispute stays revoked and unrelated legacy payment is queued without touching balances', async () => {
  const f = adjustmentFixture(); f.state.disputed = true; f.state.disputeStatus = 'lost';
  await f.c.reconcileAdjustment({ ...f, event: f.event('charge.dispute.closed') });
  assert.equal(f.native.read('billing_test_users/u/billing_test/current').creditBalance, -7000);
  f.stripe.paymentIntents.retrieve = async () => ({ id: 'pi_legacy', livemode: false, metadata: {} });
  await f.c.reconcileAdjustment({ ...f, event: f.event() });
  assert.equal(f.native.read('billing_test_stripeChargeAdjustments/ch_1').manualReview, true);
  assert.equal(f.native.read('billing_test_users/u/billing_test/current').creditBalance, -7000);
});
test('refund arriving before fulfillment is retried; late Checkout cannot grant refunded Credits', async () => {
  const c = load('api/stripe-webhook.js');
  const db = store({ 'billingOrders/o': order });
  const charge = { id: 'ch_1', amount: 500, currency: 'usd', payment_intent: 'pi_1', amount_refunded: 500 };
  await c.fulfillCreditPack({ db, session, uid: 'u', event: { id: 'late-checkout' }, charge });
  assert.equal(db.read(billing).creditBalance, 0);
  assert.equal(db.read('users/u/creditLedger/stripe_pack_initial_hold_o').credits, -10000);
});
test('AI debit, exact single refund, cache, insufficient balance and debt remain consistent', async () => {
  const c = load('api/generate-reply.js');
  const db = store({ [billing]: { creditBalance: 2 } });
  const first = await c.reserveCredits(db, 'u', 'r1', 'h1');
  assert.equal(db.read(billing).creditBalance, 1);
  assert.equal((await c.reserveCredits(db, 'u', 'r1', 'h1')).status, 409);
  assert.equal(await c.refundCredits(db, 'u', 'r1', 'error', 'stale'), false);
  assert.equal(await c.refundCredits(db, 'u', 'r1', 'error', first.leaseToken), true);
  assert.equal(await c.refundCredits(db, 'u', 'r1', 'error', first.leaseToken), false);
  const second = await c.reserveCredits(db, 'u', 'r2', 'h2');
  await c.completeCredits(db, 'u', 'r2', 'h2', 'reply', second.leaseToken);
  assert.equal((await c.reserveCredits(db, 'u', 'r2', 'h2')).cachedReply, 'reply');
  assert.equal(db.read(billing).creditBalance, 1);
  await db.collection('users').doc('u').collection('billing_test').doc('current').set({ creditBalance: -10 });
  assert.equal((await c.reserveCredits(db, 'u', 'r3', 'h3')).status, 402);
  assert.equal(db.read(billing).creditBalance, -10);
});
test('new subscriptions default closed while existing billing management remains available', async () => {
  const c = load('api/stripe-checkout.js'); const res = response();
  await c.handler({ method: 'POST', headers: {} }, res);
  assert.equal(res.code, 503);
  assert.match(res.body.error, /One-time Credits/);
});

test('portal opens the verified customer cancellation portal and refuses another user customer', async () => {
  for (const owner of ['u', 'other']) {
    const c = load('api/stripe-portal.js', { STRIPE_SECRET_KEY: 'sk_test_dummy', SITE_URL: 'https://kenji-smart-tools.vercel.app', FIREBASE_PROJECT_ID: 'p', FIREBASE_SERVICE_ACCOUNT_JSON: '{"project_id":"p"}' });
    const native = store({ 'billing_test_users/u/billing_test/current': { stripeCustomerId: 'cus_1' } });
    let calls = 0;
    c.getApps = () => [{}]; c.getFirestore = () => native;
    c.getAuth = () => ({ verifyIdToken: async () => ({ uid: 'u', email_verified: true }) });
    c.Stripe = function () { return {
      customers: { retrieve: async () => ({ id: 'cus_1', livemode: false, metadata: { firebaseUID: owner } }) },
      billingPortal: { sessions: { create: async params => { calls++; assert.equal(params.customer, 'cus_1'); assert.equal(params.return_url, 'https://kenji-smart-tools.vercel.app/workspace/billing.html'); return { url: 'https://billing.stripe.com/p/session' }; } } }
    }; };
    const res = response();
    await c.handler({ method: 'POST', headers: { authorization: 'Bearer token' } }, res);
    assert.equal(res.code, owner === 'u' ? 200 : 503);
    assert.equal(calls, owner === 'u' ? 1 : 0);
  }
});
test('older refund snapshots cannot overwrite newer reconciliations', async () => {
  const f = adjustmentFixture();
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let chargeReads = 0;
  const retrieve = f.stripe.charges.retrieve;
  f.stripe.charges.retrieve = async () => { if (++chargeReads === 1) { entered(); await waiting; } return retrieve(); };
  const older = f.c.reconcileAdjustment({ ...f, event: f.event() });
  await started;
  f.state.refunded = 500;
  await f.c.reconcileAdjustment({ ...f, event: f.event() });
  f.state.refunded = 0; // simulate an older API snapshot reaching the transaction late
  release(); await older;
  assert.equal(f.native.read('billing_test_users/u/billing_test/current').creditBalance, -7000);
});
for (const [environment, key] of [['preview', 'sk_live_dummy'], ['production', 'sk_test_dummy']]) test(`annual Cron ${environment} rejects a cross-mode key`, async () => {
  const c = load('api/stripe-annual-credit-grant.js', { VERCEL_ENV: environment, STRIPE_SECRET_KEY: key });
  await assert.rejects(c.getServices(), /Test Mode|not configured/);
});
test('actionable fraud warning holds Credits and clears without duplicate deductions', async () => {
  const f = adjustmentFixture(); let actionable = true;
  f.stripe.radar = { earlyFraudWarnings: { retrieve: async () => ({ livemode: false, charge: 'ch_1', actionable }) } };
  const event = type => ({ id: 'warning-event', type, data: { object: { id: 'issfr_1', charge: 'ch_1' } } });
  await f.c.reconcileAdjustment({ ...f, event: event('radar.early_fraud_warning.created') });
  await f.c.reconcileAdjustment({ ...f, event: event('radar.early_fraud_warning.created') });
  assert.equal(f.native.read('billing_test_users/u/billing_test/current').creditBalance, -7000);
  actionable = false;
  await f.c.reconcileAdjustment({ ...f, event: event('radar.early_fraud_warning.updated') });
  assert.equal(f.native.read('billing_test_users/u/billing_test/current').creditBalance, 3000);
});

// Link and execute the actual ESM maintenance scripts with synthetic SDK boundaries.
// No credentials, network requests or real database writes are used.
async function runMaintenance(script, native, manifest, apply = true) {
  const path = require('node:path');
  const crypto = require('node:crypto');
  const context = vm.createContext({ console: { log() {} }, process: { env: {
    VERCEL_ENV: 'production', STRIPE_SECRET_KEY: 'sk_live_dummy', FIREBASE_PROJECT_ID: 'p', FIREBASE_SERVICE_ACCOUNT_JSON: '{"project_id":"p"}'
  }, argv: ['node', script, 'reviewed.json', ...(apply ? ['--apply'] : [])] } });
  const modules = new Map();
  const stripe = { customers: { retrieve: async () => ({ id: 'cus_live', livemode: true, metadata: { firebaseUID: 'u' } }) },
    charges: { retrieve: async () => ({ id: 'ch_live', livemode: true, customer: 'cus_live' }) } };
  const dependencies = {
    'node:fs': { default: { readFileSync: () => JSON.stringify(manifest) } },
    'node:crypto': { createHash: crypto.createHash },
    stripe: { default: function Stripe() { return stripe; } },
    'firebase-admin/app': { cert: x => x, getApps: () => [{}], initializeApp: () => ({}) },
    'firebase-admin/firestore': { getFirestore: () => native, FieldValue: { serverTimestamp: () => 'timestamp' } }
  };
  async function getModule(specifier, parent) {
    const id = dependencies[specifier] ? specifier : path.resolve(path.dirname(parent), specifier);
    if (modules.has(id)) return modules.get(id);
    let module;
    if (dependencies[id]) {
      const values = dependencies[id];
      module = new vm.SyntheticModule(Object.keys(values), function () { for (const [name, value] of Object.entries(values)) this.setExport(name, value); }, { context, identifier: id });
    } else module = new vm.SourceTextModule(fs.readFileSync(id, 'utf8'), { context, identifier: id });
    modules.set(id, module);
    await module.link((specifier, referencing) => getModule(specifier, referencing.identifier));
    return module;
  }
  const module = await getModule('./' + script, path.resolve('entry.mjs'));
  await module.evaluate();
}
test('reviewed Live import is dry-run by default, additive and idempotent; leaves history untouched', async () => {
  const native = store({ 'users/u/billing/current': { creditBalance: 9999 }, 'billing_live_users/u/billing_live/current': { creditBalance: 5 } });
  const originalCollection = native.collection;
  native.collection = name => {
    const result = originalCollection(name);
    if (name !== 'users') return result;
    return { doc: uid => ({ collection: sub => ({ doc: id => ({ ...originalCollection('users').doc(uid).collection(sub).doc(id), legacy: true }) }) }) };
  };
  const originalTransaction = native.runTransaction;
  native.runTransaction = callback => originalTransaction(tx => callback({ ...tx, get: async ref => {
    const snap = await tx.get(ref);
    if (ref.legacy) snap.updateTime = { seconds: 100, nanoseconds: 1 };
    return snap;
  } }));
  const entry = [{ uid: 'u', reviewedCreditBalance: 100, reviewReference: 'review-1', legacyUpdateTime: '100:1' }];
  await runMaintenance('scripts/import-reviewed-live-billing.mjs', native, entry, false);
  assert.equal(native.read('billing_live_users/u/billing_live/current').creditBalance, 5);
  await runMaintenance('scripts/import-reviewed-live-billing.mjs', native, entry);
  await runMaintenance('scripts/import-reviewed-live-billing.mjs', native, entry);
  assert.equal(native.read('billing_live_users/u/billing_live/current').creditBalance, 105);
  assert.equal(native.read('users/u/billing/current').creditBalance, 9999);
});
test('reviewed legacy refund case applies exactly once and rejects changed reuse of its ID', async () => {
  const native = store({ 'billing_live_users/u/billing_live/current': { creditBalance: 5, legacyReviewComplete: true } });
  const entry = { uid: 'u', creditsDelta: -10, caseId: 'refund-case-1', reviewReference: 'refund-check', chargeId: 'ch_live' };
  await runMaintenance('scripts/apply-reviewed-credit-adjustment.mjs', native, entry);
  await runMaintenance('scripts/apply-reviewed-credit-adjustment.mjs', native, entry);
  assert.equal(native.read('billing_live_users/u/billing_live/current').creditBalance, -5);
  await assert.rejects(runMaintenance('scripts/apply-reviewed-credit-adjustment.mjs', native, { ...entry, creditsDelta: -20 }), /different adjustment/);
});
test('cancellation webhook updates current subscription state without altering Credits', async () => {
  const c = load('api/stripe-webhook.js');
  const subscription = { id: 'sub_1', livemode: false, created: 100, status: 'canceled', metadata: { firebaseUID: 'u' }, items: { data: [] } };
  const db = store({ [billing]: { creditBalance: 77, stripeSubscriptionId: 'sub_1', status: 'active', active: true } });
  c.mockServices = { db, auth: { getUser: async () => ({ emailVerified: true }) }, stripe: {
    webhooks: { constructEvent: () => ({ id: 'cancel', livemode: false, type: 'customer.subscription.deleted', data: { object: subscription } }) },
    subscriptions: { retrieve: async () => subscription }
  } };
  vm.runInContext('servicesPromise = Promise.resolve(mockServices)', c);
  const res = response();
  await c.handler({ method: 'POST', headers: { 'stripe-signature': 'mock' }, rawBody: Buffer.from('{}') }, res);
  assert.equal(res.code, 200);
  assert.equal(db.read(billing).active, false);
  assert.equal(db.read(billing).status, 'canceled');
  assert.equal(db.read(billing).creditBalance, 77);
});
test('annual Cron skips foreign roots and refuses cross-mode subscriptions without granting', async () => {
  const c = load('api/stripe-annual-credit-grant.js', { CRON_SECRET: 'cron-test' });
  const native = store();
  let pages = 0;
  const start = new Date(Date.now() - 50 * 86400000), due = new Date(Date.now() - 86400000), end = new Date(Date.now() + 200 * 86400000);
  const data = { active: true, nextCreditGrantAt: due, currentPeriodEnd: end, currentPeriodStart: start, annualCreditGrantPeriodStart: start, stripeSubscriptionId: 'sub_test', annualCreditGrantSubscriptionId: 'sub_test', planId: 'lite' };
  const goodRef = { path: 'billing_test_users/u/billing_test/current', parent: { parent: { id: 'u' } } };
  const docs = [ { ref: { path: 'billing_live_users/u/billing_test/current' }, data: () => data }, { ref: goodRef, data: () => data } ];
  native.collectionGroup = name => {
    assert.equal(name, 'billing_test');
    const query = { where: () => query, limit: () => query, startAfter: () => query,
      get: async () => ++pages === 1 ? { empty: false, size: 2, docs } : { empty: true, docs: [] } };
    return query;
  };
  c.mockServices = { db: c.billingDb(native), stripe: { subscriptions: { retrieve: async () => ({ livemode: true }) } } };
  vm.runInContext('servicesPromise = Promise.resolve(mockServices)', c);
  const res = response();
  await c.handler({ method: 'GET', headers: { authorization: 'Bearer cron-test' } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.granted, 0);
  assert.equal(res.body.skipped, 1);
  assert.equal(res.body.failed, 1);
  assert.equal(native.paths().length, 0);
});

test('billing UI offers all four subscriptions alongside four one-time Credits packs', () => {
  const html = fs.readFileSync('workspace/billing.html', 'utf8');
  for (const plan of ['lite', 'pro', 'pro_plus', 'ultra']) {
    assert.match(html, new RegExp('<button[^>]*class="btn checkout-btn"[^>]*data-plan="' + plan + '"'));
  }
  for (const pack of ['mini', 'basic', 'pro', 'business']) {
    assert.match(html, new RegExp('<button[^>]*class="btn credit-pack-btn"[^>]*data-pack="' + pack + '"'));
  }
  assert.match(html, /selectedPeriod/);
  assert.match(html, /\/api\/stripe-checkout/);
  assert.match(html, /\/api\/stripe-credit-checkout/);
});

test('subscription and live payment gates remain explicit before deployment', () => {
  const subscription = fs.readFileSync('api/stripe-checkout.js', 'utf8');
  const credit = fs.readFileSync('api/stripe-credit-checkout.js', 'utf8');
  const environment = fs.readFileSync('lib/billing-environment.js', 'utf8');
  assert.match(subscription, /STRIPE_SUBSCRIPTIONS_ENABLED/);
  assert.match(subscription, /STRIPE_PRICE_LITE_MONTHLY/);
  assert.match(subscription, /STRIPE_PRICE_ULTRA_YEARLY/);
  assert.match(subscription, /assertStripeKey\(stripeKey, true\)/);
  assert.match(credit, /assertStripeKey\(stripeKey, true\)/);
  assert.match(environment, /STRIPE_LIVE_CHECKOUT_ENABLED/);
});

test('three-day subscription trial is opt-in and requires payment method', () => {
  const checkout = fs.readFileSync('api/stripe-checkout.js', 'utf8');
  assert.match(checkout, /STRIPE_SUBSCRIPTION_TRIAL_ENABLED === "true"/);
  assert.match(checkout, /trial_period_days: 3/);
  assert.match(checkout, /payment_method_collection: "always"/);
  assert.match(checkout, /missing_payment_method: "cancel"/);
  assert.match(checkout, /subscription_data: subscriptionData/);
});

test('zero-dollar trial invoice never grants Credits before first charge', async () => {
  const c = load('api/stripe-webhook.js');
  const db = store({
    'billingOrders/o': { uid: 'u', planId: 'lite', interval: 'monthly', priceId: 'price_1', currency: 'usd' }
  });
  const subscription = {
    id: 'sub_trial', status: 'trialing',
    metadata: { orderId: 'o', planId: 'lite' },
    items: { data: [{ price: { id: 'price_1', recurring: { interval: 'month' } } }] }
  };
  const invoice = {
    id: 'in_trial', status: 'paid', amount_paid: 0, currency: 'usd',
    billing_reason: 'subscription_create',
    lines: { data: [{ price: { id: 'price_1' } }] }
  };
  await c.grantSubscriptionInvoice({ db, invoice, subscription, uid: 'u' });
  assert.equal(db.read(billing), undefined);
  assert.equal(db.read('users/u/creditLedger/stripe_invoice_in_trial'), undefined);
  // Replay a delayed $0 trial invoice after Stripe already marks the subscription active.
  await c.grantSubscriptionInvoice({
    db, invoice: { ...invoice, id: 'in_delayed_trial' },
    subscription: { ...subscription, status: 'active' }, uid: 'u'
  });
  assert.equal(db.read(billing), undefined);
  assert.equal(db.read('users/u/creditLedger/stripe_invoice_in_delayed_trial'), undefined);
  const paidSubscription = { ...subscription, status: 'active' };
  await c.grantSubscriptionInvoice({
    db,
    invoice: { ...invoice, id: 'in_first_paid', amount_paid: 1000, billing_reason: 'subscription_cycle' },
    subscription: paidSubscription, uid: 'u'
  });
  assert.equal(db.read(billing).creditBalance, 10000);
  assert.equal(db.read('users/u/creditLedger/stripe_invoice_in_first_paid').credits, 10000);
});

test('trial eligibility denies repeat trials across paginated canceled subscriptions', async () => {
  const checkout = load('api/stripe-checkout.js');
  const requests = [];
  const stripe = { subscriptions: { list: async params => {
    requests.push(params);
    if (!params.starting_after) return {
      data: [{ id: 'sub_old', trial_start: null, trial_end: null }], has_more: true
    };
    return {
      data: [{ id: 'sub_trial', trial_start: 1700000000, trial_end: 1700259200 }],
      has_more: false
    };
  } } };
  assert.equal(await checkout.customerHasUsedTrial(stripe, 'cus_one'), true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].starting_after, 'sub_old');
  assert.equal(await checkout.customerHasUsedTrial({
    subscriptions: { list: async () => ({ data: [{ id: 'sub_untested' }], has_more: false }) }
  }, 'cus_new'), false);
  const checkoutSource = fs.readFileSync('api/stripe-checkout.js', 'utf8');
  assert.match(checkoutSource, /!\(await customerHasUsedTrial\(stripe, freshCustomerId\)\)/);
});

test('read-only release preflight validates Preview and fails closed on missing Live gates', () => {
  const { spawnSync } = require('node:child_process');
  const priceNames = [
    'STRIPE_PRICE_LITE_MONTHLY', 'STRIPE_PRICE_LITE_YEARLY',
    'STRIPE_PRICE_PRO_MONTHLY', 'STRIPE_PRICE_PRO_YEARLY',
    'STRIPE_PRICE_PRO_PLUS_MONTHLY', 'STRIPE_PRICE_PRO_PLUS_YEARLY',
    'STRIPE_PRICE_ULTRA_MONTHLY', 'STRIPE_PRICE_ULTRA_YEARLY'
  ];
  const env = {
    VERCEL_ENV: 'preview', STRIPE_SECRET_KEY: 'sk_test_private_fixture',
    STRIPE_WEBHOOK_SECRET: 'whsec_private_fixture',
    FIREBASE_PROJECT_ID: 'project_fixture',
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      type: 'service_account', project_id: 'project_fixture',
      client_email: 'unit-test@example.invalid', private_key: 'private_fixture'
    }),
    SITE_URL: 'https://example.invalid/', GROQ_API_KEY: 'groq_private_fixture',
    CRON_SECRET: 'cron_private_fixture', STRIPE_SUBSCRIPTIONS_ENABLED: 'true'
  };
  priceNames.forEach((name, index) => { env[name] = 'price_fixture' + index; });
  const run = vars => spawnSync(process.execPath, ['scripts/check-billing-config.mjs'], {
    env: vars, encoding: 'utf8'
  });
  const preview = run(env);
  assert.equal(preview.status, 0, preview.stderr + preview.stdout);
  assert.match(preview.stdout, /All eight subscription Price IDs present/);
  assert.doesNotMatch(preview.stdout, /private_fixture/);
  const liveBlocked = run({ ...env, VERCEL_ENV: 'production' });
  assert.equal(liveBlocked.status, 1);
  assert.match(liveBlocked.stdout, /Live Checkout explicitly enabled/);
  const liveReady = run({
    ...env, VERCEL_ENV: 'production',
    STRIPE_SECRET_KEY: 'sk_live_private_fixture', STRIPE_LIVE_CHECKOUT_ENABLED: 'true'
  });
  assert.equal(liveReady.status, 0, liveReady.stderr + liveReady.stdout);
  const duplicatePrice = run({ ...env, STRIPE_PRICE_PRO_YEARLY: env.STRIPE_PRICE_LITE_YEARLY });
  assert.equal(duplicatePrice.status, 1);
  assert.match(duplicatePrice.stdout, /Subscription Price IDs are distinct/);
});

test('published billing prices and Credits match both Stripe checkout and webhook grants', () => {
  const html = fs.readFileSync('workspace/billing.html', 'utf8');
  const subscriptions = load('api/stripe-checkout.js');
  const packCheckout = load('api/stripe-credit-checkout.js');
  const webhook = load('api/stripe-webhook.js');
  const planAmounts = {
    lite: { monthly: 1000, yearly: 10000, credits: 10000 },
    pro: { monthly: 2000, yearly: 20000, credits: 30000 },
    pro_plus: { monthly: 6000, yearly: 60000, credits: 100000 },
    ultra: { monthly: 20000, yearly: 200000, credits: 400000 }
  };
  for (const [id, expected] of Object.entries(planAmounts)) {
    const card = html.split('<article').slice(1)
      .map(piece => '<article' + piece.split('</article>')[0] + '</article>')
      .find(piece => piece.includes('data-plan="' + id + '"'));
    assert.ok(card, 'plan ' + id + ' not found in billing HTML');
    assert.match(card, new RegExp('data-month="' + expected.monthly / 100 + '"'));
    assert.match(card, new RegExp('data-year="' + expected.yearly / 100 + '"'));
    assert.ok(card.includes(expected.credits.toLocaleString('en-US') + ' Credits'));
    assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('PLAN_PRICE_AMOUNTS', subscriptions)[id])), {
      monthly: expected.monthly, yearly: expected.yearly
    });
    assert.equal(vm.runInContext('PLAN_CREDITS', webhook)[id], expected.credits);
  }
  const packs = {
    mini: { amount: 500, credits: 10000 },
    basic: { amount: 2000, credits: 50000 },
    pro: { amount: 3500, credits: 100000 },
    business: { amount: 15000, credits: 500000 }
  };
  for (const [id, expected] of Object.entries(packs)) {
    const card = html.split('<article').slice(1)
      .map(piece => '<article' + piece.split('</article>')[0] + '</article>')
      .find(piece => piece.includes('data-pack="' + id + '"'));
    assert.ok(card, 'pack ' + id + ' missing');
    assert.ok(card.includes('
    assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('PACKS', packCheckout)[id])), {
      name: vm.runInContext('PACKS', packCheckout)[id].name,
      ...expected
    });
    assert.equal(vm.runInContext('CREDIT_PACKS', webhook)[id].amount, expected.amount);
    assert.equal(vm.runInContext('CREDIT_PACKS', webhook)[id].credits, expected.credits);
  }
});
 + expected.amount / 100));
    assert.ok(card.includes(expected.credits.toLocaleString('en-US') + ' Credits'));
    assert.deepEqual(JSON.parse(JSON.stringify(packCheckout.PACKS[id])), {
      name: packCheckout.PACKS[id].name,
      ...expected
    });
    assert.equal(webhook.CREDIT_PACKS[id].amount, expected.amount);
    assert.equal(webhook.CREDIT_PACKS[id].credits, expected.credits);
  }
});
