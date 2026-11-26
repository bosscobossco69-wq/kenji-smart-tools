import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const configuration = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
const redirects = configuration.redirects || [];
const known = ["/", "/tip-calculator.html", "/ai-customer-reply.html", "/website-services.html"];
test("public SEO pages on the Vercel alias redirect permanently to primary domain", () => {
  for (const source of known) {
    const rule = redirects.find(item => item.source === source);
    assert.ok(rule, `Missing redirect for ${source}`);
    assert.equal(rule.destination, `https://kenjismarttools.com${source}`);
    assert.equal(rule.permanent, true);
    assert.deepEqual(rule.has, [{ type: "host", value: "kenji-smart-tools.vercel.app" }]);
  }
});
test("domain canonicalization never touches payment and auth routes", () => {
  for (const rule of redirects) {
    assert.ok(!rule.source.startsWith("/api/"), "Never redirect Stripe/Telegram API requests");
    assert.ok(!rule.source.startsWith("/workspace/"), "Never redirect Firebase login or billing routes");
    assert.ok(!rule.source.includes("*") && !rule.source.includes(":"), "Only explicit safe paths");
    assert.ok(rule.destination.startsWith("https://kenjismarttools.com/"));
    assert.ok(rule.has?.some(h => h.type === "host" && h.value === "kenji-smart-tools.vercel.app"));
  }
});
test("canonical root and sitemap contain only primary domain", () => {
  const sitemap = readFileSync(new URL("../sitemap.xml", import.meta.url), "utf8");
  assert.ok(sitemap.includes("https://kenjismarttools.com/tip-calculator.html"));
  assert.ok(!sitemap.includes("kenji-smart-tools.vercel.app"));
  const tip = readFileSync(new URL("../tip-calculator.html", import.meta.url), "utf8");
  assert.match(tip, /rel="canonical" href="https:\/\/kenjismarttools.com\/tip-calculator.html"/);
});
