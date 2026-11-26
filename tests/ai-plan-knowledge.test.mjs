import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../api/generate-reply.js", import.meta.url), "utf8");
const billing = readFileSync(new URL("../workspace/billing.html", import.meta.url), "utf8");
const stripe = readFileSync(new URL("../api/stripe-checkout.js", import.meta.url), "utf8");
const packs = readFileSync(new URL("../api/stripe-credit-checkout.js", import.meta.url), "utf8");

test("KENJI public AI knowledge matches existing published Pro subscription and checkout guards", () => {
  assert.match(source, /Pro \$20\/month or \$200\/year with 30,000 Credits\/month/);
  assert.match(billing, /data-month="20" data-year="200"/);
  assert.match(billing, /30,000 Credits \/ month/);
  assert.match(stripe, /pro: \{ monthly: 2000, yearly: 20000 \}/);
});
test("Public AI product knowledge accurately distinguishes available and future features", () => {
  assert.match(source, /Future roadmap, not currently included in any purchase/);
  assert.match(source, /Never claim these are live Pro features/);
  assert.match(source, /Only apply these KENJI facts when the conversation concerns KENJI products/);
  assert.match(source, /\+ KENJI_PUBLIC_PLAN_KNOWLEDGE/);
});
test("One-time pack values match server Stripe credit purchase definitions", () => {
  for (const [name, dollars, credits, cents] of [
    ["Mini", 5, 10000, 500], ["Basic", 20, 50000, 2000],
    ["Pro Pack", 35, 100000, 3500], ["Business Pack", 150, 500000, 15000]
  ]) {
    assert.ok(source.includes(`${name} $${dollars} for ${credits.toLocaleString("en-US")} Credits`));
    assert.ok(packs.includes(`amount: ${cents}, credits: ${credits}`));
  }
});
