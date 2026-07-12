import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import { submitAccountOnboardingStepResultRequest } from "./api.ts";
import {
  installMatrixAccountDesktopPort,
  isAiCrmDesktopClientRuntime,
  subscribeMatrixAccountOnboarding
} from "../../../../packages/ky-admin-core/src/matrix-account-desktop.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const publicBoundaryFiles = [
  "apps/aicrm-desktop/src/shared/types.ts",
  "apps/aicrm-desktop/src/preload/types.ts",
  "apps/aicrm-desktop/src/preload/bridge.ts",
  "apps/aicrm-desktop/src/main/ipc/matrix-account-ipc.ts",
  "packages/ky-admin-core/src/matrix-account-desktop.ts",
  "plugins/ky-matrix-account/src/account-onboarding/types.ts",
  "plugins/ky-matrix-account/src/account-onboarding/service.ts"
];
const forbiddenPublicPatterns = [
  /\bverificationReceipt\b/,
  /\bsnapshotVerificationReceipt\b/,
  /\btrustedReceipt\b/,
  /\breceiptSecret\b/,
  /\bsnapshotProof\b/,
  /\bcleanupProof\b/,
  /\bproof\b/i
];

test("Renderer-facing bridge, Core and Plugin contracts expose summaries only", async () => {
  for (const relativePath of publicBoundaryFiles) {
    const source = await readFile(path.join(repositoryRoot, relativePath), "utf8");
    for (const pattern of forbiddenPublicPatterns) {
      assert.doesNotMatch(source, pattern, `${relativePath} contains ${pattern}`);
    }
  }
});

test("production automation gates stay closed and no Renderer completion facade is exported", async () => {
  const desktopIpc = await readFile(
    path.join(repositoryRoot, "apps/aicrm-desktop/src/main/ipc/matrix-account-ipc.ts"),
    "utf8"
  );
  assert.match(desktopIpc, /supportsSessionDetection:\s*false/);
  assert.match(desktopIpc, /supportsServerVerifiableSnapshotReceipts:\s*false/);

  for (const relativePath of [
    "plugins/ky-matrix-account/src/account-onboarding/api.ts",
    "plugins/ky-matrix-account/src/account-onboarding/service.ts",
    "plugins/ky-matrix-account/src/account-onboarding/types.ts"
  ]) {
    const source = await readFile(path.join(repositoryRoot, relativePath), "utf8");
    assert.doesNotMatch(source, /\bcompleteAccountOnboarding(?:Request)?\b/);
  }
});

test("Host is the sole preload bridge reader and Core consumes an injected Desktop Port", async () => {
  for (const relativePath of [
    "packages/ky-admin-core/src/matrix-account-desktop.ts",
    "plugins/ky-ai-configuration/src/pages/executor-tasks-page.tsx",
    "plugins/ky-matrix-account/src/account-onboarding/service.ts",
    "plugins/ky-matrix-account/src/pages/matrix-accounts-page.tsx"
  ]) {
    const source = await readFile(path.join(repositoryRoot, relativePath), "utf8");
    assert.doesNotMatch(
      source,
      /window\.aicrm\b|\)\.aicrm\b|\baicrm\?\s*:/,
      `${relativePath} reads the preload bridge directly`
    );
  }

  const hostAdapter = await readFile(
    path.join(repositoryRoot, "apps/ky-admin-host/src/desktop-client.ts"),
    "utf8"
  );
  const hostEntry = await readFile(path.join(repositoryRoot, "apps/ky-admin-host/src/main.tsx"), "utf8");
  assert.match(hostAdapter, /window\.aicrm/);
  assert.match(hostEntry, /installMatrixAccountDesktopPort\(matrixAccountDesktopPort\)/);
});

test("injected onboarding subscription registers once, filters sequence and disposes once", () => {
  let nativeListener;
  let subscribeCount = 0;
  let disposeCount = 0;
  const uninstall = installMatrixAccountDesktopPort({
    isDesktopRuntime: () => true,
    getDebugMode: async () => false,
    getAiExecutorBridge: () => null,
    getMatrixAccountBridge: () => ({
      onAccountOnboardingEvent(listener) {
        subscribeCount += 1;
        nativeListener = listener;
        return () => {
          disposeCount += 1;
        };
      }
    })
  });
  const received = [];
  const unsubscribe = subscribeMatrixAccountOnboarding("attempt-1", 3, (event) => received.push(event.sequence));

  nativeListener?.({ attemptId: "attempt-2", sequence: 4 });
  nativeListener?.({ attemptId: "attempt-1", sequence: 3 });
  nativeListener?.({ attemptId: "attempt-1", sequence: 4 });
  nativeListener?.({ attemptId: "attempt-1", sequence: 4 });
  nativeListener?.({ attemptId: "attempt-1", sequence: 5 });
  unsubscribe();
  uninstall();

  assert.equal(subscribeCount, 1);
  assert.equal(disposeCount, 1);
  assert.deepEqual(received, [4, 5]);
  assert.equal(isAiCrmDesktopClientRuntime(), false);
});

test("ordinary step-result requests strip nested trust material", async () => {
  let requestBody;
  const client = {
    async request(_path, options) {
      requestBody = options.body;
      return activeAttempt();
    }
  };

  await submitAccountOnboardingStepResultRequest(client, "attempt-1", {
    operationId: "operation-1",
    methodKey: "login.status.probe.v1",
    status: "success",
    observedPhase: "authenticated",
    resultSummary: {
      phase: "authenticated",
      verificationReceipt: "secret-verification",
      nested: {
        proof: "secret-snapshot",
        receiptSecret: "secret-receipt",
        safe: "visible"
      }
    },
    verificationReceipt: "secret-top-level",
    proof: "secret-top-level-proof"
  });

  assert.deepEqual(requestBody, {
    operationId: "operation-1",
    methodKey: "login.status.probe.v1",
    status: "success",
    observedPhase: "authenticated",
    resultSummary: {
      phase: "authenticated",
      nested: { safe: "visible" }
    },
    errorCode: undefined,
    errorMessage: undefined,
    durationMs: undefined
  });
  assert.doesNotMatch(JSON.stringify(requestBody), /secret-/);
});

test("ordinary Renderer requests cannot complete trusted snapshot or cleanup steps", async () => {
  const client = {
    async request() {
      throw new Error("request_must_not_be_sent");
    }
  };
  const trustedOnly = [
    "business.onboarding.complete.v1",
    "session.snapshot.seal.v1",
    "web_space.cleanup.v1"
  ];
  for (const methodKey of trustedOnly) {
    await assert.rejects(
      async () =>
        submitAccountOnboardingStepResultRequest(client, "attempt-1", {
          operationId: `operation-${methodKey}`,
          methodKey,
          status: "success",
          resultSummary: {}
        }),
      /trusted_runtime_step_required/
    );
  }
});

function activeAttempt() {
  return {
    id: "attempt-1",
    platform: "douyin",
    status: "active",
    phase: "waiting_scan",
    activity: "waiting_user",
    currentStep: "login.status.probe.v1",
    qrRevision: 1,
    sequence: 1,
    nextActions: ["wait"],
    expiresAt: null,
    createdAt: "2026-07-12T00:00:00Z",
    updatedAt: "2026-07-12T00:00:00Z"
  };
}
