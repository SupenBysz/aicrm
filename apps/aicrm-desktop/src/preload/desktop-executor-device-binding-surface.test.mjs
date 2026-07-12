import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("preload exposes only aiExecutor.bindDevice and Main injects the existing trust singleton", async () => {
  const [constants, types, bridge, main, ipc] = await Promise.all([
    readFile(new URL("../shared/constants.ts", import.meta.url), "utf8"),
    readFile(new URL("./types.ts", import.meta.url), "utf8"),
    readFile(new URL("./bridge.ts", import.meta.url), "utf8"),
    readFile(new URL("../main/index.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../main/ipc/desktop-executor-device-binding-ipc.ts", import.meta.url),
      "utf8"
    )
  ]);

  assert.match(constants, /aiExecutorBindDevice:\s*"ai-executor:bind-device"/);
  assert.match(types, /aiExecutor:\s*\{[\s\S]*bindDevice:\s*\([\s\S]*AiExecutorBindDeviceInput/);
  assert.match(
    bridge,
    /bindDevice:\s*\(input\)\s*=>\s*ipcRenderer\.invoke\(IPC_CHANNELS\.aiExecutorBindDevice, input\)/
  );
  assert.equal((main.match(/getDesktopDeviceTrustMainServices\(\)/g) ?? []).length, 1);
  assert.equal(main.includes("getDesktopDeviceTrustRuntime"), false);
  assert.match(
    main,
    /registerDesktopExecutorDeviceBindingIpc\([\s\S]*desktopDeviceTrustServices\.executorDeviceBindingClient/
  );
  assert.equal(ipc.includes("getDesktopDeviceTrustMainServices"), false);
  assert.equal(ipc.includes("new DesktopDeviceIdentityStore"), false);
  assert.equal(ipc.includes("new DesktopDeviceRequestLane"), false);

  for (const source of [types, bridge, ipc]) {
    for (const forbidden of ["privateKey", "apiBaseUrl", "authorizationToken", "requestReference", "requestHash"]) {
      assert.equal(source.includes(forbidden), false, `${forbidden} leaked into public surface`);
    }
  }
});
