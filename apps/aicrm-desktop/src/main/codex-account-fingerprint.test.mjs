import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { codexAccountFingerprint } from "./codex-account-fingerprint.ts";

const fixturePath = path.resolve(
  process.cwd(),
  "../../docs/testdata/aicrm_account_fingerprint_vectors.json"
);

test("Desktop consumes the locked cross-runtime account fingerprint vectors", async () => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.algorithm, "sha256(trim(type)+LF+lowercase(trim(email)))");
  for (const vector of fixture.vectors) {
    assert.equal(
      codexAccountFingerprint({ type: vector.type, email: vector.email }),
      vector.digest,
      vector.name
    );
  }
});

test("plan changes do not alter identity while missing or ambiguous fields fail closed", () => {
  const account = { type: "chatgpt", email: "User@Example.COM", planType: "plus" };
  const plus = codexAccountFingerprint(account);
  const enterprise = codexAccountFingerprint({ ...account, planType: "enterprise" });
  assert.equal(plus, enterprise);
  for (const value of [
    { type: "chatgpt", email: null },
    { type: "chatgpt\nother", email: "user@example.com" },
    { type: "chatgpt", email: "user@example.com\nother" },
    { type: " ", email: "user@example.com" }
  ]) {
    assert.throws(() => codexAccountFingerprint(value));
  }
});
