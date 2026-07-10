import assert from "node:assert/strict";
import test from "node:test";
import {
  getLegacyCredentialAdapterSubstitution,
  getMatrixAccountScriptPolicyViolation
} from "./matrix-account-script-policy.ts";

test("account_detect rejects storage and IndexedDB reads", () => {
  for (const step of [
    { action: "readStorage", storage: "cookie", key: "sessionid" },
    { action: "readStorage", storage: "localStorage", key: "uid_tt" },
    { action: "readIndexedDB", database: "account", store: "session" }
  ]) {
    const violation = getMatrixAccountScriptPolicyViolation("account_detect", {
      version: 1,
      purpose: "account_detect",
      steps: [step]
    });
    assert.equal(violation?.code, "sensitive_method_forbidden");
  }
});

test("account_detect permits public page text and QR flows retain existing DSL compatibility", () => {
  assert.equal(
    getMatrixAccountScriptPolicyViolation("account_detect", {
      version: 1,
      purpose: "account_detect",
      steps: [{ action: "readText", selector: "[data-account-id]", resultKey: "platformUid" }]
    }),
    null
  );
  assert.equal(
    getMatrixAccountScriptPolicyViolation("qr_login_prepare", {
      version: 1,
      purpose: "qr_login_prepare",
      steps: [{ action: "readStorage", storage: "sessionStorage", key: "legacy-qr-state" }]
    }),
    null
  );
});

test("known legacy credential adapter is substituted only by exact version, hash and unexpired deadline", () => {
  const dsl = {
    purpose: "account_detect",
    steps: [
      { resultKey: "platformUid", storage: "cookie", key: "uid_tt", action: "readStorage" },
      { storage: "cookie", action: "readStorage", resultKey: "identityKey", key: "sessionid" },
      { key: "all", resultKey: "profileText", action: "readStorage", storage: "localStorage" }
    ],
    version: 1
  };
  const versionId = "malsv_643d906e3d4d52c6f30e31258e29a062";
  assert.equal(
    getLegacyCredentialAdapterSubstitution(versionId, dsl, Date.parse("2026-07-10T19:40:00+08:00"))?.reasonCode,
    "legacy_credential_adapter_substituted"
  );
  assert.equal(getLegacyCredentialAdapterSubstitution("malsv_other", dsl, Date.parse("2026-07-10T19:40:00+08:00")), null);
  assert.equal(
    getLegacyCredentialAdapterSubstitution(versionId, { ...dsl, steps: [...dsl.steps, { action: "readStorage", storage: "cookie", key: "token" }] }, Date.parse("2026-07-10T19:40:00+08:00")),
    null
  );
  assert.equal(getLegacyCredentialAdapterSubstitution(versionId, dsl, Date.parse("2026-08-01T00:00:00+08:00")), null);
});
