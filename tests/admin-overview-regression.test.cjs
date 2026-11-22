const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

test("admin overview references mapped payment categories, not removed legacy helper",()=>{
  const source=readFileSync(join(__dirname,"..","api","website-orders-admin.js"),"utf8");
  assert.ok(!source.includes("isPaid(o.status)"),"old isPaid helper would throw at runtime");
  assert.equal((source.match(/category:orderCategory\(x\.status\)/g)||[]).length,2);
  assert.ok(source.includes('time:o.category==="paid"?'));
});
