import assert from "node:assert/strict";
import test from "node:test";
import {
  getAiExecutorDesktopTrustBridge,
  installAiExecutorDesktopPort
} from "./ai-executor-desktop.ts";

const trustBridge = {
  async ensureRegistration() {
    return {
      ok: true,
      data: {
        status: "registered",
        deviceId: "a".repeat(64),
        registrationStatus: "registered",
        errorCode: null,
        updatedAt: "2026-07-13T11:00:00.000Z",
        backendRebindRequired: false,
        message: "registered"
      }
    };
  },
  async bindExecutorDevice(input) {
    return {
      ok: true,
      data: {
        binding: {
          executorId: input.executorId,
          deviceId: "a".repeat(64),
          status: "active",
          revision: input.expectedRevision + 1,
          force: false,
          updatedAt: "2026-07-13T11:00:01.000Z"
        },
        replayed: false
      }
    };
  }
};

function port(isDesktopRuntime, bridge) {
  return {
    isDesktopRuntime: () => isDesktopRuntime,
    getAuthorizationBridge: () => null,
    getTrustBridge: () => bridge
  };
}

test("Core exposes trust only through the installed Desktop port and restores disposal state", async () => {
  assert.equal(getAiExecutorDesktopTrustBridge(), null);

  const disposeBrowser = installAiExecutorDesktopPort(port(false, trustBridge));
  assert.equal(getAiExecutorDesktopTrustBridge(), null);

  const disposeMissing = installAiExecutorDesktopPort(port(true, null));
  assert.equal(getAiExecutorDesktopTrustBridge(), null);

  const disposeDesktop = installAiExecutorDesktopPort(port(true, trustBridge));
  const installed = getAiExecutorDesktopTrustBridge();
  assert.equal(installed, trustBridge);
  assert.equal((await installed.ensureRegistration()).data.status, "registered");
  assert.equal(
    (await installed.bindExecutorDevice({ executorId: "executor_1", expectedRevision: 0 }))
      .data.binding.revision,
    1
  );

  disposeDesktop();
  assert.equal(getAiExecutorDesktopTrustBridge(), null);
  disposeMissing();
  assert.equal(getAiExecutorDesktopTrustBridge(), null);
  disposeBrowser();
  assert.equal(getAiExecutorDesktopTrustBridge(), null);
});
