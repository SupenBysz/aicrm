export type WorkspaceType = "platform" | "agency" | "enterprise";

export interface DesktopConfig {
  apiBaseUrl: string;
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

export interface CodexExecutorAuthInput {
  executorId: string;
  name: string;
  codexHome?: string;
}

export interface CodexExecutorAuthResult {
  executorId: string;
  authStatus: "not_authorized" | "authorizing" | "authorized" | "expired" | "error";
  codexHome: string;
  authAccountLabel?: string;
  codexVersion?: string;
  capabilities?: Record<string, unknown>;
  command: string;
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
      selector: string;
      timeoutMs?: number;
    }
  | {
      action: "wait";
      ms: number;
    }
  | {
      action: "waitForElement";
      selector: string;
      timeoutMs?: number;
    }
  | {
      action: "captureElement";
      selector: string;
      resultKey?: "qrCodeDataUrl";
      timeoutMs?: number;
    }
  | {
      action: "readText";
      selector?: string;
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
