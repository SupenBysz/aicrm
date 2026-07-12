import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  session as electronSession,
  type IpcMainInvokeEvent,
  type NativeImage,
  type Rectangle,
  type Session
} from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import { closeControlledWindow, controlledWindowReleaseMode } from "../controlled-window-release";
import { MatrixAccountOnboardingCoordinator } from "../matrix-account-onboarding-coordinator";
import { resolveMatrixAccountScriptExecutionDecision } from "../matrix-account-script-policy";
import {
  MatrixAccountSessionVault,
  SessionVaultError,
  type MatrixAccountSessionFingerprint,
  type MatrixAccountSessionSnapshotManifest,
  type MatrixAccountSessionSnapshotVerification,
  type MatrixAccountSessionVaultScope
} from "../matrix-account-session-vault";
import type {
  DesktopCommandResult,
  MatrixAccountLoginScriptDsl,
  MatrixAccountLoginScriptPurpose,
  MatrixAccountLoginScriptStep,
  MatrixAccountBrowserInput,
  MatrixAccountBrowserResult,
  MatrixAccountCapabilities,
  MatrixAccountCheckResult,
  MatrixAccountClearProfileResult,
  MatrixAccountLoginStatePayload,
  MatrixAccountOnboardingCancelInput,
  MatrixAccountOnboardingLookupInput,
  MatrixAccountOnboardingQrInput,
  MatrixAccountOnboardingRefreshQrInput,
  MatrixAccountOnboardingStartInput,
  MatrixAccountPlatform,
  MatrixAccountSessionSnapshotRestoreInput,
  MatrixAccountSessionSnapshotRestoreResult,
  MatrixAccountSessionSnapshotSealInput,
  MatrixAccountSessionSnapshotVerificationResult,
  MatrixAccountSessionSnapshotVerifyInput,
  MatrixAccountSessionWebSpaceCleanupInput,
  MatrixAccountSessionWebSpaceCleanupResult,
  MatrixAccountWebSpaceBrowserResult,
  MatrixAccountWebSpaceClearResult,
  MatrixAccountWebSpaceDetectResult,
  MatrixAccountWebSpaceInput,
  MatrixAccountWebSpaceScriptInput,
  MatrixAccountWebSpaceScriptResult,
  MatrixAccountWebSpaceSnapshotInput,
  MatrixAccountWebSpaceSnapshotResult,
  MatrixAccountWebSpaceStatePayload
} from "../../shared/types";

const controlledWindows = new Map<string, BrowserWindow>();
const webSpaceWindowPartitions = new Set<string>();
const releasingWindowPartitions = new Set<string>();
const lockedSessionFingerprintByPartition = new Map<string, MatrixAccountSessionFingerprint>();
const matrixAccountDebugLogPath = "/tmp/aicrm-matrix-cdp-debug.log";
const matrixAccountDebugLogMaxBytes = 5 * 1024 * 1024;

const loginUrls: Record<MatrixAccountPlatform, string> = {
  douyin: "https://creator.douyin.com/",
  kuaishou: "https://cp.kuaishou.com/",
  xiaohongshu: "https://creator.xiaohongshu.com/"
};

const capabilities: MatrixAccountCapabilities = {
  bridgeVersion: 1,
  supportsControlledBrowser: true,
  supportsProfileIsolation: true,
  supportsSessionDetection: false,
  supportsCloudSessionVault: false,
  supportsAccountOnboarding: true,
  supportsSessionSnapshotVault: true,
  supportsServerVerifiableSnapshotReceipts: false,
  supportsDeferredWindowRelease: true
};

const onboardingCoordinator = new MatrixAccountOnboardingCoordinator({
  openLogin: (event, input) => openControlledWebSpace(event, input, true),
  refreshQr: refreshControlledWebSpaceQr,
  cancel: clearControlledWebSpace
});

let sessionVault: MatrixAccountSessionVault;

export function registerMatrixAccountIpc(): void {
  sessionVault = new MatrixAccountSessionVault({
    vaultRoot: path.join(app.getPath("userData"), "matrix-account-session-vault")
  });
  ipcMain.handle(IPC_CHANNELS.matrixAccountGetCapabilities, (): DesktopCommandResult<MatrixAccountCapabilities> => {
    return ok(capabilities);
  });

  ipcMain.handle(IPC_CHANNELS.matrixAccountStartOnboarding, (event, input: MatrixAccountOnboardingStartInput) => {
    return onboardingCoordinator.start(event, input);
  });

  ipcMain.handle(IPC_CHANNELS.matrixAccountGetOnboarding, (_event, input: MatrixAccountOnboardingLookupInput) => {
    return onboardingCoordinator.get(input);
  });

  ipcMain.handle(IPC_CHANNELS.matrixAccountGetOnboardingQrCode, (_event, input: MatrixAccountOnboardingQrInput) => {
    return onboardingCoordinator.getQr(input);
  });

  ipcMain.handle(IPC_CHANNELS.matrixAccountRefreshOnboardingQrCode, (_event, input: MatrixAccountOnboardingRefreshQrInput) => {
    return onboardingCoordinator.refreshQr(input);
  });

  ipcMain.handle(IPC_CHANNELS.matrixAccountCancelOnboarding, (_event, input: MatrixAccountOnboardingCancelInput) => {
    return onboardingCoordinator.cancel(input);
  });

  ipcMain.handle(
    IPC_CHANNELS.matrixAccountSealSessionSnapshot,
    async (_event, input: MatrixAccountSessionSnapshotSealInput) => sealOnboardingSessionSnapshot(input)
  );

  ipcMain.handle(
    IPC_CHANNELS.matrixAccountVerifySessionSnapshot,
    async (_event, input: MatrixAccountSessionSnapshotVerifyInput) => verifyOnboardingSessionSnapshot(input)
  );

  ipcMain.handle(
    IPC_CHANNELS.matrixAccountRestoreSessionSnapshot,
    async (_event, input: MatrixAccountSessionSnapshotRestoreInput) => restoreOnboardingSessionSnapshot(input)
  );

  ipcMain.handle(
    IPC_CHANNELS.matrixAccountCleanupSessionWebSpace,
    async (_event, input: MatrixAccountSessionWebSpaceCleanupInput) => cleanupOnboardingSessionWebSpace(input)
  );

  ipcMain.handle(IPC_CHANNELS.matrixAccountStartLogin, (event, input: MatrixAccountBrowserInput) => {
    return openControlledBrowser(event, input, true);
  });

  ipcMain.handle(IPC_CHANNELS.matrixAccountOpenAccount, (event, input: MatrixAccountBrowserInput) => {
    return openControlledBrowser(event, input, false);
  });

  ipcMain.handle(IPC_CHANNELS.matrixAccountCheckSession, (_event, input: MatrixAccountBrowserInput) => {
    const validated = validateInput(input);
    if (!validated.ok) return validated;
    const browserPartition = matrixAccountPartition(input);
    return ok<MatrixAccountCheckResult>({
      accountId: input.accountId,
      platform: input.platform,
      browserPartition,
      loginStatus: "unknown",
      canDetect: false
    });
  });

  ipcMain.handle(IPC_CHANNELS.matrixAccountClearProfile, async (_event, input: MatrixAccountBrowserInput) => {
    const validated = validateInput(input);
    if (!validated.ok) return validated;
    const browserPartition = matrixAccountPartition(input);
    const existing = controlledWindows.get(browserPartition);
    if (existing && !existing.isDestroyed()) {
      existing.close();
    }
    controlledWindows.delete(browserPartition);
    await electronSession.fromPartition(browserPartition).clearStorageData();
    return ok<MatrixAccountClearProfileResult>({
      accountId: input.accountId,
      platform: input.platform,
      browserPartition,
      cleared: true
    });
  });

  ipcMain.handle(IPC_CHANNELS.matrixAccountCreateWebSpaceLogin, async (event, input: MatrixAccountWebSpaceInput) => {
    return openControlledWebSpace(event, input, true);
  });

  ipcMain.handle(IPC_CHANNELS.matrixAccountOpenWebSpace, async (event, input: MatrixAccountWebSpaceInput) => {
    return openControlledWebSpace(event, input, false);
  });

  ipcMain.handle(IPC_CHANNELS.matrixAccountDetectWebSpaceAccount, async (_event, input: MatrixAccountWebSpaceInput) => {
    const validated = validateWebSpaceInput(input);
    if (!validated.ok) return validated;
    const browserPartition = webSpacePartition(input);
    const browser = controlledWindows.get(browserPartition);
    if (!browser || browser.isDestroyed()) {
      return ok<MatrixAccountWebSpaceDetectResult>({
        webSpaceId: input.webSpaceId,
        platform: input.platform,
        browserPartition,
        loginStatus: "unknown",
        canDetect: false,
        reason: "受控浏览器窗口未打开，请先重新打开登录空间"
      });
    }
    if (controlledWindowReleaseMode({ releaseWindowOnDetect: input.releaseWindowOnDetect, hasDetectedIdentity: false }) === "before_detect") {
      const released = await releaseControlledWindow(browserPartition);
      if (!released) return fail("web_space_window_release_failed", "受控浏览器窗口关闭失败");
      return ok<MatrixAccountWebSpaceDetectResult>({
        webSpaceId: input.webSpaceId,
        platform: input.platform,
        browserPartition,
        loginStatus: "unknown",
        canDetect: false,
        windowReleased: true,
        reason: "controlled_window_released"
      });
    }
    const candidate = await detectAccountCandidate(browser, input.platform);
    if (
      controlledWindowReleaseMode({
        releaseWindowOnDetect: input.releaseWindowOnDetect,
        hasDetectedIdentity: Boolean(candidate.identityKey)
      }) === "after_detect"
    ) {
      const released = await releaseControlledWindow(browserPartition);
      if (!released) return fail("web_space_window_release_failed", "受控浏览器窗口关闭失败");
    }
    return ok<MatrixAccountWebSpaceDetectResult>({
      webSpaceId: input.webSpaceId,
      platform: input.platform,
      browserPartition,
      loginStatus: candidate.identityKey ? "online" : "unknown",
      canDetect: Boolean(candidate.identityKey),
      ...candidate
    });
  });

  ipcMain.handle(IPC_CHANNELS.matrixAccountClearWebSpace, async (_event, input: MatrixAccountWebSpaceInput) => {
    return clearControlledWebSpace(input);
  });

  ipcMain.handle(IPC_CHANNELS.matrixAccountCaptureWebSpaceSnapshot, async (event, input: MatrixAccountWebSpaceSnapshotInput) => {
    const validated = validateWebSpaceInput(input);
    if (!validated.ok) return validated;
    if (input.includeSensitiveContext === true && !canCaptureSensitiveMatrixDebug(event)) {
      return fail("sensitive_context_forbidden", "敏感登录上下文采集仅允许在显式启用的受信任调试环境中使用");
    }
    const browserPartition = webSpacePartition(input);
    const browser = controlledWindows.get(browserPartition);
    if (!browser || browser.isDestroyed()) {
      return fail("web_space_window_not_open", "受控浏览器窗口未打开");
    }
    return captureWebSpaceSnapshot(browser, input, browserPartition);
  });

  ipcMain.handle(IPC_CHANNELS.matrixAccountRunWebSpaceLoginScript, async (_event, input: MatrixAccountWebSpaceScriptInput) => {
    const validated = validateWebSpaceScriptInput(input);
    if (!validated.ok) return validated;
    const browserPartition = webSpacePartition(input);
    const browser = controlledWindows.get(browserPartition);
    if (!browser || browser.isDestroyed()) {
      return fail("web_space_window_not_open", "受控浏览器窗口未打开");
    }
    return runWebSpaceLoginScript(browser, input, browserPartition);
  });
}

async function sealOnboardingSessionSnapshot(
  input: MatrixAccountSessionSnapshotSealInput
): Promise<DesktopCommandResult<MatrixAccountSessionSnapshotVerificationResult>> {
  const invalid = validateSessionVaultTarget(input, input?.snapshotId);
  if (invalid) return fail(invalid.code, invalid.message);
  const trusted = onboardingCoordinator.beginSessionSnapshotSeal(input);
  if (!trusted.ok || !trusted.data) return copyFailure(trusted);
  const webSpaceInput = trusted.data;
  const browserPartition = webSpacePartition(webSpaceInput);
  const session = electronSession.fromPartition(browserPartition);
  const scope = sessionVaultScope(input.attemptId, webSpaceInput);
  const fingerprint = buildSessionFingerprint(session, webSpaceInput, browserPartition);

  try {
    await suspendControlledWebSpace(browserPartition);
    await flushPersistentSession(session);
    const storagePath = requireSessionStoragePath(session);
    const verification = await sessionVault.seal({
      snapshotId: input.snapshotId,
      sourceStoragePath: storagePath,
      scope,
      fingerprint
    });
    onboardingCoordinator.completeSessionSnapshotSeal(
      input.attemptId,
      verification.manifest.snapshotId,
      input.operationId
    );
    return ok(toSessionSnapshotVerificationResult(verification));
  } catch (error) {
    const known = normalizeSessionVaultError(error, "session_snapshot_seal_failed", "登录态快照封存失败");
    onboardingCoordinator.failSessionSnapshotSeal(input.attemptId, input.operationId, known.code, known.message);
    return fail(known.code, known.message);
  }
}

async function verifyOnboardingSessionSnapshot(
  input: MatrixAccountSessionSnapshotVerifyInput
): Promise<DesktopCommandResult<MatrixAccountSessionSnapshotVerificationResult>> {
  const invalid = validateSessionVaultTarget(input, input?.snapshotId, true);
  if (invalid) return fail(invalid.code, invalid.message);
  const trusted = onboardingCoordinator.resolveTrustedVaultWebSpace(input.attemptId);
  if (!trusted.ok || !trusted.data) return copyFailure(trusted);
  try {
    const verification = await sessionVault.verify({
      snapshotId: input.snapshotId,
      expectedScope: sessionVaultScope(input.attemptId, trusted.data)
    });
    onboardingCoordinator.completeSessionSnapshotSeal(input.attemptId, input.snapshotId);
    return ok(toSessionSnapshotVerificationResult(verification));
  } catch (error) {
    const known = normalizeSessionVaultError(error, "session_snapshot_verify_failed", "登录态快照校验失败");
    return fail(known.code, known.message);
  }
}

async function restoreOnboardingSessionSnapshot(
  input: MatrixAccountSessionSnapshotRestoreInput
): Promise<DesktopCommandResult<MatrixAccountSessionSnapshotRestoreResult>> {
  const invalid = validateSessionVaultTarget(input, input?.snapshotId, true);
  if (invalid) return fail(invalid.code, invalid.message);
  const trusted = onboardingCoordinator.resolveTrustedVaultWebSpace(input.attemptId);
  if (!trusted.ok || !trusted.data) return copyFailure(trusted);
  const webSpaceInput = trusted.data;
  const scope = sessionVaultScope(input.attemptId, webSpaceInput);
  const restoreId = randomUUID();
  const targetBrowserPartition = restoredWebSpacePartition(webSpaceInput, input.snapshotId, restoreId);
  const targetSession = electronSession.fromPartition(targetBrowserPartition);

  try {
    const verified = await sessionVault.verify({ snapshotId: input.snapshotId, expectedScope: scope });
    assertSessionFingerprintCompatible(
      verified.manifest,
      buildSessionFingerprint(targetSession, webSpaceInput, targetBrowserPartition)
    );
    targetSession.setUserAgent(verified.manifest.fingerprint.userAgent);
    const targetStoragePath = requireSessionStoragePath(targetSession);
    await targetSession.clearStorageData();
    await sessionVault.cleanupStoragePath(targetStoragePath);
    const restored = await sessionVault.restore({
      snapshotId: input.snapshotId,
      expectedScope: scope,
      targetStoragePath
    });
    lockedSessionFingerprintByPartition.set(targetBrowserPartition, verified.manifest.fingerprint);
    onboardingCoordinator.switchToRestoredWebSpace(input.attemptId, targetBrowserPartition, input.snapshotId);
    return ok({
      ...toSessionSnapshotVerificationResult(restored),
      restoreId,
      restoredAt: restored.restoredAt
    });
  } catch (error) {
    const known = normalizeSessionVaultError(error, "session_snapshot_restore_failed", "登录态快照恢复失败");
    return fail(known.code, known.message);
  }
}

async function cleanupOnboardingSessionWebSpace(
  input: MatrixAccountSessionWebSpaceCleanupInput
): Promise<DesktopCommandResult<MatrixAccountSessionWebSpaceCleanupResult>> {
  const invalid = validateSessionVaultTarget(input, input?.verifiedSnapshotId, true);
  if (invalid) return fail(invalid.code, invalid.message);
  const trusted = onboardingCoordinator.resolveVerifiedCleanupWebSpace(input);
  if (!trusted.ok || !trusted.data) return copyFailure(trusted);
  const webSpaceInput = trusted.data;
  const browserPartition = webSpacePartition(webSpaceInput);
  const session = electronSession.fromPartition(browserPartition);

  try {
    await sessionVault.verify({
      snapshotId: input.verifiedSnapshotId,
      expectedScope: sessionVaultScope(input.attemptId, webSpaceInput)
    });
    await suspendControlledWebSpace(browserPartition);
    await flushPersistentSession(session);
    const storagePath = requireSessionStoragePath(session);
    const releasedBytes = await sessionVault.measureStoragePath(storagePath);
    await session.clearStorageData();
    await sessionVault.cleanupStoragePath(storagePath);
    lockedSessionFingerprintByPartition.delete(browserPartition);
    return ok({
      attemptId: input.attemptId,
      verifiedSnapshotId: input.verifiedSnapshotId,
      cleared: true,
      releasedBytes,
      cleanedAt: new Date().toISOString()
    });
  } catch (error) {
    const known = normalizeSessionVaultError(error, "web_space_cleanup_failed", "WebSpace 物理清理失败");
    return fail(known.code, known.message);
  }
}

function sessionVaultScope(
  attemptId: string,
  input: MatrixAccountWebSpaceInput
): MatrixAccountSessionVaultScope {
  return {
    attemptId,
    webSpaceId: input.webSpaceId,
    workspaceId: input.workspaceId,
    workspaceType: input.workspaceType,
    platform: input.platform,
    deviceId: input.deviceId || "default"
  };
}

function buildSessionFingerprint(
  session: Session,
  input: MatrixAccountWebSpaceInput,
  browserPartition: string
): MatrixAccountSessionFingerprint {
  const browser = controlledWindows.get(browserPartition);
  let viewport: NonNullable<MatrixAccountSessionFingerprint["viewport"]> = {
    width: 1180,
    height: 820,
    deviceScaleFactor: 1
  };
  try {
    viewport.deviceScaleFactor = screen.getPrimaryDisplay().scaleFactor || 1;
  } catch {
    viewport.deviceScaleFactor = 1;
  }
  if (browser && !browser.isDestroyed()) {
    const bounds = browser.getBounds();
    let deviceScaleFactor = 1;
    try {
      deviceScaleFactor = screen.getDisplayMatching(bounds).scaleFactor || 1;
    } catch {
      deviceScaleFactor = 1;
    }
    viewport = { width: bounds.width, height: bounds.height, deviceScaleFactor };
  }
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron || "unknown",
    chromiumVersion: process.versions.chrome || "unknown",
    operatingSystem: process.platform,
    architecture: process.arch,
    userAgent: session.getUserAgent(),
    locale: app.getLocale() || "unknown",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
    viewport,
    deviceId: input.deviceId || "default"
  };
}

function assertSessionFingerprintCompatible(
  manifest: MatrixAccountSessionSnapshotManifest,
  current: MatrixAccountSessionFingerprint
): void {
  const expected = manifest.fingerprint;
  const incompatible =
    expected.electronVersion !== current.electronVersion ||
    expected.chromiumVersion !== current.chromiumVersion ||
    expected.operatingSystem !== current.operatingSystem ||
    expected.architecture !== current.architecture ||
    expected.locale !== current.locale ||
    expected.timezone !== current.timezone ||
    expected.deviceId !== current.deviceId ||
    (expected.viewport?.deviceScaleFactor ?? 1) !== (current.viewport?.deviceScaleFactor ?? 1);
  if (incompatible) {
    throw new SessionVaultError("snapshot_fingerprint_incompatible", "当前设备运行环境与快照锁定指纹不兼容");
  }
}

function restoredWebSpacePartition(input: MatrixAccountWebSpaceInput, snapshotId: string, restoreId: string): string {
  const restoreScopeHash = createHash("sha256")
    .update(
      [
        input.workspaceType,
        input.workspaceId,
        input.platform,
        input.webSpaceId,
        snapshotId,
        restoreId,
        input.deviceId || "default"
      ].join(":"),
      "utf8"
    )
    .digest("hex")
    .slice(0, 40);
  return `persist:matrix-account-space:restore:${restoreScopeHash}`;
}

function requireSessionStoragePath(session: Session): string {
  if (!session.storagePath) {
    throw new SessionVaultError("web_space_storage_unavailable", "当前 WebSpace 不是可持久化 Session");
  }
  return session.storagePath;
}

function toSessionSnapshotVerificationResult(
  verification: MatrixAccountSessionSnapshotVerification
): MatrixAccountSessionSnapshotVerificationResult {
  const manifest = verification.manifest;
  return {
    snapshotId: manifest.snapshotId,
    schemaVersion: manifest.schemaVersion,
    status: "verified",
    createdAt: manifest.createdAt,
    verifiedAt: verification.verifiedAt,
    contentHash: manifest.archive.contentHash,
    fingerprintHash: manifest.fingerprintHash,
    sizeBytes: manifest.archive.ciphertextBytes,
    sourceBytes: manifest.archive.sourceBytes,
    fileCount: manifest.archive.fileCount
  };
}

function validateSessionVaultTarget(
  input: { attemptId?: string; sessionRef?: unknown } | undefined,
  snapshotId?: string,
  snapshotIdRequired = false
): { code: string; message: string } | null {
  if (!input || typeof input !== "object" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(String(input.attemptId || ""))) {
    return { code: "validation_error", message: "登录流程标识无效" };
  }
  if (snapshotIdRequired && !snapshotId) return { code: "validation_error", message: "快照标识不能为空" };
  if (snapshotId && !/^[a-zA-Z0-9_.:-]{1,160}$/.test(snapshotId)) {
    return { code: "validation_error", message: "快照标识无效" };
  }
  if (input.sessionRef !== undefined && (!input.sessionRef || typeof input.sessionRef !== "object")) {
    return { code: "validation_error", message: "会话引用格式无效" };
  }
  return null;
}

function normalizeSessionVaultError(error: unknown, fallbackCode: string, fallbackMessage: string): SessionVaultError {
  if (error instanceof SessionVaultError) return error;
  return new SessionVaultError(fallbackCode, fallbackMessage);
}

function copyFailure<T>(result: DesktopCommandResult<unknown>): DesktopCommandResult<T> {
  return {
    ok: false,
    error: result.error || { code: "unknown_error", message: "矩阵账号操作失败" },
    requestId: result.requestId
  };
}

function openControlledBrowser(
  event: IpcMainInvokeEvent,
  input: MatrixAccountBrowserInput,
  loginMode: boolean
): DesktopCommandResult<MatrixAccountBrowserResult> {
  const validated = validateInput(input);
  if (!validated.ok) return validated;

  const browserPartition = matrixAccountPartition(input);
  const existing = controlledWindows.get(browserPartition);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return ok({
      accountId: input.accountId,
      platform: input.platform,
      browserPartition,
      loginStatus: loginMode ? "login_pending" : "unknown",
      opened: true
    });
  }

  const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const browser = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    parent,
    title: `${platformLabel(input.platform)}账号`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: browserPartition
    }
  });

  controlledWindows.set(browserPartition, browser);
  browser.on("closed", () => {
    controlledWindows.delete(browserPartition);
    emitLoginState(event, {
      accountId: input.accountId,
      platform: input.platform,
      browserPartition,
      loginStatus: "unknown"
    });
  });

  const targetUrl = input.url || loginUrls[input.platform];
  void browser.loadURL(targetUrl);
  emitLoginState(event, {
    accountId: input.accountId,
    platform: input.platform,
    browserPartition,
    loginStatus: loginMode ? "login_pending" : "unknown"
  });

  return ok({
    accountId: input.accountId,
    platform: input.platform,
    browserPartition,
    loginStatus: loginMode ? "login_pending" : "unknown",
    opened: true
  });
}

async function openControlledWebSpace(
  event: IpcMainInvokeEvent,
  input: MatrixAccountWebSpaceInput,
  loginMode: boolean
): Promise<DesktopCommandResult<MatrixAccountWebSpaceBrowserResult>> {
  const validated = validateWebSpaceInput(input);
  if (!validated.ok) return validated;

  const shouldShowWindow = input.showWindow === true;
  const browserPartition = webSpacePartition(input);
  const existing = controlledWindows.get(browserPartition);
  if (existing && !existing.isDestroyed()) {
    if (shouldShowWindow) {
      existing.setSkipTaskbar(false);
      existing.show();
      existing.focus();
    }
    const qrCode = await extractLoginQrCode(existing, shouldShowWindow ? 1600 : 6000);
    return ok({
      webSpaceId: input.webSpaceId,
      platform: input.platform,
      browserPartition,
      loginStatus: loginMode ? "login_pending" : "unknown",
      opened: true,
      visible: existing.isVisible(),
      qrCodeDataUrl: qrCode.dataUrl,
      qrCodeReason: qrCode.reason,
      qrCodeRecognized: qrCode.recognized,
      qrCodePayloadLength: qrCode.payloadLength,
      qrCodeVerifyReason: qrCode.verifyReason
    });
  }

  const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const lockedFingerprint = lockedSessionFingerprintByPartition.get(browserPartition);
  const lockedViewport = lockedFingerprint?.viewport;
  const browser = new BrowserWindow({
    width: Math.max(960, lockedViewport?.width || 1180),
    height: Math.max(640, lockedViewport?.height || 820),
    minWidth: 960,
    minHeight: 640,
    parent: shouldShowWindow ? parent : undefined,
    show: shouldShowWindow,
    skipTaskbar: !shouldShowWindow,
    title: `${platformLabel(input.platform)}登录空间`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: browserPartition
    }
  });

  controlledWindows.set(browserPartition, browser);
  webSpaceWindowPartitions.add(browserPartition);
  browser.on("close", (event) => {
    if (releasingWindowPartitions.has(browserPartition)) return;
    event.preventDefault();
    browser.hide();
    browser.setSkipTaskbar(true);
  });
  browser.on("closed", () => {
    controlledWindows.delete(browserPartition);
    webSpaceWindowPartitions.delete(browserPartition);
    releasingWindowPartitions.delete(browserPartition);
    emitWebSpaceState(event, {
      webSpaceId: input.webSpaceId,
      platform: input.platform,
      browserPartition,
      loginStatus: "unknown"
    });
  });

  const targetUrl = input.url || loginUrls[input.platform];
  await loadControlledUrl(browser, targetUrl);
  emitWebSpaceState(event, {
    webSpaceId: input.webSpaceId,
    platform: input.platform,
    browserPartition,
    loginStatus: loginMode ? "login_pending" : "unknown"
  });
  const qrCode = await extractLoginQrCode(browser, shouldShowWindow ? 1600 : 9000);

  return ok({
    webSpaceId: input.webSpaceId,
    platform: input.platform,
    browserPartition,
    loginStatus: loginMode ? "login_pending" : "unknown",
    opened: true,
    visible: browser.isVisible(),
    qrCodeDataUrl: qrCode.dataUrl,
    qrCodeReason: qrCode.reason,
    qrCodeRecognized: qrCode.recognized,
    qrCodePayloadLength: qrCode.payloadLength,
    qrCodeVerifyReason: qrCode.verifyReason
  });
}

async function refreshControlledWebSpaceQr(
  input: MatrixAccountWebSpaceInput
): Promise<DesktopCommandResult<MatrixAccountWebSpaceBrowserResult>> {
  const validated = validateWebSpaceInput(input);
  if (!validated.ok) return validated;
  const browserPartition = webSpacePartition(input);
  const browser = controlledWindows.get(browserPartition);
  if (!browser || browser.isDestroyed()) {
    return fail("web_space_window_not_open", "受控浏览器窗口未打开，请重新开始登录流程");
  }
  await loadControlledUrl(browser, loginUrls[input.platform]);
  const qrCode = await extractLoginQrCode(browser, input.showWindow === true ? 2200 : 9000);
  return ok({
    webSpaceId: input.webSpaceId,
    platform: input.platform,
    browserPartition,
    loginStatus: "login_pending",
    opened: true,
    visible: browser.isVisible(),
    qrCodeDataUrl: qrCode.dataUrl,
    qrCodeReason: qrCode.reason,
    qrCodeRecognized: qrCode.recognized,
    qrCodePayloadLength: qrCode.payloadLength,
    qrCodeVerifyReason: qrCode.verifyReason
  });
}

async function clearControlledWebSpace(
  input: MatrixAccountWebSpaceInput
): Promise<DesktopCommandResult<MatrixAccountWebSpaceClearResult>> {
  const validated = validateWebSpaceInput(input);
  if (!validated.ok) return validated;
  const browserPartition = webSpacePartition(input);
  await suspendControlledWebSpace(browserPartition);
  const session = electronSession.fromPartition(browserPartition);
  await flushPersistentSession(session);
  const storagePath = session.storagePath;
  await session.clearStorageData();
  if (storagePath) {
    try {
      await sessionVault.cleanupStoragePath(storagePath);
    } catch (error) {
      const known = normalizeSessionVaultError(error, "web_space_cleanup_failed", "WebSpace 物理清理失败");
      return fail(known.code, known.message);
    }
  }
  return ok({
    webSpaceId: input.webSpaceId,
    platform: input.platform,
    browserPartition,
    cleared: true
  });
}

async function loadControlledUrl(browser: BrowserWindow, targetUrl: string): Promise<void> {
  try {
    await Promise.race([browser.loadURL(targetUrl), delay(12000)]);
  } catch {
    // Some platform login pages keep navigating internally; QR extraction below is still the useful signal.
  }
  await delay(800);
}

interface LoginQrCodeSnapshot {
  dataUrl?: string;
  reason?: string;
  recognized?: boolean;
  payloadLength?: number;
  verifyReason?: string;
}

interface LoginQrCodeCandidate {
  dataUrl?: string;
  rect?: Rectangle;
  reason?: string;
}

interface LoginQrCodeVerification {
  recognized: boolean;
  payloadLength?: number;
  reason?: string;
}

async function extractLoginQrCode(browser: BrowserWindow, timeoutMs: number): Promise<LoginQrCodeSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = "平台登录页尚未生成二维码";
  while (!browser.isDestroyed() && Date.now() <= deadline) {
    const candidate = await findLoginQrCodeCandidate(browser);
    if (candidate?.dataUrl) return withQrVerification(browser, candidate.dataUrl);
    if (candidate?.rect) {
      const dataUrl = await captureQrCandidate(browser, candidate.rect);
      if (dataUrl) return withQrVerification(browser, dataUrl);
    }
    if (candidate?.reason) lastReason = candidate.reason;
    await delay(700);
  }
  return { reason: lastReason };
}

async function withQrVerification(browser: BrowserWindow, dataUrl: string): Promise<LoginQrCodeSnapshot> {
  const verification = await verifyQrCodeDataUrl(browser, dataUrl);
  void writeMatrixAccountDebugLog("qr-verified", {
    dataUrlLength: dataUrl.length,
    recognized: verification.recognized,
    payloadLength: verification.payloadLength ?? 0,
    reason: verification.reason
  });
  return {
    dataUrl,
    recognized: verification.recognized,
    payloadLength: verification.payloadLength,
    verifyReason: verification.reason
  };
}

async function verifyQrCodeDataUrl(browser: BrowserWindow, dataUrl: string): Promise<LoginQrCodeVerification> {
  if (!dataUrl.startsWith("data:image/")) {
    return { recognized: false, reason: "not_image_data_url" };
  }
  try {
    return (await browser.webContents.executeJavaScript(
      `((dataUrl) => (async () => {
        if (typeof BarcodeDetector === "undefined") {
          return { recognized: false, reason: "barcode_detector_unavailable" };
        }
        const image = new Image();
        image.src = dataUrl;
        await image.decode();
        const detector = new BarcodeDetector({ formats: ["qr_code"] });
        const results = await detector.detect(image);
        const first = results && results[0];
        const rawValue = first && typeof first.rawValue === "string" ? first.rawValue : "";
        return {
          recognized: Boolean(rawValue),
          payloadLength: rawValue.length,
          reason: rawValue ? "" : "qr_decode_empty"
        };
      })())(${JSON.stringify(dataUrl)})`,
      true
    )) as LoginQrCodeVerification;
  } catch (err) {
    return {
      recognized: false,
      reason: err instanceof Error ? err.message.slice(0, 160) : "qr_verify_failed"
    };
  }
}

async function findLoginQrCodeCandidate(browser: BrowserWindow): Promise<LoginQrCodeCandidate | null> {
  try {
    return (await browser.webContents.executeJavaScript(
      `(() => {
        const minSize = 72;
        const text = (value) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, 240);
        const toPlainClass = (value) => {
          if (!value) return "";
          if (typeof value === "string") return value;
          if (typeof value.baseVal === "string") return value.baseVal;
          return String(value || "");
        };
        const isCandidateRect = (rect) => {
          if (!rect || rect.width < minSize || rect.height < minSize) return false;
          const ratio = rect.width / Math.max(rect.height, 1);
          return ratio >= 0.62 && ratio <= 1.62;
        };
        const isVisible = (node) => {
          const rect = node.getBoundingClientRect();
          if (!isCandidateRect(rect)) return false;
          const style = getComputedStyle(node);
          return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.05;
        };
        const normalizeRect = (rect) => ({
          x: Math.max(0, Math.floor(rect.x - 10)),
          y: Math.max(0, Math.floor(rect.y - 10)),
          width: Math.ceil(rect.width + 20),
          height: Math.ceil(rect.height + 20)
        });
        const scoreNode = (node, rect) => {
          const label = [
            node.id,
            toPlainClass(node.className),
            node.getAttribute("alt"),
            node.getAttribute("title"),
            node.getAttribute("aria-label"),
            node.getAttribute("src"),
            node.getAttribute("href")
          ].map(text).join(" ").toLowerCase();
          let score = 0;
          if (/qr|qrcode|二维码|扫码|scan/.test(label)) score += 100;
          else if (/login|登录/.test(label)) score += 10;
          const ratio = rect.width / Math.max(rect.height, 1);
          score += Math.max(0, 30 - Math.abs(1 - ratio) * 45);
          score += Math.min(30, Math.sqrt(rect.width * rect.height) / 8);
          if (rect.width >= 140 && rect.height >= 140) score += 12;
          if (rect.width > 420 || rect.height > 420) score -= 90;
          return score;
        };
        const imageToDataUrl = (img) => {
          if (img.src && img.src.startsWith("data:image/")) return img.src;
          if (!img.complete || !img.naturalWidth || !img.naturalHeight) return "";
          try {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext("2d");
            if (!ctx) return "";
            ctx.drawImage(img, 0, 0);
            return canvas.toDataURL("image/png");
          } catch {
            return "";
          }
        };
        const canvasToDataUrl = (canvas) => {
          try {
            return canvas.toDataURL("image/png");
          } catch {
            return "";
          }
        };
        const svgToDataUrl = (svg) => {
          try {
            const source = new XMLSerializer().serializeToString(svg);
            return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(source)));
          } catch {
            return "";
          }
        };
        const candidates = [];
        for (const node of Array.from(document.querySelectorAll("canvas,img,svg"))) {
          if (!isVisible(node)) continue;
          const rect = node.getBoundingClientRect();
          let dataUrl = "";
          if (node instanceof HTMLCanvasElement) dataUrl = canvasToDataUrl(node);
          if (node instanceof HTMLImageElement) dataUrl = imageToDataUrl(node);
          if (node instanceof SVGElement) dataUrl = svgToDataUrl(node);
          candidates.push({ score: scoreNode(node, rect), dataUrl, rect: normalizeRect(rect) });
        }
        for (const node of Array.from(document.querySelectorAll("*"))) {
          if (!isVisible(node)) continue;
          const style = getComputedStyle(node);
          const background = style.backgroundImage || "";
          if (!/url\\(/.test(background)) continue;
          const rect = node.getBoundingClientRect();
          candidates.push({ score: scoreNode(node, rect) + 18, rect: normalizeRect(rect) });
        }
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates.find((item) => item.score >= 45) || candidates[0];
        if (best?.dataUrl) return { dataUrl: best.dataUrl };
        if (best?.rect) return { rect: best.rect };
        const pageText = text(document.body && document.body.innerText);
        return {
          reason: /扫码|二维码|scan|qr/i.test(pageText)
            ? "平台登录页正在生成二维码，请稍后刷新"
            : "未在平台登录页中识别到二维码区域"
        };
      })()`,
      true
    )) as LoginQrCodeCandidate | null;
  } catch {
    return { reason: "二维码提取失败，请打开窗口手动登录" };
  }
}

async function captureQrCandidate(browser: BrowserWindow, rect: Rectangle): Promise<string | undefined> {
  try {
    const image = await browser.webContents.capturePage({
      x: Math.max(0, rect.x),
      y: Math.max(0, rect.y),
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height)
    });
    if (image.isEmpty()) return undefined;
    return image.toDataURL();
  } catch {
    return undefined;
  }
}

interface WebSpacePageSnapshot {
  url: string;
  title: string;
  domSummary: unknown;
  accessibilityTree: unknown;
  visibleText: string;
  elementRects: MatrixAccountWebSpaceSnapshotResult["elementRects"];
}

interface ScriptRuntimeState {
  qrCodeDataUrl?: string;
  textResults: Record<string, string>;
}

interface ScriptElementTarget {
  selector?: string;
  elementKey?: string;
}

async function captureWebSpaceSnapshot(
  browser: BrowserWindow,
  input: MatrixAccountWebSpaceSnapshotInput,
  browserPartition: string
): Promise<DesktopCommandResult<MatrixAccountWebSpaceSnapshotResult>> {
  try {
    const page = await getSanitizedPageSnapshot(browser);
    const pageFingerprint = createPageFingerprint(input.platform, page);
    const screenshotDataUrl = input.includeScreenshot === true ? await captureViewportScreenshot(browser) : undefined;
    const sensitiveContext =
      input.includeSensitiveContext === true ? await getSensitiveWebDebugContext(browser, browserPartition, page.url) : undefined;
    void writeMatrixAccountDebugLog("snapshot", {
      webSpaceId: input.webSpaceId,
      platform: input.platform,
      purpose: "capture",
      url: normalizeFingerprintUrl(page.url),
      title: page.title,
      signals: compactDebugSignals(sensitiveContext)
    });
    return ok({
      webSpaceId: input.webSpaceId,
      platform: input.platform,
      browserPartition,
      ...page,
      pageFingerprint,
      screenshotDataUrl,
      sensitiveContext
    });
  } catch {
    return fail("snapshot_failed", "登录空间快照采集失败");
  }
}

async function runWebSpaceLoginScript(
  browser: BrowserWindow,
  input: MatrixAccountWebSpaceScriptInput,
  browserPartition: string
): Promise<DesktopCommandResult<MatrixAccountWebSpaceScriptResult>> {
  const startedAt = Date.now();
  const state: ScriptRuntimeState = { textResults: {} };
  try {
    assertValidScriptDsl(input.dsl, input.purpose);
    const executionDecision = resolveMatrixAccountScriptExecutionDecision(
      input.scriptVersionId,
      input.purpose,
      input.dsl
    );
    if (executionDecision.kind === "deny") {
      throw scriptError(executionDecision.violation.code, executionDecision.violation.message);
    }
    if (executionDecision.kind === "substitute") {
      const legacySubstitution = executionDecision.substitution;
      void writeMatrixAccountDebugLog("legacy-credential-adapter-substituted", {
        webSpaceId: input.webSpaceId,
        platform: input.platform,
        purpose: input.purpose,
        scriptVersionId: input.scriptVersionId,
        reasonCode: legacySubstitution.reasonCode,
        expiresAt: legacySubstitution.expiresAt
      });
    } else {
      for (const step of input.dsl.steps) {
        if (browser.isDestroyed()) throw scriptError("window_closed", "受控浏览器窗口已关闭");
        await runScriptStep(browser, input.platform, step, state);
      }
    }
    const accountCandidate =
      input.purpose === "account_detect"
        ? mergeDetectionCandidates(await detectAccountCandidate(browser, input.platform), accountCandidateFromScriptResults(input.platform, state.textResults))
        : undefined;
    const usableCandidate = input.purpose === "account_detect" ? isUsableDesktopCandidate(accountCandidate) : undefined;
    const qrPurpose = input.purpose === "qr_login_prepare" || input.purpose === "qr_login_refresh";
    const missingQrCode = qrPurpose && !state.qrCodeDataUrl;
    const missingAccountCandidate = input.purpose === "account_detect" && !usableCandidate;
    void writeMatrixAccountDebugLog("script-result", {
      webSpaceId: input.webSpaceId,
      platform: input.platform,
      purpose: input.purpose,
      scriptVersionId: input.scriptVersionId,
      textResultKeys: Object.keys(state.textResults),
      hasQrCode: Boolean(state.qrCodeDataUrl),
      qrCodeLength: state.qrCodeDataUrl ? state.qrCodeDataUrl.length : 0,
      accountCandidateSignals: accountCandidate
        ? {
            hasIdentityKey: Boolean(accountCandidate.identityKey),
            hasPlatformUid: Boolean(accountCandidate.platformUid),
            hasDisplayName: Boolean(accountCandidate.displayName || accountCandidate.nickname),
            hasAvatarUrl: Boolean(accountCandidate.avatarUrl),
            hasHomeUrl: Boolean(accountCandidate.homeUrl)
          }
        : undefined,
      usableCandidate
    });
    return ok({
      webSpaceId: input.webSpaceId,
      platform: input.platform,
      browserPartition,
      scriptVersionId: input.scriptVersionId,
      status: missingQrCode || missingAccountCandidate ? "failed" : "success",
      qrCodeDataUrl: state.qrCodeDataUrl,
      accountCandidate:
        accountCandidate && usableCandidate
          ? {
              identityKey: accountCandidate.identityKey,
              platformUid: accountCandidate.platformUid,
              displayName: accountCandidate.displayName,
              nickname: accountCandidate.nickname,
              avatarUrl: accountCandidate.avatarUrl,
              homeUrl: accountCandidate.homeUrl
            }
          : undefined,
      errorCode: missingQrCode ? "qr_not_found" : missingAccountCandidate ? "account_identity_not_found" : undefined,
      errorMessage: missingQrCode ? "未提取到二维码" : missingAccountCandidate ? "账号候选信息不完整" : undefined,
      durationMs: Date.now() - startedAt
    });
  } catch (err) {
    const known = normalizeScriptError(err);
    void writeMatrixAccountDebugLog("script-error", {
      webSpaceId: input.webSpaceId,
      platform: input.platform,
      purpose: input.purpose,
      scriptVersionId: input.scriptVersionId,
      errorCode: known.code,
      errorMessage: known.message,
      durationMs: Date.now() - startedAt
    });
    return ok({
      webSpaceId: input.webSpaceId,
      platform: input.platform,
      browserPartition,
      scriptVersionId: input.scriptVersionId,
      status: known.code === "script_timeout" ? "timeout" : "failed",
      errorCode: known.code,
      errorMessage: known.message,
      durationMs: Date.now() - startedAt
    });
  }
}

async function getSanitizedPageSnapshot(browser: BrowserWindow): Promise<WebSpacePageSnapshot> {
  return (await browser.webContents.executeJavaScript(
    `(() => {
      const maxText = 6000;
      const text = (value, max = 240) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, max);
      const isSensitiveName = (value) => /(password|passwd|pwd|token|cookie|secret|验证码|校验码|短信|code)/i.test(String(value || ""));
      const cssEscape = (value) => {
        if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
        return String(value || "").replace(/["'\\\\#.:\\[\\]>+~*^$|=\\s]/g, "\\\\$&");
      };
      const selectorFor = (node) => {
        if (!(node instanceof Element)) return "";
        if (node.id && !isSensitiveName(node.id)) return "#" + cssEscape(node.id);
        const parts = [];
        let current = node;
        while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
          let part = current.tagName.toLowerCase();
          if (current.classList && current.classList.length > 0) {
            const cls = Array.from(current.classList).filter((item) => !isSensitiveName(item)).slice(0, 2);
            if (cls.length) part += "." + cls.map(cssEscape).join(".");
          }
          const parent = current.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
            if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
          }
          parts.unshift(part);
          current = parent;
        }
        return parts.join(" > ");
      };
      const stableKeyFor = (node) => {
        if (!(node instanceof Element)) return "";
        // These attributes are intentionally ordered by their usual contract
        // strength. A stable key is emitted only when it uniquely identifies a
        // visible-page node, so it cannot silently pick a sibling.
        const attributeNames = ["data-testid", "data-test", "data-e2e", "data-qa", "data-cy", "id", "name", "aria-label"];
        for (const name of attributeNames) {
          const value = node.getAttribute(name);
          if (!value || isSensitiveName(name) || isSensitiveName(value)) continue;
          const matches = Array.from(document.querySelectorAll("[" + name + "]"))
            .filter((item) => item.getAttribute(name) === value);
          if (matches.length === 1 && matches[0] === node) return name + ":" + text(value, 160);
        }
        return "";
      };
      const visible = (node) => {
        if (!(node instanceof Element)) return false;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.03;
      };
      const safeNodeText = (node, max = 160) => {
        if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
          return text(node.getAttribute("aria-label") || node.getAttribute("placeholder") || "", max);
        }
        return text(node.textContent, max);
      };
      const safeAttrs = (node) => {
        const out = {};
        for (const name of ["id", "class", "role", "aria-label", "title", "alt", "placeholder", "href"]) {
          if (isSensitiveName(name)) continue;
          const raw = node.getAttribute && node.getAttribute(name);
          if (!raw || isSensitiveName(raw)) continue;
          if (name === "href") {
            try {
              const url = new URL(raw, location.href);
              out[name] = url.origin + url.pathname;
            } catch {
              continue;
            }
          } else {
            out[name] = text(raw, 160);
          }
        }
        return out;
      };
      const elements = Array.from(document.querySelectorAll("body *"))
        .filter(visible)
        .slice(0, 320)
        .map((node, index) => {
          const rect = node.getBoundingClientRect();
          return {
            key: "el_" + index,
            stableKey: stableKeyFor(node),
            tag: node.tagName.toLowerCase(),
            text: safeNodeText(node),
            selector: selectorFor(node),
            attrs: safeAttrs(node),
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
          };
        });
      const interactive = elements.filter((item) =>
        /button|a|input|canvas|img|svg/.test(item.tag) || /button|link|tab|menuitem/.test(String(item.attrs.role || ""))
      );
      const visibleText = text(document.body && document.body.innerText, maxText);
      return {
        url: String(location.href || ""),
        title: text(document.title, 240),
        visibleText,
        domSummary: { elements },
        accessibilityTree: {
          title: text(document.title, 240),
          interactive: interactive.slice(0, 120).map((item) => ({
            key: item.key,
            stableKey: item.stableKey,
            tag: item.tag,
            text: item.text,
            role: item.attrs.role || "",
            label: item.attrs["aria-label"] || item.attrs.title || item.attrs.alt || ""
          }))
        },
        elementRects: interactive.slice(0, 160).map((item) => ({ key: item.key, stableKey: item.stableKey || undefined, text: item.text, selector: item.selector, rect: item.rect }))
      };
    })()`,
    true
  )) as WebSpacePageSnapshot;
}

async function getSensitiveWebDebugContext(browser: BrowserWindow, browserPartition: string, pageUrl: string): Promise<unknown> {
  const pageContext = await browser.webContents.executeJavaScript(
    `(() => {
      const maxValueLength = 3000;
      const maxStorageKeys = 120;
      const maxIndexedDBDatabases = 4;
      const maxIndexedDBStores = 6;
      const maxIndexedDBRecords = 20;
      const serialize = (value) => {
        try {
          const text = typeof value === "string" ? value : JSON.stringify(value);
          if (text == null) return "";
          return String(text).slice(0, maxValueLength);
        } catch {
          return String(value || "").slice(0, maxValueLength);
        }
      };
      const dumpStorage = (storage) => {
        const out = {};
        if (!storage) return out;
        for (let index = 0; index < storage.length && index < maxStorageKeys; index += 1) {
          const key = storage.key(index);
          if (!key) continue;
          out[key] = serialize(storage.getItem(key));
        }
        return out;
      };
      const openDatabase = (name) =>
        new Promise((resolve) => {
          const request = indexedDB.open(name);
          request.onerror = () => resolve(null);
          request.onsuccess = () => resolve(request.result);
          request.onblocked = () => resolve(null);
        });
      const getAllFromStore = (db, storeName) =>
        new Promise((resolve) => {
          try {
            const tx = db.transaction(storeName, "readonly");
            const store = tx.objectStore(storeName);
            const records = [];
            const request = store.openCursor();
            request.onerror = () => resolve(records);
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor || records.length >= maxIndexedDBRecords) {
                resolve(records);
                return;
              }
              records.push({ key: serialize(cursor.key), value: serialize(cursor.value) });
              cursor.continue();
            };
          } catch {
            resolve([]);
          }
        });
      const dumpIndexedDB = async () => {
        if (!indexedDB || typeof indexedDB.databases !== "function") return [];
        const dbs = await indexedDB.databases().catch(() => []);
        const out = [];
        for (const info of (dbs || []).slice(0, maxIndexedDBDatabases)) {
          if (!info.name) continue;
          const db = await openDatabase(info.name);
          if (!db) continue;
          const stores = [];
          for (const storeName of Array.from(db.objectStoreNames).slice(0, maxIndexedDBStores)) {
            stores.push({ name: storeName, records: await getAllFromStore(db, storeName) });
          }
          out.push({ name: info.name, version: info.version || 0, stores });
          db.close();
        }
        return out;
      };
      return Promise.resolve(dumpIndexedDB()).then((indexedDBData) => ({
        url: String(location.href || ""),
        origin: String(location.origin || ""),
        localStorage: dumpStorage(window.localStorage),
        sessionStorage: dumpStorage(window.sessionStorage),
        documentCookie: String(document.cookie || ""),
        indexedDB: indexedDBData
      }));
    })()`,
    true
  );
  const cookies = await electronSession
    .fromPartition(browserPartition)
    .cookies.get(pageUrl ? { url: pageUrl } : {})
    .catch(() => []);
  const normalizedCookies = cookies.slice(0, 120).map((cookie) => ({
    ...cookie,
    value: String(cookie.value || "").slice(0, 3000)
  }));
  return {
    capturedAt: new Date().toISOString(),
    url: pageUrl,
    page: pageContext,
    cookies: normalizedCookies,
    cdp: await getCdpWebDebugSignals(browser).catch((err) => ({
      error: err instanceof Error ? err.message : "cdp_debug_failed"
    }))
  };
}

async function getCdpWebDebugSignals(browser: BrowserWindow): Promise<unknown> {
  const debug = browser.webContents.debugger;
  const attachedBefore = debug.isAttached();
  if (!attachedBefore) {
    debug.attach("1.3");
  }
  try {
    await debug.sendCommand("Runtime.enable").catch(() => undefined);
    const evaluated = (await debug.sendCommand("Runtime.evaluate", {
      expression: `(() => {
        const text = (value, max = 2000) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, max);
        const toPlainClass = (value) => {
          if (!value) return "";
          if (typeof value === "string") return value;
          if (typeof value.baseVal === "string") return value.baseVal;
          return String(value || "");
        };
        const cssEscape = (value) => {
          if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
          return String(value || "").replace(/["'\\\\#.:\\[\\]>+~*^$|=\\s]/g, "\\\\$&");
        };
        const selectorFor = (node) => {
          if (!(node instanceof Element)) return "";
          if (node.id) return "#" + cssEscape(node.id);
          const parts = [];
          let current = node;
          while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
            let part = current.tagName.toLowerCase();
            if (current.classList && current.classList.length > 0) {
              const cls = Array.from(current.classList).slice(0, 2);
              if (cls.length) part += "." + cls.map(cssEscape).join(".");
            }
            const parent = current.parentElement;
            if (parent) {
              const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
              if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
            }
            parts.unshift(part);
            current = parent;
          }
          return parts.join(" > ");
        };
        const visible = (node) => {
          if (!(node instanceof Element)) return false;
          const rect = node.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = getComputedStyle(node);
          return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.03;
        };
        const isQrLikeRect = (rect) => {
          if (!rect || rect.width < 64 || rect.height < 64) return false;
          const ratio = rect.width / Math.max(rect.height, 1);
          return ratio >= 0.55 && ratio <= 1.8;
        };
        const nodeLabel = (node) => [
          node.tagName,
          node.id,
          toPlainClass(node.className),
          node.getAttribute && node.getAttribute("alt"),
          node.getAttribute && node.getAttribute("title"),
          node.getAttribute && node.getAttribute("aria-label"),
          node.getAttribute && node.getAttribute("src")
        ].map((item) => text(item, 180)).join(" ");
        const vicinityText = (node) => text([
          node.textContent,
          node.parentElement && node.parentElement.textContent,
          node.parentElement && node.parentElement.parentElement && node.parentElement.parentElement.textContent
        ].filter(Boolean).join(" "), 500);
        const scoreQrCandidate = (node, rect) => {
          const label = nodeLabel(node).toLowerCase();
          const nearText = vicinityText(node).toLowerCase();
          let score = 0;
          if (node instanceof HTMLCanvasElement || node instanceof HTMLImageElement || node instanceof SVGElement) score += 34;
          if (/qr|qrcode|二维码|扫码|scan/.test(label)) score += 72;
          if (/扫码登录|二维码登录|打开.*扫一扫|扫一扫|二维码/.test(nearText)) score += 42;
          const ratio = rect.width / Math.max(rect.height, 1);
          score += Math.max(0, 28 - Math.abs(1 - ratio) * 42);
          score += Math.min(32, Math.sqrt(rect.width * rect.height) / 8);
          if (rect.width >= 120 && rect.height >= 120) score += 10;
          return Math.round(score);
        };
        const dumpStorageKeys = (storage) => {
          const keys = [];
          if (!storage) return keys;
          for (let index = 0; index < storage.length && index < 120; index += 1) {
            const key = storage.key(index);
            if (!key) continue;
            const value = storage.getItem(key) || "";
            keys.push({ key, length: String(value).length, preview: text(value, 300) });
          }
          return keys;
        };
        const bodyText = text(document.body && document.body.innerText, 5000);
        const qrCandidates = Array.from(document.querySelectorAll("body *"))
          .filter((node) => visible(node))
          .map((node) => {
            const rect = node.getBoundingClientRect();
            if (!isQrLikeRect(rect)) return null;
            const score = scoreQrCandidate(node, rect);
            if (score < 42) return null;
            return {
              tag: node.tagName.toLowerCase(),
              selector: selectorFor(node),
              text: text(node.textContent, 120),
              label: nodeLabel(node),
              score,
              rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              }
            };
          })
          .filter(Boolean)
          .sort((a, b) => b.score - a.score)
          .slice(0, 12);
        const hasRealQrCandidate = qrCandidates.some((item) => {
          const label = String(item.label || "").toLowerCase();
          const textValue = String(item.text || "").toLowerCase();
          const qrText = /qr|qrcode|二维码|扫码|scan/.test(label + " " + textValue);
          return item.score >= 96 && qrText;
        });
        const hasQr = hasRealQrCandidate || /扫码登录|二维码登录|打开.{0,16}扫一扫|扫一扫/.test(bodyText);
        const hasLogin = /扫码登录|验证码登录|密码登录|登录\\/注册|登录或注册|passport|login/i.test(bodyText);
        const strongAccountSignal = /退出登录|账号设置|个人主页|抖音号[:：]|快手号[:：]|小红书号[:：]|粉丝\\s*\\d|获赞\\s*\\d|高清发布|新的创作|发布视频|发布图文|作品管理|内容管理|数据中心|店铺管理|创作者服务中心|变现中心|进入工作台/.test(bodyText);
        const loginPhase = strongAccountSignal
          ? "account"
          : hasQr || hasLogin
            ? "login"
            : "unknown";
        const loginSignals = {
          hasQr,
          hasLogin,
          hasAccount: strongAccountSignal,
          loginPhase,
          hasRealQrCandidate
        };
        return {
          url: location.href,
          origin: location.origin,
          title: document.title,
          readyState: document.readyState,
          bodyText: bodyText.slice(0, 3000),
          loginSignals,
          qrCandidates,
          localStorageKeys: dumpStorageKeys(window.localStorage),
          sessionStorageKeys: dumpStorageKeys(window.sessionStorage),
          cookie: document.cookie
        };
      })()`,
      returnByValue: true,
      awaitPromise: true
    })) as { result?: { value?: unknown } };
    return evaluated.result?.value ?? {};
  } finally {
    if (!attachedBefore && debug.isAttached()) {
      debug.detach();
    }
  }
}

function createPageFingerprint(platform: MatrixAccountPlatform, page: WebSpacePageSnapshot): string {
  const value = JSON.stringify({
    platform,
    url: normalizeFingerprintUrl(page.url),
    title: page.title,
    text: page.visibleText.slice(0, 1200),
    rects: page.elementRects.slice(0, 80).map((item) => [item.text, item.selector])
  });
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function normalizeFingerprintUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.slice(0, 200);
  }
}

async function captureViewportScreenshot(browser: BrowserWindow): Promise<string | undefined> {
  const image = await browser.webContents.capturePage();
  if (image.isEmpty()) return undefined;
  return compressedSnapshotDataUrl(image);
}

function compressedSnapshotDataUrl(image: NativeImage): string {
  const size = image.getSize();
  const maxWidth = 1024;
  const maxHeight = 768;
  const scale = Math.min(1, maxWidth / Math.max(size.width, 1), maxHeight / Math.max(size.height, 1));
  const target = scale < 1
    ? image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: "good"
      })
    : image;
  return `data:image/jpeg;base64,${target.toJPEG(62).toString("base64")}`;
}

async function runScriptStep(
  browser: BrowserWindow,
  platform: MatrixAccountPlatform,
  step: MatrixAccountLoginScriptStep,
  state: ScriptRuntimeState
): Promise<void> {
  switch (step.action) {
    case "wait":
      await delay(clampNumber(scriptWaitMs(step), 0, 15000));
      return;
    case "navigateAllowedUrl":
      if (!isAllowedPlatformUrl(platform, step.url)) throw scriptError("navigation_blocked", "脚本目标地址不在允许范围内");
      await loadControlledUrl(browser, step.url);
      return;
    case "waitForElement":
      await waitForElement(browser, scriptElementTarget(step), scriptTimeoutMs(step));
      return;
    case "clickSelector":
      await waitForElement(browser, scriptElementTarget(step), scriptTimeoutMs(step));
      if (!(await clickSelector(browser, scriptElementTarget(step)))) throw scriptError("element_click_failed", "脚本点击元素失败");
      return;
    case "clickText":
      if (!(await clickText(browser, step.text, scriptTimeoutMs(step)))) throw scriptError("text_click_failed", "脚本点击文本失败");
      return;
    case "captureElement": {
      const rect = await waitForElement(browser, scriptElementTarget(step), scriptTimeoutMs(step));
      const dataUrl = await captureQrCandidate(browser, rect);
      if (!dataUrl) throw scriptError("element_capture_failed", "脚本截图元素失败");
      if (!step.resultKey || step.resultKey === "qrCodeDataUrl") state.qrCodeDataUrl = dataUrl;
      return;
    }
    case "readText": {
      const value = await readSafeText(browser, scriptElementTarget(step, true), scriptTimeoutMs(step));
      if (step.resultKey) state.textResults[step.resultKey] = value;
      return;
    }
    case "readStorage": {
      const value = await readStorageValue(browser, step.storage, step.key);
      if (step.resultKey) state.textResults[step.resultKey] = value;
      return;
    }
    case "readIndexedDB": {
      const value = await readIndexedDBValue(browser, step.database, step.store, step.key, step.limit);
      if (step.resultKey) state.textResults[step.resultKey] = value;
      return;
    }
    default:
      throw scriptError("unsupported_step", "脚本动作不支持");
  }
}

function scriptElementTarget(step: MatrixAccountLoginScriptStep): ScriptElementTarget;
function scriptElementTarget(step: MatrixAccountLoginScriptStep, optional: true): ScriptElementTarget | undefined;
function scriptElementTarget(step: MatrixAccountLoginScriptStep, optional = false): ScriptElementTarget | undefined {
  const candidate = step as ScriptElementTarget;
  const selector = candidate.selector?.trim();
  const elementKey = candidate.elementKey?.trim();
  if (!selector && !elementKey) {
    if (optional) return undefined;
    throw scriptError("missing_element_target", "脚本元素目标缺失");
  }
  if (selector) assertSafeSelector(selector);
  if (elementKey) assertSafeElementKey(elementKey);
  return { selector, elementKey };
}

function scriptWaitMs(step: MatrixAccountLoginScriptStep): number {
  const raw = step as { ms?: number; duration?: number; timeoutMs?: number; timeout?: number };
  return raw.ms ?? raw.duration ?? raw.timeoutMs ?? raw.timeout ?? 0;
}

function scriptTimeoutMs(step: MatrixAccountLoginScriptStep): number | undefined {
  const raw = step as { timeoutMs?: number; timeout?: number };
  return raw.timeoutMs ?? raw.timeout;
}

async function waitForElement(browser: BrowserWindow, target: ScriptElementTarget, timeoutMs = 8000): Promise<Rectangle> {
  const deadline = Date.now() + clampNumber(timeoutMs, 300, 30000);
  while (!browser.isDestroyed() && Date.now() <= deadline) {
    const rect = await getVisibleElementRect(browser, target);
    if (rect) return rect;
    await delay(250);
  }
  throw scriptError("script_timeout", "等待脚本元素超时");
}

async function getVisibleElementRect(browser: BrowserWindow, target: ScriptElementTarget): Promise<Rectangle | null> {
  return (await browser.webContents.executeJavaScript(
    `((target) => {
      const nodeFor = (candidate) => {
        const key = String(candidate.elementKey || "");
        if (key) {
          const separator = key.indexOf(":");
          const attribute = key.slice(0, separator);
          const value = key.slice(separator + 1);
          const allowed = ["data-testid", "data-test", "data-e2e", "data-qa", "data-cy", "id", "name", "aria-label"];
          if (separator > 0 && allowed.includes(attribute) && value) {
            const matches = Array.from(document.querySelectorAll("[" + attribute + "]"))
              .filter((item) => item.getAttribute(attribute) === value);
            if (matches.length === 1) return matches[0];
          }
        }
        return candidate.selector ? document.querySelector(candidate.selector) : null;
      };
      const node = nodeFor(target);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") <= 0.03) return null;
      return {
        x: Math.max(0, Math.floor(rect.x)),
        y: Math.max(0, Math.floor(rect.y)),
        width: Math.ceil(rect.width),
        height: Math.ceil(rect.height)
      };
    })(${JSON.stringify(target)})`,
    true
  )) as Rectangle | null;
}

async function clickSelector(browser: BrowserWindow, target: ScriptElementTarget): Promise<boolean> {
  return (await browser.webContents.executeJavaScript(
    `((target) => {
      const nodeFor = (candidate) => {
        const key = String(candidate.elementKey || "");
        if (key) {
          const separator = key.indexOf(":");
          const attribute = key.slice(0, separator);
          const value = key.slice(separator + 1);
          const allowed = ["data-testid", "data-test", "data-e2e", "data-qa", "data-cy", "id", "name", "aria-label"];
          if (separator > 0 && allowed.includes(attribute) && value) {
            const matches = Array.from(document.querySelectorAll("[" + attribute + "]"))
              .filter((item) => item.getAttribute(attribute) === value);
            if (matches.length === 1) return matches[0];
          }
        }
        return candidate.selector ? document.querySelector(candidate.selector) : null;
      };
      const node = nodeFor(target);
      if (!node) return false;
      if (node instanceof HTMLInputElement && /password|hidden/i.test(node.type || "")) return false;
      node.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
      node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      node.click();
      return true;
    })(${JSON.stringify(target)})`,
    true
  )) as boolean;
}

async function clickText(browser: BrowserWindow, targetText: string, timeoutMs = 8000): Promise<boolean> {
  const expected = safeScriptText(targetText);
  const deadline = Date.now() + clampNumber(timeoutMs, 300, 30000);
  while (!browser.isDestroyed() && Date.now() <= deadline) {
    const clicked = (await browser.webContents.executeJavaScript(
      `((expected) => {
        const text = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const visible = (node) => {
          const rect = node.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = getComputedStyle(node);
          return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.03;
        };
        const nodes = Array.from(document.querySelectorAll("button,a,[role='button'],[role='tab'],span,div"));
        const node = nodes.find((item) => visible(item) && text(item.textContent).includes(expected));
        if (!node) return false;
        node.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        node.click();
        return true;
      })(${JSON.stringify(expected)})`,
      true
    )) as boolean;
    if (clicked) return true;
    await delay(250);
  }
  return false;
}

async function readSafeText(browser: BrowserWindow, target?: ScriptElementTarget, timeoutMs = 8000): Promise<string> {
  if (target) await waitForElement(browser, target, timeoutMs);
  return (await browser.webContents.executeJavaScript(
    `((target) => {
      const nodeFor = (candidate) => {
        if (!candidate) return document.body;
        const key = String(candidate.elementKey || "");
        if (key) {
          const separator = key.indexOf(":");
          const attribute = key.slice(0, separator);
          const value = key.slice(separator + 1);
          const allowed = ["data-testid", "data-test", "data-e2e", "data-qa", "data-cy", "id", "name", "aria-label"];
          if (separator > 0 && allowed.includes(attribute) && value) {
            const matches = Array.from(document.querySelectorAll("[" + attribute + "]"))
              .filter((item) => item.getAttribute(attribute) === value);
            if (matches.length === 1) return matches[0];
          }
        }
        return candidate.selector ? document.querySelector(candidate.selector) : null;
      };
      const node = nodeFor(target);
      if (!node) return "";
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
        return String(node.getAttribute("aria-label") || node.getAttribute("placeholder") || "").replace(/\\s+/g, " ").trim().slice(0, 500);
      }
      return String(node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 2000);
    })(${JSON.stringify(target)})`,
    true
  )) as string;
}

async function readStorageValue(
  browser: BrowserWindow,
  storage: "localStorage" | "sessionStorage" | "cookie",
  key: string
): Promise<string> {
  const normalizedKey = safeScriptDataKey(key);
  if (storage === "cookie") {
    const url = browser.webContents.getURL();
    const cookies = await browser.webContents.session.cookies.get(
      normalizedKey === "*" || normalizedKey.toLowerCase() === "all" ? { url } : { url, name: normalizedKey }
    );
    return JSON.stringify(cookies);
  }
  return (await browser.webContents.executeJavaScript(
    `((storageName, key) => {
      const maxValueLength = 5000;
      const maxStorageKeys = 120;
      const serialize = (value) => String(value || "").slice(0, maxValueLength);
      const storage = storageName === "localStorage" ? window.localStorage : window.sessionStorage;
      if (!storage) return "";
      if (key === "*" || key.toLowerCase() === "all") {
        const out = {};
        for (let index = 0; index < storage.length && index < maxStorageKeys; index += 1) {
          const itemKey = storage.key(index);
          if (itemKey) out[itemKey] = serialize(storage.getItem(itemKey));
        }
        return JSON.stringify(out);
      }
      return serialize(storage.getItem(key));
    })(${JSON.stringify(storage)}, ${JSON.stringify(normalizedKey)})`,
    true
  )) as string;
}

async function readIndexedDBValue(
  browser: BrowserWindow,
  database: string,
  store: string,
  key?: string,
  limit?: number
): Promise<string> {
  const dbName = safeScriptDataKey(database);
  const storeName = safeScriptDataKey(store);
  const itemKey = key ? safeScriptDataKey(key) : "";
  const maxRecords = clampNumber(limit ?? 20, 1, 120);
  return (await browser.webContents.executeJavaScript(
    `((dbName, storeName, itemKey, maxRecords) => {
      const serialize = (value) => {
        try {
          const text = typeof value === "string" ? value : JSON.stringify(value);
          return String(text || "").slice(0, 5000);
        } catch {
          return String(value || "").slice(0, 5000);
        }
      };
      const openDatabase = (name) =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open(name);
          request.onerror = () => reject(new Error("indexeddb_open_failed"));
          request.onsuccess = () => resolve(request.result);
        });
      return openDatabase(dbName).then((db) => new Promise((resolve, reject) => {
        try {
          const tx = db.transaction(storeName, "readonly");
          const target = tx.objectStore(storeName);
          if (itemKey) {
            const request = target.get(itemKey);
            request.onerror = () => reject(new Error("indexeddb_read_failed"));
            request.onsuccess = () => {
              db.close();
              resolve(serialize(request.result));
            };
            return;
          }
          const records = [];
          const request = target.openCursor();
          request.onerror = () => reject(new Error("indexeddb_cursor_failed"));
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || records.length >= maxRecords) {
              db.close();
              resolve(JSON.stringify(records));
              return;
            }
            records.push({ key: cursor.key, value: cursor.value });
            cursor.continue();
          };
        } catch (err) {
          reject(err);
        }
      })).catch((err) => {
        throw new Error(err && err.message ? err.message : "indexeddb_read_failed");
      });
    })(${JSON.stringify(dbName)}, ${JSON.stringify(storeName)}, ${JSON.stringify(itemKey)}, ${JSON.stringify(maxRecords)})`,
    true
  )) as string;
}

function assertValidScriptDsl(dsl: MatrixAccountLoginScriptDsl, purpose: MatrixAccountLoginScriptPurpose): void {
  if (!dsl || typeof dsl !== "object") throw scriptError("invalid_script", "脚本结构无效");
  if (dsl.version !== 1) throw scriptError("invalid_script_version", "脚本版本不支持");
  if (dsl.purpose !== purpose) throw scriptError("script_purpose_mismatch", "脚本用途不匹配");
  if (!Array.isArray(dsl.steps) || dsl.steps.length === 0 || dsl.steps.length > 40) {
    throw scriptError("invalid_script_steps", "脚本步骤数量无效");
  }
  for (const step of dsl.steps) {
    assertValidScriptStep(step);
  }
}

function assertValidScriptStep(step: MatrixAccountLoginScriptStep): void {
  if (!step || typeof step !== "object") throw scriptError("invalid_script_step", "脚本步骤无效");
  if (
    ![
      "clickText",
      "clickSelector",
      "wait",
      "waitForElement",
      "captureElement",
      "readText",
      "readStorage",
      "readIndexedDB",
      "navigateAllowedUrl"
    ].includes(step.action)
  ) {
    throw scriptError("unsupported_step", "脚本动作不支持");
  }
  if ("selector" in step && step.selector) assertSafeSelector(step.selector);
  if ("elementKey" in step && step.elementKey) assertSafeElementKey(step.elementKey);
  if (
    ["clickSelector", "waitForElement", "captureElement"].includes(step.action) &&
    !("selector" in step && step.selector) &&
    !("elementKey" in step && step.elementKey)
  ) {
    throw scriptError("missing_element_target", "脚本元素目标缺失");
  }
  if ("text" in step && step.text) safeScriptText(step.text);
  if ("key" in step && step.key) safeScriptDataKey(step.key);
  if ("database" in step && step.database) safeScriptDataKey(step.database);
  if ("store" in step && step.store) safeScriptDataKey(step.store);
  if ("storage" in step && step.storage && !["localStorage", "sessionStorage", "cookie"].includes(step.storage)) {
    throw scriptError("invalid_storage_type", "脚本存储类型无效");
  }
  if ("url" in step && step.url && step.url.length > 600) throw scriptError("invalid_script_url", "脚本地址过长");
}

function assertSafeSelector(selector: string): void {
  const value = selector.trim();
  if (!value || value.length > 400) throw scriptError("invalid_selector", "脚本选择器无效");
  if (/script|iframe|webview/i.test(value)) throw scriptError("blocked_selector", "脚本选择器不允许访问该元素");
}

function assertSafeElementKey(elementKey: string): void {
  const value = elementKey.trim();
  const separator = value.indexOf(":");
  const attribute = value.slice(0, separator);
  const keyValue = value.slice(separator + 1);
  const allowed = new Set(["data-testid", "data-test", "data-e2e", "data-qa", "data-cy", "id", "name", "aria-label"]);
  if (separator <= 0 || !allowed.has(attribute) || !keyValue || value.length > 240 || /password|passwd|pwd|token|cookie|secret|验证码|校验码/i.test(keyValue)) {
    throw scriptError("invalid_element_key", "脚本元素键无效");
  }
}

function safeScriptText(value: string): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 120) throw scriptError("invalid_text", "脚本文本无效");
  return text;
}

function safeScriptDataKey(value: string): string {
  const text = String(value || "").trim();
  if (!text || text.length > 240) throw scriptError("invalid_data_key", "脚本数据键无效");
  return text;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function scriptError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function normalizeScriptError(err: unknown): { code: string; message: string } {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string") {
    return { code: (err as { code: string }).code, message: err instanceof Error ? err.message : "脚本执行失败" };
  }
  return { code: "script_execution_failed", message: err instanceof Error ? err.message : "脚本执行失败" };
}

function compactDebugSignals(value: unknown): unknown {
  const raw = value as {
    page?: {
      url?: string;
      origin?: string;
      documentCookie?: string;
      localStorage?: Record<string, unknown>;
      sessionStorage?: Record<string, unknown>;
      indexedDB?: Array<{ name?: string; stores?: Array<{ name?: string; records?: unknown[] }> }>;
    };
    cookies?: unknown[];
    cdp?: {
      url?: string;
      title?: string;
      readyState?: string;
      loginSignals?: unknown;
      qrCandidates?: Array<{
        tag?: string;
        selector?: string;
        text?: string;
        label?: string;
        score?: number;
        rect?: { x?: number; y?: number; width?: number; height?: number };
      }>;
      localStorageKeys?: Array<{ key?: string; length?: number; preview?: string }>;
      sessionStorageKeys?: Array<{ key?: string; length?: number; preview?: string }>;
      cookie?: string;
      bodyText?: string;
      error?: string;
    };
  };
  const indexedDB = raw?.page?.indexedDB || [];
  return {
    pageUrl: raw?.page?.url ? normalizeFingerprintUrl(raw.page.url) : undefined,
    origin: raw?.page?.origin,
    cookieCount: raw?.cookies?.length ?? 0,
    documentCookieLength: String(raw?.page?.documentCookie || "").length,
    localStorageKeyCount: Object.keys(raw?.page?.localStorage || {}).length,
    sessionStorageKeyCount: Object.keys(raw?.page?.sessionStorage || {}).length,
    indexedDBCount: indexedDB.length,
    indexedDBStoreCount: indexedDB.reduce((total, db) => total + (db.stores?.length ?? 0), 0),
    indexedDBRecordCount: indexedDB.reduce(
      (total, db) => total + (db.stores || []).reduce((storeTotal, store) => storeTotal + (store.records?.length ?? 0), 0),
      0
    ),
    cdp: {
      url: raw?.cdp?.url ? normalizeFingerprintUrl(raw.cdp.url) : undefined,
      title: raw?.cdp?.title,
      readyState: raw?.cdp?.readyState,
      hasLoginSignals: Boolean(raw?.cdp?.loginSignals),
      qrCandidateCount: raw?.cdp?.qrCandidates?.length ?? 0,
      localStorageKeyCount: raw?.cdp?.localStorageKeys?.length ?? 0,
      sessionStorageKeyCount: raw?.cdp?.sessionStorageKeys?.length ?? 0,
      cookieLength: String(raw?.cdp?.cookie || "").length,
      hasBodyText: Boolean(raw?.cdp?.bodyText),
      hasError: Boolean(raw?.cdp?.error)
    }
  };
}

async function writeMatrixAccountDebugLog(event: string, payload: unknown): Promise<void> {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), event, payload }).slice(0, 20000);
    const entry = `${line}\n`;
    let resetLog = false;
    try {
      const info = await stat(matrixAccountDebugLogPath);
      resetLog = info.size + Buffer.byteLength(entry, "utf8") > matrixAccountDebugLogMaxBytes;
    } catch {
      resetLog = false;
    }
    if (resetLog) {
      await writeFile(matrixAccountDebugLogPath, entry, { encoding: "utf8", mode: 0o600 });
    } else {
      await appendFile(matrixAccountDebugLogPath, entry, { encoding: "utf8", mode: 0o600 });
    }
    await chmod(matrixAccountDebugLogPath, 0o600);
  } catch {
    // Debug logging must never affect the login flow.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function releaseControlledWindow(browserPartition: string): Promise<boolean> {
  const existing = controlledWindows.get(browserPartition);
  if (!existing || existing.isDestroyed()) {
    controlledWindows.delete(browserPartition);
    webSpaceWindowPartitions.delete(browserPartition);
    releasingWindowPartitions.delete(browserPartition);
    return false;
  }
  releasingWindowPartitions.add(browserPartition);
  const released = await closeControlledWindow(existing);
  if (released) {
    controlledWindows.delete(browserPartition);
    webSpaceWindowPartitions.delete(browserPartition);
  }
  releasingWindowPartitions.delete(browserPartition);
  return released;
}

async function suspendControlledWebSpace(browserPartition: string): Promise<void> {
  const existing = controlledWindows.get(browserPartition);
  if (existing && !existing.isDestroyed()) {
    releasingWindowPartitions.add(browserPartition);
    await new Promise<void>((resolve) => {
      existing.once("closed", resolve);
      existing.destroy();
      if (existing.isDestroyed()) resolve();
    });
  }
  controlledWindows.delete(browserPartition);
  webSpaceWindowPartitions.delete(browserPartition);
  releasingWindowPartitions.delete(browserPartition);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function flushPersistentSession(session: Session): Promise<void> {
  await session.cookies.flushStore();
  session.flushStorageData();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function emitLoginState(event: IpcMainInvokeEvent, payload: MatrixAccountLoginStatePayload): void {
  if (event.sender.isDestroyed()) return;
  event.sender.send(IPC_CHANNELS.matrixAccountLoginStateChanged, payload);
}

function emitWebSpaceState(event: IpcMainInvokeEvent, payload: MatrixAccountWebSpaceStatePayload): void {
  if (event.sender.isDestroyed()) return;
  event.sender.send(IPC_CHANNELS.matrixAccountWebSpaceStateChanged, payload);
}

function canCaptureSensitiveMatrixDebug(event: IpcMainInvokeEvent): boolean {
  if (process.env.AICRM_ENABLE_SENSITIVE_MATRIX_DEBUG !== "1" || event.sender.isDestroyed()) return false;
  const callerWindow = BrowserWindow.fromWebContents(event.sender);
  if (!callerWindow || callerWindow.isDestroyed()) return false;
  for (const controlledWindow of controlledWindows.values()) {
    if (!controlledWindow.isDestroyed() && controlledWindow.webContents.id === event.sender.id) return false;
  }
  return true;
}

function validateInput(input: MatrixAccountBrowserInput): DesktopCommandResult<never> {
  if (!input || typeof input !== "object") {
    return fail("validation_error", "矩阵账号参数无效");
  }
  if (!input.accountId || !input.workspaceId || !input.workspaceType || !input.platform) {
    return fail("validation_error", "矩阵账号参数不完整");
  }
  if (!["platform", "agency", "enterprise"].includes(input.workspaceType)) {
    return fail("validation_error", "工作区类型无效");
  }
  if (!["douyin", "kuaishou", "xiaohongshu"].includes(input.platform)) {
    return fail("validation_error", "平台类型无效");
  }
  if (input.url && !isAllowedPlatformUrl(input.platform, input.url)) {
    return fail("validation_error", "平台地址不在允许范围内");
  }
  return ok(undefined as never);
}

function validateWebSpaceInput(input: MatrixAccountWebSpaceInput): DesktopCommandResult<never> {
  if (!input || typeof input !== "object") {
    return fail("validation_error", "矩阵账号 Web 空间参数无效");
  }
  if (!input.webSpaceId || !input.workspaceId || !input.workspaceType || !input.platform) {
    return fail("validation_error", "矩阵账号 Web 空间参数不完整");
  }
  if (!["platform", "agency", "enterprise"].includes(input.workspaceType)) {
    return fail("validation_error", "工作区类型无效");
  }
  if (!["douyin", "kuaishou", "xiaohongshu"].includes(input.platform)) {
    return fail("validation_error", "平台类型无效");
  }
  if (input.url && !isAllowedPlatformUrl(input.platform, input.url)) {
    return fail("validation_error", "平台地址不在允许范围内");
  }
  if (input.browserPartition && !isAllowedPartition(input.browserPartition)) {
    return fail("validation_error", "浏览器空间标识无效");
  }
  return ok(undefined as never);
}

function validateWebSpaceScriptInput(input: MatrixAccountWebSpaceScriptInput): DesktopCommandResult<never> {
  const base = validateWebSpaceInput(input);
  if (!base.ok) return base;
  if (!input.scriptVersionId || typeof input.scriptVersionId !== "string") {
    return fail("validation_error", "脚本版本参数无效");
  }
  if (!["qr_login_prepare", "qr_login_refresh", "account_detect", "session_check"].includes(input.purpose)) {
    return fail("validation_error", "脚本用途无效");
  }
  try {
    assertValidScriptDsl(input.dsl, input.purpose);
  } catch (err) {
    const known = normalizeScriptError(err);
    return fail("validation_error", known.message);
  }
  const executionDecision = resolveMatrixAccountScriptExecutionDecision(
    input.scriptVersionId,
    input.purpose,
    input.dsl
  );
  if (executionDecision.kind === "deny") {
    return fail(executionDecision.violation.code, executionDecision.violation.message);
  }
  return ok(undefined as never);
}

function isAllowedPlatformUrl(platform: MatrixAccountPlatform, value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    if (platform === "douyin") return hostname.endsWith("douyin.com");
    if (platform === "kuaishou") return hostname.endsWith("kuaishou.com");
    return hostname.endsWith("xiaohongshu.com");
  } catch {
    return false;
  }
}

function matrixAccountPartition(input: MatrixAccountBrowserInput): string {
  if (input.browserPartition && isAllowedPartition(input.browserPartition)) {
    return input.browserPartition;
  }
  return [
    "persist:matrix-account",
    safePart(input.workspaceType),
    safePart(input.workspaceId),
    safePart(input.platform),
    safePart(input.accountId),
    safePart(input.deviceId || "default")
  ].join(":");
}

function webSpacePartition(input: MatrixAccountWebSpaceInput): string {
  if (input.browserPartition && isAllowedPartition(input.browserPartition)) {
    return input.browserPartition;
  }
  return [
    "persist:matrix-account-space",
    safePart(input.workspaceType),
    safePart(input.workspaceId),
    safePart(input.platform),
    safePart(input.webSpaceId),
    safePart(input.deviceId || "default")
  ].join(":");
}

function isAllowedPartition(value: string): boolean {
  return /^persist:matrix-account(-space)?:[a-zA-Z0-9_.:-]+$/.test(value);
}

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 96);
}

interface DetectionSnapshot {
  url: string;
  title: string;
  metas: string[];
  anchors: Array<{ href: string; text: string }>;
  images: Array<{ src: string; alt: string }>;
}

type DetectionCandidate = Omit<
  Partial<MatrixAccountWebSpaceDetectResult>,
  "webSpaceId" | "platform" | "browserPartition" | "loginStatus" | "canDetect"
>;

async function detectAccountCandidate(browser: BrowserWindow, platform: MatrixAccountPlatform): Promise<DetectionCandidate> {
  try {
    const snapshot = (await browser.webContents.executeJavaScript(
      `(() => {
        const text = (value) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, 160);
        const attr = (node, name) => node ? text(node.getAttribute(name)) : "";
        const metas = Array.from(document.querySelectorAll("meta"))
          .map((node) => attr(node, "content"))
          .filter(Boolean)
          .slice(0, 80);
        const anchors = Array.from(document.querySelectorAll("a[href]"))
          .map((node) => ({ href: String(node.href || ""), text: text(node.textContent) }))
          .filter((item) => item.href)
          .slice(0, 200);
        const images = Array.from(document.querySelectorAll("img[src]"))
          .map((node) => ({ src: String(node.src || ""), alt: attr(node, "alt") }))
          .filter((item) => item.src)
          .slice(0, 80);
        return { url: String(location.href || ""), title: text(document.title), metas, anchors, images };
      })()`,
      true
    )) as DetectionSnapshot;
    const profile = findProfileIdentity(platform, snapshot);
    if (!profile.identityKey) {
      return {
        reason: "等待扫码登录完成"
      };
    }
    const displayName = normalizeDisplayName(profile.displayName || snapshot.title);
    const avatarUrl = snapshot.images.find((item) => item.alt && displayName && item.alt.includes(displayName))?.src || "";
    return {
      identityKey: profile.identityKey,
      platformUid: profile.platformUid,
      displayName,
      nickname: displayName,
      avatarUrl,
      homeUrl: profile.homeUrl || snapshot.url,
      reason: profile.identityKey ? undefined : "等待扫码登录完成"
    };
  } catch {
    return {
      reason: "账号识别失败，请确认平台页面已完成登录"
    };
  }
}

function accountCandidateFromScriptResults(platform: MatrixAccountPlatform, textResults: Record<string, string>): DetectionCandidate {
  const value = (key: string) => String(textResults[key] || "").replace(/\s+/g, " ").trim();
  const combined = Object.values(textResults).join(" ");
  const loose = parseLooseIdentity(platform, combined);
  const structured = extractCandidateFromStructuredText(Object.values(textResults));
  let identityKey = firstNonEmpty(value("identityKey"), value("platformIdentityKey"), structured.identityKey, loose?.identityKey || "");
  const platformUid = firstNonEmpty(value("platformUid"), value("uid"), structured.platformUid, identityKey, loose?.platformUid || "");
  if (looksLikeSessionToken(identityKey) && platformUid && platformUid !== identityKey) {
    identityKey = platformUid;
  }
  const displayName = normalizeDisplayName(
    firstNonEmpty(value("displayName"), value("nickname"), value("name"), structured.displayName, loose?.displayName || "")
  );
  const homeUrl = firstNonEmpty(value("homeUrl"), value("profileUrl"), structured.homeUrl);
  return {
    identityKey: identityKey || undefined,
    platformUid: platformUid || undefined,
    displayName: displayName || undefined,
    nickname: displayName || undefined,
    avatarUrl: value("avatarUrl") || structured.avatarUrl || undefined,
    homeUrl: homeUrl || undefined
  };
}

function looksLikeSessionToken(value: string): boolean {
  const normalized = String(value || "").trim();
  if (!normalized) return false;
  if (/^[a-f0-9]{24,}$/i.test(normalized)) return true;
  if (/^[A-Za-z0-9_-]{40,}$/.test(normalized) && !/^MS4wLj/.test(normalized)) return true;
  return false;
}

function extractCandidateFromStructuredText(values: string[]): DetectionCandidate {
  const result: DetectionCandidate = {};
  const visit = (value: unknown, depth: number): void => {
    if (depth > 5 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 80)) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const read = (...keys: string[]) => {
      for (const key of keys) {
        const found = record[key];
        if (typeof found === "string" || typeof found === "number") {
          const text = String(found).trim();
          if (text) return text;
        }
      }
      return "";
    };
    const userLike = hasAnyKey(record, [
      "identityKey",
      "platformIdentityKey",
      "uid",
      "userId",
      "user_id",
      "secUid",
      "sec_uid",
      "nickname",
      "nickName",
      "avatar",
      "avatarUrl",
      "profileUrl",
      "homeUrl"
    ]);
    result.identityKey ||= read("identityKey", "platformIdentityKey", "uid", "userId", "user_id", "secUid", "sec_uid");
    result.platformUid ||= read("platformUid", "uid", "userId", "user_id", "secUid", "sec_uid");
    if (userLike) {
      result.identityKey ||= read("authorId", "accountId", "id");
      result.platformUid ||= read("authorId", "accountId", "id");
    }
    result.displayName ||= read("displayName", "nickname", "nickName", "name", "userName", "screenName");
    result.nickname ||= result.displayName;
    result.avatarUrl ||= read("avatarUrl", "avatar", "avatar_url", "headUrl", "head_url");
    result.homeUrl ||= read("homeUrl", "profileUrl", "profile_url", "url");
    for (const nested of Object.values(record)) visit(nested, depth + 1);
  };
  for (const raw of values) {
    try {
      visit(JSON.parse(raw), 0);
    } catch {
      // Non-JSON text is handled by parseLooseIdentity.
    }
  }
  return result;
}

function hasAnyKey(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(record, key));
}

function mergeDetectionCandidates(primary: DetectionCandidate, fallback: DetectionCandidate): DetectionCandidate {
  return {
    identityKey: primary.identityKey || fallback.identityKey,
    platformUid: primary.platformUid || fallback.platformUid,
    displayName: primary.displayName || fallback.displayName,
    nickname: primary.nickname || fallback.nickname || primary.displayName || fallback.displayName,
    avatarUrl: primary.avatarUrl || fallback.avatarUrl,
    homeUrl: primary.homeUrl || fallback.homeUrl,
    reason: primary.identityKey || fallback.identityKey ? undefined : primary.reason || fallback.reason
  };
}

function isUsableDesktopCandidate(candidate: DetectionCandidate | undefined): boolean {
  if (!candidate?.identityKey) return false;
  const identity = String(candidate.identityKey).trim();
  if (identity.length < 6 || invalidIdentityValue(identity)) return false;
  const display = normalizeDisplayName(candidate.displayName || candidate.nickname || "");
  const homeUrl = String(candidate.homeUrl || "").trim();
  const uid = String(candidate.platformUid || "").trim();
  const hasProfileUrl = /\/(user|profile)\/[^/?#]{4,}|\/creator-micro\/user\/[^/?#]{4,}/i.test(homeUrl);
  const hasSpecificDisplay = display.length >= 2 && !isGenericDisplayName(display);
  const hasUsefulUid = uid.length >= 6 && uid !== identity && !invalidIdentityValue(uid);
  return hasProfileUrl || (hasSpecificDisplay && hasUsefulUid) || (hasSpecificDisplay && Boolean(candidate.avatarUrl));
}

function invalidIdentityValue(value: string): boolean {
  const normalized = value.trim();
  if (/^(0|null|undefined|false|true|login|profile|default|anonymous|guest)$/i.test(normalized)) return true;
  return looksLikeSessionToken(normalized);
}

function isGenericDisplayName(value: string): boolean {
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  if (!normalized) return true;
  return /登录|扫码|二维码|创作服务平台|创作者中心|工作台|开放平台|login|scan|dashboard|creator/.test(normalized);
}

function findProfileIdentity(
  platform: MatrixAccountPlatform,
  snapshot: DetectionSnapshot
): { identityKey?: string; platformUid?: string; homeUrl?: string; displayName?: string } {
  const candidates = [{ href: snapshot.url, text: snapshot.title }, ...snapshot.anchors];
  for (const candidate of candidates) {
    const parsed = parseProfileUrl(platform, candidate.href);
    if (parsed) {
      return {
        identityKey: parsed.identityKey,
        platformUid: parsed.platformUid,
        homeUrl: parsed.homeUrl,
        displayName: candidate.text || snapshot.title
      };
    }
  }
  for (const meta of snapshot.metas) {
    const parsed = parseLooseIdentity(platform, meta);
    if (parsed) return parsed;
  }
  return {};
}

function parseProfileUrl(
  platform: MatrixAccountPlatform,
  value: string
): { identityKey: string; platformUid: string; homeUrl: string } | null {
  try {
    const url = new URL(value);
    if (!isAllowedPlatformUrl(platform, url.toString())) return null;
    const pathname = url.pathname;
    const queryIds = ["uid", "user_id", "userId", "sec_uid", "secUserId", "authorId"];
    for (const name of queryIds) {
      const queryValue = url.searchParams.get(name);
      if (queryValue && queryValue.length >= 4) {
        return { identityKey: queryValue, platformUid: queryValue, homeUrl: url.toString() };
      }
    }
    const patterns =
      platform === "xiaohongshu"
        ? [/\/user\/profile\/([^/?#]+)/i]
        : platform === "kuaishou"
          ? [/\/profile\/([^/?#]+)/i, /\/user\/([^/?#]+)/i]
          : [/\/user\/([^/?#]+)/i, /\/creator-micro\/user\/([^/?#]+)/i];
    for (const pattern of patterns) {
      const match = pathname.match(pattern);
      const id = match?.[1];
      if (id && !["login", "profile", "creator"].includes(id.toLowerCase())) {
        return { identityKey: id, platformUid: id, homeUrl: url.toString() };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function parseLooseIdentity(
  platform: MatrixAccountPlatform,
  value: string
): { identityKey: string; platformUid: string; displayName?: string } | null {
  const patterns =
    platform === "xiaohongshu"
      ? [/userId["':\s]+([a-zA-Z0-9_-]{6,})/i]
      : platform === "kuaishou"
        ? [/userId["':\s]+([a-zA-Z0-9_-]{6,})/i]
        : [/(?:uid|sec_uid|secUid)["':\s]+([a-zA-Z0-9_-]{6,})/i];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) return { identityKey: match[1], platformUid: match[1] };
  }
  return null;
}

function normalizeDisplayName(value: string): string {
  return value
    .replace(/[-_|].*?(抖音|快手|小红书|创作服务平台|创作者中心).*$/i, "")
    .replace(/(登录|扫码|创作服务平台|创作者中心|抖音|快手|小红书)/gi, "")
    .trim()
    .slice(0, 80);
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function platformLabel(platform: MatrixAccountPlatform): string {
  if (platform === "douyin") return "抖音";
  if (platform === "kuaishou") return "快手";
  return "小红书";
}

function ok<T>(data: T): DesktopCommandResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): DesktopCommandResult<never> {
  return { ok: false, error: { code, message } };
}
