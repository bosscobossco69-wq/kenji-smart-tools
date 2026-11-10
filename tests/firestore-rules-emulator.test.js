import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

const projectId = process.env.FIREBASE_PROJECT_ID || "demo-kenji-sandbox";
let testEnv;

before(async () => {
  const rules = await readFile(new URL("../firestore.rules", import.meta.url), "utf8");
  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: { host: "127.0.0.1", port: 8080, rules }
  });
});

after(async () => {
  await testEnv?.cleanup();
});

const protectedDocuments = [
  ["users", "alice"],
  ["paymentOrders", "order-1"],
  ["paymentIdempotency", "request-1"],
  ["paymentEvents", "event-1"],
  ["creditBalances", "alice"],
  ["creditLedger", "grant-1"],
  ["creditSpendRequests", "spend-1"],
  ["refundReceipts", "refund-1"],
  ["disputeEvents", "dispute-1"],
  ["paymentOrderEvents", "order-event-1"],
  ["plans", "credits-pack-1"]
];

for (const [collection, id] of protectedDocuments) {
  test(`Firestore denies unauthenticated reads and writes to ${collection}/${id}`, async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    const ref = doc(db, collection, id);
    await assertFails(getDoc(ref));
    await assertFails(setDoc(ref, { attackerControlled: true }));
    await assertFails(updateDoc(ref, { attackerControlled: true }));
    await assertFails(deleteDoc(ref));
  });

  test(`Firestore denies authenticated reads and writes to ${collection}/${id}`, async () => {
    const db = testEnv.authenticatedContext("alice", { email_verified: true }).firestore();
    const ref = doc(db, collection, id);
    await assertFails(getDoc(ref));
    await assertFails(setDoc(ref, { attackerControlled: true }));
    await assertFails(updateDoc(ref, { attackerControlled: true }));
    await assertFails(deleteDoc(ref));
  });
}
