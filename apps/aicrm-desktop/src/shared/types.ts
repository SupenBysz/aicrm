export type WorkspaceType = "platform" | "agency" | "enterprise";

export interface DesktopConfig {
  apiBaseUrl: string;
  debugMode?: boolean;
  programTitle?: string;
  webUrl: string;
}

export interface DesktopSession {
  token: string;
  expiresAt: string;
}

export interface CurrentUser {
  id: string;
  username?: string;
  displayName: string;
  avatarUrl: string;
  phone?: string;
  email?: string;
}

export interface WorkspaceRole {
  id: string;
  code: string;
  name: string;
}

export interface WorkspaceDataScope {
  scopeType: string;
  departmentIds?: string[];
  teamIds?: string[];
  agencyIds?: string[];
  enterpriseIds?: string[];
}

export interface WorkspaceIdentity {
  id: string;
  type: WorkspaceType;
  name: string;
  membershipId: string;
  roles: WorkspaceRole[];
  permissions: string[];
  actionPermissions: string[];
  menuKeys: string[];
  dataScopes: WorkspaceDataScope[];
}

export interface BootstrapState {
  user: CurrentUser;
  workspaces: WorkspaceIdentity[];
  recommendedWorkspaceId?: string | null;
}

export interface LoginInput {
  account: string;
  password: string;
}

export interface LoginResult extends DesktopSession {
  user: Pick<CurrentUser, "id" | "username" | "displayName" | "avatarUrl">;
}

export interface ApiEnvelope<T> {
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
}

export interface DesktopApiRequest {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  token?: string;
}

export interface DesktopApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  envelope: ApiEnvelope<T>;
}

export interface DesktopWindowState {
  platform: NodeJS.Platform;
  isMaximized: boolean;
  isMinimized: boolean;
  isFullScreen: boolean;
  isFocused: boolean;
  isAlwaysOnTop: boolean;
}

export interface DesktopOpenDevToolsResult {
  opened: boolean;
  reason?: "production" | "unavailable";
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

export interface CodexExecutorAuthStatusProjection {
  bridgeVersion: 1;
  authStatus: "not_authorized";
  appServerListen: "stdio://";
  capabilities: {
    trustedAuthorization: false;
  };
  message: string;
}

export type MatrixAccountPlatform = "douyin" | "kuaishou" | "xiaohongshu";

export type MatrixAccountLoginStatus =
  | "not_logged_in"
  | "login_pending"
  | "online"
  | "expired"
  | "verify_required"
  | "risk"
  | "unknown";

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
  workspaceType: WorkspaceType;
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

export type MatrixAccountSessionSnapshotVerificationResult = MatrixAccountSessionSnapshotView;

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
  workspaceType: WorkspaceType;
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
  workspaceType: WorkspaceType;
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
  /**
   * A deterministic key derived from a public, unique DOM attribute such as
   * data-testid or id. Login scripts should prefer this over a CSS selector.
   */
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

export type DesktopNetworkLogStatus = "completed" | "failed";

export interface DesktopNetworkLogEntry {
  id: string;
  status: DesktopNetworkLogStatus;
  method: string;
  url: string;
  resourceType: string;
  statusCode?: number;
  error?: string;
  startedAt: string;
  completedAt: string;
  durationMs?: number;
}

export interface DesktopNetworkLogSnapshot {
  enabled: boolean;
  maxEntries: number;
  entries: DesktopNetworkLogEntry[];
}
