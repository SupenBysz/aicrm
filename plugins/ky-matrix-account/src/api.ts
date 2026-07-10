import type {
  MatrixAccountLoginScriptDsl,
  MatrixAccountLoginScriptPurpose,
  MatrixAccountPlatform,
  MatrixAccountScriptRunStatus,
  MatrixAccountWebSpaceScriptResult,
  MatrixAccountWebSpaceSnapshotResult,
  RequestClient
} from "@ky/admin-core";

export interface ListResult<T> {
  items: T[];
  pagination: { page: number; pageSize: number; total: number };
}

export type MatrixAccountStatus = "normal" | "disabled";
export type MatrixAccountLoginStatus =
  | "not_logged_in"
  | "login_pending"
  | "online"
  | "expired"
  | "verify_required"
  | "risk"
  | "unknown";

export interface MatrixAccount {
  id: string;
  platform: MatrixAccountPlatform;
  platformIdentityKey: string;
  identitySource: string;
  displayName: string;
  platformUid: string;
  nickname: string;
  avatarUrl: string;
  homeUrl: string;
  browserPartition: string;
  ownerMemberId: string;
  ownerName: string;
  departmentName: string;
  teamName: string;
  loginStatus: MatrixAccountLoginStatus;
  status: MatrixAccountStatus;
  remark: string;
  lastLoginAt: string | null;
  lastCheckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MatrixAccountInput {
  displayName: string;
  platform?: MatrixAccountPlatform;
  platformUid?: string;
  nickname?: string;
  homeUrl?: string;
  ownerMemberId?: string;
  departmentId?: string;
  teamId?: string;
  remark?: string;
}

export type MatrixAccountWebSpaceStatus =
  | "created"
  | "opening"
  | "waiting_login"
  | "detected"
  | "bound"
  | "detect_failed"
  | "abandoned"
  | "cleared";

export interface MatrixAccountWebSpace {
  id: string;
  workspaceType: string;
  workspaceId: string;
  platform: MatrixAccountPlatform;
  memberId: string;
  deviceId: string;
  browserPartition: string;
  accountId: string;
  status: MatrixAccountWebSpaceStatus;
  detectedIdentityKey: string;
  detectedPlatformUid: string;
  detectedNickname: string;
  detectedAvatarUrl: string;
  detectedHomeUrl: string;
  lastOpenedAt: string | null;
  detectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MatrixAccountDetectResultInput {
  identityKey?: string;
  platformUid?: string;
  displayName?: string;
  nickname?: string;
  avatarUrl?: string;
  homeUrl?: string;
  browserPartition?: string;
  deviceId?: string;
  loginStatus?: string;
}

export interface MatrixAccountBindResult {
  webSpace: MatrixAccountWebSpace;
  account: MatrixAccount | null;
  created: boolean;
}

export type MatrixAccountLoginScriptStatus = "enabled" | "disabled" | "learning" | "failed";
export type MatrixAccountLoginScriptVersionStatus = "candidate" | "active" | "archived" | "failed";
export type MatrixAccountLoginScriptUsageSource = "provider" | "estimated" | "unknown";

export interface MatrixAccountLoginScript {
  id: string;
  workspaceType: string;
  workspaceId: string;
  platform: MatrixAccountPlatform;
  purpose: MatrixAccountLoginScriptPurpose;
  urlPattern: string;
  pageFingerprint: string;
  activeVersionId: string;
  modelId: string;
  status: MatrixAccountLoginScriptStatus;
  failureThreshold: number;
  successCount: number;
  failureCount: number;
  consecutiveFailureCount: number;
  generationCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  lastSuccessAt: string | null;
  lastFailedAt: string | null;
  lastFailureReason: string;
  createdAt: string;
  updatedAt: string;
}

export interface MatrixAccountLoginScriptVersion {
  id: string;
  scriptId: string;
  version: number;
  modelId: string;
  dsl: MatrixAccountLoginScriptDsl;
  source: "ai_generated" | "manual" | "imported";
  status: MatrixAccountLoginScriptVersionStatus;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageSource: MatrixAccountLoginScriptUsageSource;
  generationReason: string;
  createdAt: string;
}

export interface MatrixAccountLoginScriptResolveResult {
  script: MatrixAccountLoginScript | null;
  version: MatrixAccountLoginScriptVersion | null;
  shouldGenerate: boolean;
  reason: string;
  failureThreshold: number;
  modelId: string;
}

export interface MatrixAccountLoginScriptGenerateInput {
  purpose: MatrixAccountLoginScriptPurpose;
  pageFingerprint: string;
  url: string;
  title: string;
  snapshot: MatrixAccountWebSpaceSnapshotResult;
  modelId?: string;
  generationReason?: string;
}

export interface MatrixAccountLoginScriptRunResultInput {
  scriptId?: string;
  scriptVersionId?: string;
  purpose: MatrixAccountLoginScriptPurpose;
  status: MatrixAccountScriptRunStatus;
  errorCode?: string;
  errorMessage?: string;
  durationMs?: number;
  resultSummary?: Partial<MatrixAccountWebSpaceScriptResult>;
}

export interface MatrixAccountLoginScriptRunLog {
  purpose: MatrixAccountLoginScriptPurpose;
  version: number;
  versionStatus: string;
  versionSource: string;
  status: MatrixAccountScriptRunStatus;
  errorCode: string;
  reasonCode: string;
  durationMs: number;
  resultSummary: Record<string, unknown>;
  createdAt: string;
}

export interface MatrixAccountListParams {
  platform: MatrixAccountPlatform;
  keyword?: string;
  loginStatus?: string;
  status?: string;
  page: number;
  pageSize: number;
}

function query(params: MatrixAccountListParams): string {
  const q = new URLSearchParams();
  q.set("platform", params.platform);
  q.set("page", String(params.page));
  q.set("pageSize", String(params.pageSize));
  if (params.keyword) q.set("keyword", params.keyword);
  if (params.loginStatus) q.set("loginStatus", params.loginStatus);
  if (params.status) q.set("status", params.status);
  return q.toString();
}

export function listMatrixAccounts(
  client: RequestClient,
  params: MatrixAccountListParams
): Promise<ListResult<MatrixAccount>> {
  return client.request<ListResult<MatrixAccount>>(`/api/v1/matrix-accounts?${query(params)}`);
}

export function createMatrixAccount(client: RequestClient, input: MatrixAccountInput): Promise<MatrixAccount> {
  return client.request<MatrixAccount>("/api/v1/matrix-accounts", { method: "POST", body: input });
}

export function deleteMatrixAccount(client: RequestClient, id: string): Promise<{ deleted: boolean }> {
  return client.request<{ deleted: boolean }>(`/api/v1/matrix-accounts/${id}`, { method: "DELETE" });
}

export function createMatrixAccountWebSpace(
  client: RequestClient,
  input: { platform: MatrixAccountPlatform; deviceId?: string }
): Promise<MatrixAccountWebSpace> {
  return client.request<MatrixAccountWebSpace>("/api/v1/matrix-account-web-spaces", { method: "POST", body: input });
}

export function getMatrixAccountWebSpace(client: RequestClient, id: string): Promise<MatrixAccountWebSpace> {
  return client.request<MatrixAccountWebSpace>(`/api/v1/matrix-account-web-spaces/${id}`);
}

export function submitMatrixAccountWebSpaceDetectResult(
  client: RequestClient,
  id: string,
  input: MatrixAccountDetectResultInput
): Promise<MatrixAccountBindResult> {
  return client.request<MatrixAccountBindResult>(`/api/v1/matrix-account-web-spaces/${id}/detect-result`, {
    method: "POST",
    body: input
  });
}

export function resolveMatrixAccountLoginScript(
  client: RequestClient,
  id: string,
  input: { purpose: MatrixAccountLoginScriptPurpose; pageFingerprint?: string; url?: string; modelId?: string }
): Promise<MatrixAccountLoginScriptResolveResult> {
  return client.request<MatrixAccountLoginScriptResolveResult>(
    `/api/v1/matrix-account-web-spaces/${id}/login-script/resolve`,
    {
      method: "POST",
      body: input
    }
  );
}

export function generateMatrixAccountLoginScript(
  client: RequestClient,
  id: string,
  input: MatrixAccountLoginScriptGenerateInput
): Promise<MatrixAccountLoginScriptResolveResult> {
  return client.request<MatrixAccountLoginScriptResolveResult>(
    `/api/v1/matrix-account-web-spaces/${id}/login-script/generate`,
    {
      method: "POST",
      body: input
    }
  );
}

export function submitMatrixAccountLoginScriptRunResult(
  client: RequestClient,
  id: string,
  input: MatrixAccountLoginScriptRunResultInput
): Promise<MatrixAccountLoginScriptResolveResult> {
  return client.request<MatrixAccountLoginScriptResolveResult>(
    `/api/v1/matrix-account-web-spaces/${id}/login-script/run-result`,
    {
      method: "POST",
      body: input
    }
  );
}

export function listMatrixAccountLoginScriptRuns(
  client: RequestClient,
  id: string,
  limit = 30
): Promise<MatrixAccountLoginScriptRunLog[]> {
  return client.request<MatrixAccountLoginScriptRunLog[]>(
    `/api/v1/matrix-account-web-spaces/${id}/login-script/runs?limit=${limit}`
  );
}

export interface MatrixAccountLoginScriptListParams {
  platform?: MatrixAccountPlatform;
  purpose?: MatrixAccountLoginScriptPurpose;
  status?: MatrixAccountLoginScriptStatus | "";
  page?: number;
  pageSize?: number;
}

function loginScriptQuery(params: MatrixAccountLoginScriptListParams): string {
  const q = new URLSearchParams();
  if (params.platform) q.set("platform", params.platform);
  if (params.purpose) q.set("purpose", params.purpose);
  if (params.status) q.set("status", params.status);
  q.set("page", String(params.page ?? 1));
  q.set("pageSize", String(params.pageSize ?? 50));
  return q.toString();
}

export function listMatrixAccountLoginScripts(
  client: RequestClient,
  params: MatrixAccountLoginScriptListParams
): Promise<ListResult<MatrixAccountLoginScript>> {
  return client.request<ListResult<MatrixAccountLoginScript>>(`/api/v1/matrix-account-login-scripts?${loginScriptQuery(params)}`);
}

export function getMatrixAccountLoginScript(client: RequestClient, id: string): Promise<MatrixAccountLoginScript> {
  return client.request<MatrixAccountLoginScript>(`/api/v1/matrix-account-login-scripts/${id}`);
}

export function listMatrixAccountLoginScriptVersions(
  client: RequestClient,
  id: string
): Promise<MatrixAccountLoginScriptVersion[]> {
  return client.request<MatrixAccountLoginScriptVersion[]>(`/api/v1/matrix-account-login-scripts/${id}/versions`);
}

export function updateMatrixAccountLoginScriptStatus(
  client: RequestClient,
  id: string,
  status: "enabled" | "disabled"
): Promise<MatrixAccountLoginScript> {
  return client.request<MatrixAccountLoginScript>(`/api/v1/matrix-account-login-scripts/${id}/status`, {
    method: "PATCH",
    body: { status }
  });
}

export function activateMatrixAccountLoginScriptVersion(
  client: RequestClient,
  id: string,
  versionId: string
): Promise<MatrixAccountLoginScriptVersion> {
  return client.request<MatrixAccountLoginScriptVersion>(
    `/api/v1/matrix-account-login-scripts/${id}/versions/${versionId}/activate`,
    { method: "POST" }
  );
}

export function abandonMatrixAccountWebSpace(client: RequestClient, id: string): Promise<MatrixAccountWebSpace> {
  return client.request<MatrixAccountWebSpace>(`/api/v1/matrix-account-web-spaces/${id}/abandon`, { method: "POST" });
}

export function clearMatrixAccountWebSpaceRecord(client: RequestClient, id: string): Promise<MatrixAccountWebSpace> {
  return client.request<MatrixAccountWebSpace>(`/api/v1/matrix-account-web-spaces/${id}/clear`, { method: "POST" });
}

export function updateMatrixAccount(
  client: RequestClient,
  id: string,
  input: MatrixAccountInput
): Promise<MatrixAccount> {
  return client.request<MatrixAccount>(`/api/v1/matrix-accounts/${id}`, { method: "PATCH", body: input });
}

export function updateMatrixAccountStatus(
  client: RequestClient,
  id: string,
  status: MatrixAccountStatus
): Promise<{ id: string; status: MatrixAccountStatus }> {
  return client.request<{ id: string; status: MatrixAccountStatus }>(`/api/v1/matrix-accounts/${id}/status`, {
    method: "PATCH",
    body: { status }
  });
}

export function batchCheckMatrixAccounts(
  client: RequestClient,
  ids: string[]
): Promise<{ success: number; failed: number; failures: Array<{ id: string; reason: string }> }> {
  return client.request("/api/v1/matrix-accounts:batch-check", { method: "POST", body: { ids } });
}

export interface AiExecutorTask {
  id: string;
  runId?: string;
  executorId: string;
  executorType: string;
  taskType: "script_repair";
  purpose: MatrixAccountLoginScriptPurpose | "";
  triggerReason: string;
  webSpaceId: string;
  scriptId: string;
  scriptVersionId: string;
  status: string;
  resultSummary?: Record<string, unknown>;
  errorMessage?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface AiExecutorRun extends AiExecutorTask {
  runId: string;
  threadId?: string;
}

export interface AiExecutorConfigSummary {
  id: string;
  name: string;
  executorType: string;
  runtimeType?: string;
}

export interface AiExecutorRawLog {
  id: string;
  taskId: string;
  sequence: number;
  source: "codex" | "executor" | "mcp" | "electron" | "system";
  direction: "in" | "out" | "internal";
  rawText: string;
  rawJson: Record<string, unknown>;
  terminalLine: string;
  createdAt: string;
}

export interface AiExecutorEvent {
  id: string;
  runId?: string;
  taskId: string;
  sequence: number;
  eventType: string;
  level: "debug" | "info" | "success" | "warning" | "error";
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AiExecutorTerminalFrame {
  id: string;
  runId: string;
  taskId: string;
  frameSeq: number;
  sequence: number;
  encoding: "utf8" | "base64";
  payload: string;
  byteLength: number;
  source: "codex" | "executor" | "mcp" | "electron" | "system";
  direction: "in" | "out" | "internal";
  rawJson?: Record<string, unknown>;
  createdAt: string;
}

export function createMatrixAccountRepairTask(
  client: RequestClient,
  input: {
    purpose: MatrixAccountLoginScriptPurpose;
    triggerReason: string;
    webSpaceId: string;
    scriptId?: string;
    scriptVersionId?: string;
    resultSummary?: Record<string, unknown>;
  }
): Promise<AiExecutorTask> {
  return client.request<AiExecutorTask>("/api/v1/ai-executor-tasks", {
    method: "POST",
    body: {
      executorType: "codex",
      taskType: "script_repair",
      targetType: "matrix_account_web_space",
      targetId: input.webSpaceId,
      purpose: input.purpose,
      triggerReason: input.triggerReason,
      webSpaceId: input.webSpaceId,
      scriptId: input.scriptId ?? "",
      scriptVersionId: input.scriptVersionId ?? "",
      resultSummary: input.resultSummary ?? {}
    }
  });
}

export function getAiExecutorTask(client: RequestClient, id: string): Promise<AiExecutorTask> {
  return client.request<AiExecutorTask>(`/api/v1/ai-executor-tasks/${id}`);
}

export function getAiExecutorRun(client: RequestClient, id: string): Promise<AiExecutorRun> {
  return client.request<AiExecutorRun>(`/api/v1/ai-executor-runs/${id}`);
}

export function getAiExecutorConfig(client: RequestClient, id: string): Promise<AiExecutorConfigSummary> {
  return client.request<AiExecutorConfigSummary>(`/api/v1/ai-executors/${id}`);
}

export function listAiExecutorEvents(client: RequestClient, id: string, after = 0): Promise<AiExecutorEvent[]> {
  return client.request<AiExecutorEvent[]>(`/api/v1/ai-executor-tasks/${id}/events?after=${after}`);
}

export function listAiExecutorRunEvents(client: RequestClient, id: string, after = 0): Promise<AiExecutorEvent[]> {
  return client.request<AiExecutorEvent[]>(`/api/v1/ai-executor-runs/${id}/events?after=${after}`);
}

export function listAiExecutorRawLogs(client: RequestClient, id: string, after = 0): Promise<AiExecutorRawLog[]> {
  return client.request<AiExecutorRawLog[]>(`/api/v1/ai-executor-tasks/${id}/raw-logs?after=${after}`);
}

export function listAiExecutorTerminalFrames(client: RequestClient, id: string, afterFrame = 0): Promise<AiExecutorTerminalFrame[]> {
  return client.request<AiExecutorTerminalFrame[]>(`/api/v1/ai-executor-runs/${id}/terminal-frames?afterFrame=${afterFrame}`);
}

export function resizeAiExecutorTerminal(client: RequestClient, id: string, cols: number, rows: number): Promise<{ runId: string; cols: number; rows: number; accepted: boolean }> {
  return client.request(`/api/v1/ai-executor-runs/${id}/terminal-resize`, {
    method: "POST",
    body: { cols, rows }
  });
}
