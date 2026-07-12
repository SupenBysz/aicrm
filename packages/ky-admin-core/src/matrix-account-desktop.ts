export type MatrixAccountPlatform = "douyin" | "kuaishou" | "xiaohongshu";

export type MatrixAccountLoginStatus =
  | "not_logged_in"
  | "login_pending"
  | "online"
  | "expired"
  | "verify_required"
  | "risk"
  | "unknown";

export type MatrixAccountWorkspaceType = "platform" | "agency" | "enterprise";

export interface DesktopCommandResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
}

export interface MatrixAccountCapabilities {
  bridgeVersion: 1;
  supportsControlledBrowser: boolean;
  supportsProfileIsolation: boolean;
  supportsSessionDetection: boolean;
  supportsCloudSessionVault: boolean;
  supportsAccountOnboarding?: boolean;
  /** Local encrypted snapshot vault. This does not imply cloud upload support. */
  supportsSessionSnapshotVault?: boolean;
  /** True only when snapshot receipts can be verified by the backend trust domain. */
  supportsServerVerifiableSnapshotReceipts?: boolean;
  /** Detect keeps the controlled window alive until business binding has settled. */
  supportsDeferredWindowRelease?: boolean;
}

export type MatrixAccountOnboardingStatus = "active" | "completed" | "failed" | "cancelled" | "expired";

export type MatrixAccountOnboardingPhase =
  | "created"
  | "opening"
  | "qr_preparing"
  | "qr_ready"
  | "waiting_scan"
  | "authenticating"
  | "authenticated"
  | "identifying"
  | "awaiting_confirmation"
  | "snapshot_sealing"
  | "committing"
  | "ready"
  | "blocked_repair"
  | "verification_required"
  | "risk_controlled"
  | "failed"
  | "cancelled";

export type MatrixAccountOnboardingActivity =
  | "executing"
  | "waiting_user"
  | "repairing_adapter"
  | "retrying"
  | "none";

export type MatrixAccountOnboardingNextAction =
  | "wait"
  | "refresh_qr"
  | "open_controlled_window"
  | "complete_platform_verification"
  | "confirm_binding"
  | "retry_snapshot"
  | "retry_step"
  | "cancel";

export type MatrixAccountOnboardingEventType =
  | "onboarding.created"
  | "login.phase.changed"
  | "qr.ready"
  | "qr.refreshed"
  | "qr.expired"
  | "user.action.required"
  | "adapter.repairing"
  | "account.identified"
  | "binding.review_required"
  | "snapshot.sealing"
  | "snapshot.verified"
  | "account.bound"
  | "account.ready"
  | "onboarding.failed"
  | "onboarding.cancelled";

export interface MatrixAccountOnboardingStartInput {
  attemptId?: string;
  operationId?: string;
  /** @internal Resolved from the backend login-attempt aggregate; never entered by the business UI. */
  webSpaceId: string;
  workspaceId: string;
  workspaceType: MatrixAccountWorkspaceType;
  platform: MatrixAccountPlatform;
  memberId?: string;
  deviceId?: string;
  showWindow?: boolean;
  idempotencyKey?: string;
}

export interface MatrixAccountOnboardingLookupInput {
  attemptId: string;
}

export interface MatrixAccountOnboardingQrInput extends MatrixAccountOnboardingLookupInput {
  qrRevision?: number;
}

export interface MatrixAccountOnboardingRefreshQrInput extends MatrixAccountOnboardingLookupInput {
  operationId?: string;
  expectedQrRevision?: number;
}

export interface MatrixAccountOnboardingCancelInput extends MatrixAccountOnboardingLookupInput {
  operationId?: string;
}

export interface MatrixAccountSessionReference {
  /** Reserved for account-oriented session operations after backend mapping is available. */
  accountId?: string;
  /** Reserved for account-oriented session operations after backend mapping is available. */
  clientSessionId?: string;
}

export interface MatrixAccountSessionVaultTarget {
  /** Current implementation resolves the trusted WebSpace exclusively through this coordinator aggregate. */
  attemptId: string;
  sessionRef?: MatrixAccountSessionReference;
}

export interface MatrixAccountSessionSnapshotSealInput extends MatrixAccountSessionVaultTarget {
  snapshotId?: string;
  operationId?: string;
}

export interface MatrixAccountSessionSnapshotVerifyInput extends MatrixAccountSessionVaultTarget {
  snapshotId: string;
}

export interface MatrixAccountSessionSnapshotRestoreInput extends MatrixAccountSessionVaultTarget {
  snapshotId: string;
  operationId?: string;
}

export interface MatrixAccountSessionWebSpaceCleanupInput extends MatrixAccountSessionVaultTarget {
  /** Cleanup is rejected unless this is the coordinator's current verified snapshot. */
  verifiedSnapshotId: string;
  operationId?: string;
}

export interface MatrixAccountSessionSnapshotView {
  snapshotId: string;
  schemaVersion: 1;
  status: "verified";
  createdAt: string;
  verifiedAt: string;
  contentHash: string;
  fingerprintHash: string;
  sizeBytes: number;
  sourceBytes: number;
  fileCount: number;
}

export interface MatrixAccountSessionSnapshotVerificationResult extends MatrixAccountSessionSnapshotView {
  /** Sensitive bearer proof for backend step completion. Never persist it in telemetry or logs. */
  verificationReceipt: string;
}

export interface MatrixAccountSessionSnapshotRestoreResult extends MatrixAccountSessionSnapshotVerificationResult {
  restoreId: string;
  restoredAt: string;
}

export interface MatrixAccountSessionWebSpaceCleanupResult {
  attemptId: string;
  verifiedSnapshotId: string;
  cleared: boolean;
  releasedBytes: number;
  cleanedAt: string;
}

export interface MatrixAccountOnboardingView {
  attemptId: string;
  operationId: string;
  methodKey: string;
  workspaceId: string;
  platform: MatrixAccountPlatform;
  phase: MatrixAccountOnboardingPhase;
  status: MatrixAccountOnboardingStatus;
  activity: MatrixAccountOnboardingActivity;
  qrRevision: number;
  sequence: number;
  nextActions: MatrixAccountOnboardingNextAction[];
  createdAt: string;
  updatedAt: string;
  snapshotId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface MatrixAccountOnboardingQrCodeView {
  attemptId: string;
  operationId: string;
  methodKey: "login.qr.get.v1" | "login.qr.refresh.v1";
  phase: MatrixAccountOnboardingPhase;
  status: MatrixAccountOnboardingStatus;
  qrRevision: number;
  qrCodeDataUrl?: string;
  recognized?: boolean;
  payloadLength?: number;
  reasonCode?: string;
  message?: string;
  observedAt: string;
}

export interface MatrixAccountOnboardingSanitizedResult {
  qrAvailable?: boolean;
  qrRecognized?: boolean;
  qrPayloadLength?: number;
  reasonCode?: string;
  message?: string;
}

export interface MatrixAccountOnboardingEvent {
  attemptId: string;
  operationId: string;
  methodKey: string;
  sequence: number;
  type: MatrixAccountOnboardingEventType;
  phase: MatrixAccountOnboardingPhase;
  status: MatrixAccountOnboardingStatus;
  qrRevision: number;
  occurredAt: string;
  recoverable: boolean;
  nextActions: MatrixAccountOnboardingNextAction[];
  sanitizedResult: MatrixAccountOnboardingSanitizedResult;
}

export interface MatrixAccountBrowserInput {
  accountId: string;
  workspaceId: string;
  workspaceType: MatrixAccountWorkspaceType;
  platform: MatrixAccountPlatform;
  deviceId?: string;
  browserPartition?: string;
  url?: string;
}

export interface MatrixAccountBrowserResult {
  accountId: string;
  platform: MatrixAccountPlatform;
  browserPartition: string;
  loginStatus: MatrixAccountLoginStatus;
  opened: boolean;
}

export interface MatrixAccountCheckResult {
  accountId: string;
  platform: MatrixAccountPlatform;
  browserPartition: string;
  loginStatus: MatrixAccountLoginStatus;
  canDetect: boolean;
}

export interface MatrixAccountClearProfileResult {
  accountId: string;
  platform: MatrixAccountPlatform;
  browserPartition: string;
  cleared: boolean;
}

export interface MatrixAccountLoginStatePayload {
  accountId: string;
  platform: MatrixAccountPlatform;
  browserPartition: string;
  loginStatus: MatrixAccountLoginStatus;
}

export interface MatrixAccountWebSpaceInput {
  webSpaceId: string;
  workspaceId: string;
  workspaceType: MatrixAccountWorkspaceType;
  platform: MatrixAccountPlatform;
  deviceId?: string;
  browserPartition?: string;
  url?: string;
  showWindow?: boolean;
  releaseWindowOnDetect?: boolean;
}

export interface MatrixAccountWebSpaceBrowserResult {
  webSpaceId: string;
  platform: MatrixAccountPlatform;
  browserPartition: string;
  loginStatus: MatrixAccountLoginStatus;
  opened: boolean;
  visible: boolean;
  qrCodeDataUrl?: string;
  qrCodeReason?: string;
  qrCodeRecognized?: boolean;
  qrCodePayloadLength?: number;
  qrCodeVerifyReason?: string;
}

export interface MatrixAccountWebSpaceDetectResult {
  webSpaceId: string;
  platform: MatrixAccountPlatform;
  browserPartition: string;
  loginStatus: MatrixAccountLoginStatus;
  canDetect: boolean;
  windowReleased?: boolean;
  identityKey?: string;
  platformUid?: string;
  displayName?: string;
  nickname?: string;
  avatarUrl?: string;
  homeUrl?: string;
  reason?: string;
}

export interface MatrixAccountWebSpaceClearResult {
  webSpaceId: string;
  platform: MatrixAccountPlatform;
  browserPartition: string;
  cleared: boolean;
}

export interface MatrixAccountWebSpaceStatePayload {
  webSpaceId: string;
  platform: MatrixAccountPlatform;
  browserPartition: string;
  loginStatus: MatrixAccountLoginStatus;
}

export type MatrixAccountLoginScriptPurpose =
  | "qr_login_prepare"
  | "qr_login_refresh"
  | "account_detect"
  | "session_check";

export type MatrixAccountScriptRunStatus = "success" | "failed" | "timeout" | "cancelled";

export interface MatrixAccountElementRect {
  key: string;
  stableKey?: string;
  text?: string;
  selector?: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface MatrixAccountWebSpaceSnapshotInput extends MatrixAccountWebSpaceInput {
  includeScreenshot?: boolean;
  includeSensitiveContext?: boolean;
}

export interface MatrixAccountWebSpaceSnapshotResult {
  webSpaceId: string;
  platform: MatrixAccountPlatform;
  browserPartition: string;
  url: string;
  title: string;
  pageFingerprint: string;
  domSummary: unknown;
  accessibilityTree: unknown;
  visibleText: string;
  elementRects: MatrixAccountElementRect[];
  screenshotDataUrl?: string;
  sensitiveContext?: unknown;
}

export type MatrixAccountLoginScriptStep =
  | {
      action: "clickText";
      text: string;
      timeoutMs?: number;
    }
  | {
      action: "clickSelector";
      selector?: string;
      elementKey?: string;
      timeoutMs?: number;
    }
  | {
      action: "wait";
      ms: number;
    }
  | {
      action: "waitForElement";
      selector?: string;
      elementKey?: string;
      timeoutMs?: number;
    }
  | {
      action: "captureElement";
      selector?: string;
      elementKey?: string;
      resultKey?: "qrCodeDataUrl";
      timeoutMs?: number;
    }
  | {
      action: "readText";
      selector?: string;
      elementKey?: string;
      resultKey?: string;
      timeoutMs?: number;
    }
  | {
      action: "readStorage";
      storage: "localStorage" | "sessionStorage" | "cookie";
      key: string;
      resultKey?: string;
      timeoutMs?: number;
    }
  | {
      action: "readIndexedDB";
      database: string;
      store: string;
      key?: string;
      resultKey?: string;
      limit?: number;
      timeoutMs?: number;
    }
  | {
      action: "navigateAllowedUrl";
      url: string;
    };

export interface MatrixAccountLoginScriptDsl {
  version: 1;
  purpose: MatrixAccountLoginScriptPurpose;
  steps: MatrixAccountLoginScriptStep[];
}

export interface MatrixAccountWebSpaceScriptInput extends MatrixAccountWebSpaceInput {
  scriptVersionId: string;
  purpose: MatrixAccountLoginScriptPurpose;
  dsl: MatrixAccountLoginScriptDsl;
}

export interface MatrixAccountWebSpaceScriptResult {
  webSpaceId: string;
  platform: MatrixAccountPlatform;
  browserPartition: string;
  scriptVersionId: string;
  status: MatrixAccountScriptRunStatus;
  qrCodeDataUrl?: string;
  accountCandidate?: {
    identityKey?: string;
    platformUid?: string;
    displayName?: string;
    nickname?: string;
    avatarUrl?: string;
    homeUrl?: string;
  };
  errorCode?: string;
  errorMessage?: string;
  durationMs: number;
}

export interface AiExecutorTerminalWindowInput {
  taskId: string;
  url: string;
  title?: string;
}

export interface AiExecutorTerminalWindowResult {
  taskId: string;
  opened: boolean;
  focusedExisting: boolean;
}

interface MatrixAccountBridgeLike {
  app?: {
    getVersion?: () => Promise<string>;
  };
  aiExecutor?: {
    openTerminalWindow?: (
      input: AiExecutorTerminalWindowInput
    ) => Promise<DesktopCommandResult<AiExecutorTerminalWindowResult>>;
  };
  matrixAccount?: {
    getCapabilities?: () => Promise<DesktopCommandResult<MatrixAccountCapabilities>>;
    startLogin?: (input: MatrixAccountBrowserInput) => Promise<DesktopCommandResult<MatrixAccountBrowserResult>>;
    openAccount?: (input: MatrixAccountBrowserInput) => Promise<DesktopCommandResult<MatrixAccountBrowserResult>>;
    checkSession?: (input: MatrixAccountBrowserInput) => Promise<DesktopCommandResult<MatrixAccountCheckResult>>;
    clearProfile?: (input: MatrixAccountBrowserInput) => Promise<DesktopCommandResult<MatrixAccountClearProfileResult>>;
    onLoginStateChanged?: (listener: (payload: MatrixAccountLoginStatePayload) => void) => () => void;
    createWebSpaceLogin?: (input: MatrixAccountWebSpaceInput) => Promise<DesktopCommandResult<MatrixAccountWebSpaceBrowserResult>>;
    openWebSpace?: (input: MatrixAccountWebSpaceInput) => Promise<DesktopCommandResult<MatrixAccountWebSpaceBrowserResult>>;
    detectWebSpaceAccount?: (input: MatrixAccountWebSpaceInput) => Promise<DesktopCommandResult<MatrixAccountWebSpaceDetectResult>>;
    clearWebSpace?: (input: MatrixAccountWebSpaceInput) => Promise<DesktopCommandResult<MatrixAccountWebSpaceClearResult>>;
    captureWebSpaceSnapshot?: (
      input: MatrixAccountWebSpaceSnapshotInput
    ) => Promise<DesktopCommandResult<MatrixAccountWebSpaceSnapshotResult>>;
    runWebSpaceLoginScript?: (
      input: MatrixAccountWebSpaceScriptInput
    ) => Promise<DesktopCommandResult<MatrixAccountWebSpaceScriptResult>>;
    onWebSpaceStateChanged?: (listener: (payload: MatrixAccountWebSpaceStatePayload) => void) => () => void;
    startAccountOnboarding?: (
      input: MatrixAccountOnboardingStartInput
    ) => Promise<DesktopCommandResult<MatrixAccountOnboardingView>>;
    getAccountOnboarding?: (
      input: MatrixAccountOnboardingLookupInput
    ) => Promise<DesktopCommandResult<MatrixAccountOnboardingView>>;
    getLoginQrCode?: (
      input: MatrixAccountOnboardingQrInput
    ) => Promise<DesktopCommandResult<MatrixAccountOnboardingQrCodeView>>;
    refreshLoginQrCode?: (
      input: MatrixAccountOnboardingRefreshQrInput
    ) => Promise<DesktopCommandResult<MatrixAccountOnboardingQrCodeView>>;
    cancelAccountOnboarding?: (
      input: MatrixAccountOnboardingCancelInput
    ) => Promise<DesktopCommandResult<MatrixAccountOnboardingView>>;
    sealSessionSnapshot?: (
      input: MatrixAccountSessionSnapshotSealInput
    ) => Promise<DesktopCommandResult<MatrixAccountSessionSnapshotVerificationResult>>;
    verifySessionSnapshot?: (
      input: MatrixAccountSessionSnapshotVerifyInput
    ) => Promise<DesktopCommandResult<MatrixAccountSessionSnapshotVerificationResult>>;
    restoreSessionSnapshot?: (
      input: MatrixAccountSessionSnapshotRestoreInput
    ) => Promise<DesktopCommandResult<MatrixAccountSessionSnapshotRestoreResult>>;
    cleanupSessionWebSpace?: (
      input: MatrixAccountSessionWebSpaceCleanupInput
    ) => Promise<DesktopCommandResult<MatrixAccountSessionWebSpaceCleanupResult>>;
    onAccountOnboardingEvent?: (listener: (payload: MatrixAccountOnboardingEvent) => void) => () => void;
  };
}

function matrixAccountBridge(): NonNullable<MatrixAccountBridgeLike["matrixAccount"]> | null {
  if (typeof window === "undefined") return null;
  return ((window as unknown as { aicrm?: MatrixAccountBridgeLike }).aicrm?.matrixAccount ?? null) as
    | NonNullable<MatrixAccountBridgeLike["matrixAccount"]>
    | null;
}

function aiExecutorBridge(): NonNullable<MatrixAccountBridgeLike["aiExecutor"]> | null {
  if (typeof window === "undefined") return null;
  return ((window as unknown as { aicrm?: MatrixAccountBridgeLike }).aicrm?.aiExecutor ?? null) as
    | NonNullable<MatrixAccountBridgeLike["aiExecutor"]>
    | null;
}

export function isAiCrmDesktopClientRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return typeof (window as unknown as { aicrm?: MatrixAccountBridgeLike }).aicrm?.app?.getVersion === "function";
}

export function hasMatrixAccountDesktopCapability(): boolean {
  const bridge = matrixAccountBridge();
  return typeof bridge?.startLogin === "function" && typeof bridge.openAccount === "function";
}

export function hasMatrixAccountWebSpaceDesktopCapability(): boolean {
  const bridge = matrixAccountBridge();
  return (
    typeof bridge?.createWebSpaceLogin === "function" &&
    typeof bridge.openWebSpace === "function" &&
    typeof bridge.detectWebSpaceAccount === "function"
  );
}

export function hasMatrixAccountLoginScriptDesktopCapability(): boolean {
  const bridge = matrixAccountBridge();
  return (
    hasMatrixAccountWebSpaceDesktopCapability() &&
    typeof bridge?.captureWebSpaceSnapshot === "function" &&
    typeof bridge.runWebSpaceLoginScript === "function"
  );
}

export function hasMatrixAccountOnboardingDesktopCapability(): boolean {
  const bridge = matrixAccountBridge();
  return (
    typeof bridge?.startAccountOnboarding === "function" &&
    typeof bridge.getAccountOnboarding === "function" &&
    typeof bridge.getLoginQrCode === "function" &&
    typeof bridge.refreshLoginQrCode === "function" &&
    typeof bridge.cancelAccountOnboarding === "function" &&
    typeof bridge.onAccountOnboardingEvent === "function"
  );
}

export function hasMatrixAccountSessionSnapshotVaultCapability(): boolean {
  const bridge = matrixAccountBridge();
  return (
    typeof bridge?.sealSessionSnapshot === "function" &&
    typeof bridge.verifySessionSnapshot === "function" &&
    typeof bridge.restoreSessionSnapshot === "function" &&
    typeof bridge.cleanupSessionWebSpace === "function"
  );
}

export function hasAiExecutorTerminalWindowCapability(): boolean {
  return typeof aiExecutorBridge()?.openTerminalWindow === "function";
}

export async function getMatrixAccountCapabilities(): Promise<MatrixAccountCapabilities | null> {
  const result = await matrixAccountBridge()?.getCapabilities?.();
  return result?.ok ? (result.data ?? null) : null;
}

export function startMatrixAccountLogin(
  input: MatrixAccountBrowserInput
): Promise<DesktopCommandResult<MatrixAccountBrowserResult>> {
  const bridge = matrixAccountBridge();
  if (!bridge?.startLogin) return Promise.resolve(missingBridgeResult());
  return bridge.startLogin(input);
}

export function openMatrixAccount(
  input: MatrixAccountBrowserInput
): Promise<DesktopCommandResult<MatrixAccountBrowserResult>> {
  const bridge = matrixAccountBridge();
  if (!bridge?.openAccount) return Promise.resolve(missingBridgeResult());
  return bridge.openAccount(input);
}

export function checkMatrixAccountSession(
  input: MatrixAccountBrowserInput
): Promise<DesktopCommandResult<MatrixAccountCheckResult>> {
  const bridge = matrixAccountBridge();
  if (!bridge?.checkSession) return Promise.resolve(missingBridgeResult());
  return bridge.checkSession(input);
}

export function clearMatrixAccountProfile(
  input: MatrixAccountBrowserInput
): Promise<DesktopCommandResult<MatrixAccountClearProfileResult>> {
  const bridge = matrixAccountBridge();
  if (!bridge?.clearProfile) return Promise.resolve(missingBridgeResult());
  return bridge.clearProfile(input);
}

export function onMatrixAccountLoginStateChanged(
  listener: (payload: MatrixAccountLoginStatePayload) => void
): () => void {
  return matrixAccountBridge()?.onLoginStateChanged?.(listener) ?? (() => undefined);
}

export function createMatrixAccountWebSpaceLogin(
  input: MatrixAccountWebSpaceInput
): Promise<DesktopCommandResult<MatrixAccountWebSpaceBrowserResult>> {
  const bridge = matrixAccountBridge();
  if (!bridge?.createWebSpaceLogin) return Promise.resolve(missingBridgeResult());
  return bridge.createWebSpaceLogin(input);
}

export function openMatrixAccountWebSpace(
  input: MatrixAccountWebSpaceInput
): Promise<DesktopCommandResult<MatrixAccountWebSpaceBrowserResult>> {
  const bridge = matrixAccountBridge();
  if (!bridge?.openWebSpace) return Promise.resolve(missingBridgeResult());
  return bridge.openWebSpace(input);
}

export function detectMatrixAccountWebSpace(
  input: MatrixAccountWebSpaceInput
): Promise<DesktopCommandResult<MatrixAccountWebSpaceDetectResult>> {
  const bridge = matrixAccountBridge();
  if (!bridge?.detectWebSpaceAccount) return Promise.resolve(missingBridgeResult());
  return bridge.detectWebSpaceAccount(input);
}

export function clearMatrixAccountWebSpace(
  input: MatrixAccountWebSpaceInput
): Promise<DesktopCommandResult<MatrixAccountWebSpaceClearResult>> {
  const bridge = matrixAccountBridge();
  if (!bridge?.clearWebSpace) return Promise.resolve(missingBridgeResult());
  return bridge.clearWebSpace(input);
}

export function captureMatrixAccountWebSpaceSnapshot(
  input: MatrixAccountWebSpaceSnapshotInput
): Promise<DesktopCommandResult<MatrixAccountWebSpaceSnapshotResult>> {
  const bridge = matrixAccountBridge();
  if (!bridge?.captureWebSpaceSnapshot) return Promise.resolve(missingBridgeResult());
  return bridge.captureWebSpaceSnapshot(input);
}

export function runMatrixAccountWebSpaceLoginScript(
  input: MatrixAccountWebSpaceScriptInput
): Promise<DesktopCommandResult<MatrixAccountWebSpaceScriptResult>> {
  const bridge = matrixAccountBridge();
  if (!bridge?.runWebSpaceLoginScript) return Promise.resolve(missingBridgeResult());
  return bridge.runWebSpaceLoginScript(input);
}

export function onMatrixAccountWebSpaceStateChanged(
  listener: (payload: MatrixAccountWebSpaceStatePayload) => void
): () => void {
  return matrixAccountBridge()?.onWebSpaceStateChanged?.(listener) ?? (() => undefined);
}

export function startMatrixAccountOnboarding(
  input: MatrixAccountOnboardingStartInput
): Promise<DesktopCommandResult<MatrixAccountOnboardingView>> {
  const bridge = matrixAccountBridge();
  if (!bridge?.startAccountOnboarding) return Promise.resolve(missingBridgeResult());
  return bridge.startAccountOnboarding(input);
}

export function getMatrixAccountOnboarding(
  attemptId: string
): Promise<DesktopCommandResult<MatrixAccountOnboardingView>> {
  const bridge = matrixAccountBridge();
  if (!bridge?.getAccountOnboarding) return Promise.resolve(missingBridgeResult());
  return bridge.getAccountOnboarding({ attemptId });
}

export function getMatrixAccountLoginQrCode(
  input: MatrixAccountOnboardingQrInput
): Promise<DesktopCommandResult<MatrixAccountOnboardingQrCodeView>> {
  const bridge = matrixAccountBridge();
  if (!bridge?.getLoginQrCode) return Promise.resolve(missingBridgeResult());
  return bridge.getLoginQrCode(input);
}

export function refreshMatrixAccountLoginQrCode(
  input: MatrixAccountOnboardingRefreshQrInput
): Promise<DesktopCommandResult<MatrixAccountOnboardingQrCodeView>> {
  const bridge = matrixAccountBridge();
  if (!bridge?.refreshLoginQrCode) return Promise.resolve(missingBridgeResult());
  return bridge.refreshLoginQrCode(input);
}

export function cancelMatrixAccountOnboarding(
  input: MatrixAccountOnboardingCancelInput
): Promise<DesktopCommandResult<MatrixAccountOnboardingView>> {
  const bridge = matrixAccountBridge();
  if (!bridge?.cancelAccountOnboarding) return Promise.resolve(missingBridgeResult());
  return bridge.cancelAccountOnboarding(input);
}

export function sealMatrixAccountSessionSnapshot(
  input: MatrixAccountSessionSnapshotSealInput
): Promise<DesktopCommandResult<MatrixAccountSessionSnapshotVerificationResult>> {
  const bridge = matrixAccountBridge();
  if (!bridge?.sealSessionSnapshot) return Promise.resolve(missingBridgeResult());
  return bridge.sealSessionSnapshot(input);
}

export function verifyMatrixAccountSessionSnapshot(
  input: MatrixAccountSessionSnapshotVerifyInput
): Promise<DesktopCommandResult<MatrixAccountSessionSnapshotVerificationResult>> {
  const bridge = matrixAccountBridge();
  if (!bridge?.verifySessionSnapshot) return Promise.resolve(missingBridgeResult());
  return bridge.verifySessionSnapshot(input);
}

export function restoreMatrixAccountSessionSnapshot(
  input: MatrixAccountSessionSnapshotRestoreInput
): Promise<DesktopCommandResult<MatrixAccountSessionSnapshotRestoreResult>> {
  const bridge = matrixAccountBridge();
  if (!bridge?.restoreSessionSnapshot) return Promise.resolve(missingBridgeResult());
  return bridge.restoreSessionSnapshot(input);
}

export function cleanupMatrixAccountSessionWebSpace(
  input: MatrixAccountSessionWebSpaceCleanupInput
): Promise<DesktopCommandResult<MatrixAccountSessionWebSpaceCleanupResult>> {
  const bridge = matrixAccountBridge();
  if (!bridge?.cleanupSessionWebSpace) return Promise.resolve(missingBridgeResult());
  return bridge.cleanupSessionWebSpace(input);
}

export function subscribeMatrixAccountOnboarding(
  attemptId: string,
  afterSequence: number,
  listener: (payload: MatrixAccountOnboardingEvent) => void
): () => void {
  let cursor = Number.isFinite(afterSequence) ? Math.max(0, Math.trunc(afterSequence)) : 0;
  return (
    matrixAccountBridge()?.onAccountOnboardingEvent?.((payload) => {
      if (payload.attemptId !== attemptId || payload.sequence <= cursor) return;
      cursor = payload.sequence;
      listener(payload);
    }) ?? (() => undefined)
  );
}

export function openAiExecutorTerminalWindow(
  input: AiExecutorTerminalWindowInput
): Promise<DesktopCommandResult<AiExecutorTerminalWindowResult>> {
  const bridge = aiExecutorBridge();
  if (!bridge?.openTerminalWindow) return Promise.resolve(missingBridgeResult());
  return bridge.openTerminalWindow(input);
}

function missingBridgeResult<T>(): DesktopCommandResult<T> {
  return {
    ok: false,
    error: {
      code: "desktop_bridge_unavailable",
      message: isAiCrmDesktopClientRuntime()
        ? "当前 AiCRM Desktop 客户端暂不支持矩阵账号登录态能力，请更新或重启客户端"
        : "请在 AiCRM Desktop 客户端中使用矩阵账号登录态能力"
    }
  };
}
