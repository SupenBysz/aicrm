import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production P2A graph owns every reviewed dependency while Bridge readiness stays independent", async () => {
  const source = await readFile(
    new URL("./desktop-codex-authorization-main.ts", import.meta.url),
    "utf8"
  );
  for (const dependency of [
    "DesktopAuthorizationTransportClient",
    "DesktopActivationLeaseFenceStore",
    "DesktopExecutorBindingStateStore",
    "DesktopTrustedTokenKeyringClient",
    "DesktopCodexAuthorizationEventBroadcaster",
    "DesktopCodexAppServerSupervisor",
    "DesktopCodexAuthorizationReconciler",
    "DesktopCodexAuthorizationSessionStore",
    "DesktopCodexExactRecoveryArtifactInspector",
    "DesktopCodexAuthorizationOrchestrator",
    "DesktopCodexAuthorizationRecoveryCoordinator"
  ]) {
    assert.match(source, new RegExp(`new ${dependency}\\(`));
  }
  assert.match(source, /await trust\.requestFenceReady/);
  assert.match(source, /initializeCredentials: \(\) => credentials\.initialize\(\)/);
  assert.match(source, /recoverOnStartup: \(\) => recoveryCoordinator\.recoverOnStartup\(\)/);
  assert.match(source, /resume: \(record\) => orchestrator\.resume\(record\)/);
  assert.match(source, /shutdownRuntime: \(\) => orchestrator\.shutdown\(\)/);
  assert.doesNotMatch(source, /CODEX_DESKTOP_AUTHORIZATION_RUNTIME_READY\s*=\s*true/);
  assert.doesNotMatch(source, /AI_EXECUTOR_DESKTOP_HANDOFF_READY\s*=\s*true/);
});

test("production graph keeps secrets and paths Main-only and publishes only safe events", async () => {
  const source = await readFile(
    new URL("./desktop-codex-authorization-main.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /credentials\.mainOnlyResolvePath/);
  assert.match(source, /shell\.openExternal\(authUrl\)/);
  assert.match(source, /IPC_CHANNELS\.codexAuthorizationChanged, event/);
  assert.doesNotMatch(source, /console\.(?:log|debug|info|warn|error)/);
  assert.doesNotMatch(source, /webContents\.send\([^\n]*(?:token|authUrl|codexHome|loginId)/i);
});

test("index creates P2A services only inside app readiness and awaits one shutdown fence", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const ready = source.indexOf("app.whenReady().then(() => {");
  const create = source.indexOf(
    "desktopCodexAuthorizationServices = getDesktopCodexAuthorizationMainServices();"
  );
  assert.ok(ready >= 0 && create > ready);
  assert.match(source, /desktopCodexAuthorizationServices\.initialize\(\)\.catch/);
  assert.match(source, /app\.on\("before-quit", \(event\) =>/);
  assert.match(source, /desktopCodexQuitFence\?\.handleBeforeQuit\(event\)/);
  assert.match(source, /shutdown: \(\) => desktopCodexAuthorizationServices!\.shutdown\(\)/);
  assert.match(source, /quit: \(\) => app\.quit\(\)/);
  assert.match(source, /registerCodexExecutorIpc\(\);/);
});
