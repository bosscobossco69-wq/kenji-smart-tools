import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Firestore client rules deny every read and write", async () => {
  const rules = await readFile(new URL("../firestore.rules", import.meta.url), "utf8");
  assert.match(rules, /match\s+\/\{document=\*\*\}/);
  assert.match(rules, /allow\s+read\s*,\s*write\s*:\s*if\s+false\s*;/);
  assert.doesNotMatch(rules, /allow\s+(get|list|create|update|delete)\s*:/);
  assert.doesNotMatch(rules, /request\.auth\.uid/);
});
