import type { RequestClient } from "@ky/admin-core";

export interface ListResult<T> {
  items: T[];
  pagination: { page: number; pageSize: number; total: number };
}

export interface Provider {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
  status: string;
  remark: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderInput {
  name: string;
  providerType?: string;
  baseUrl?: string;
  apiKey?: string;
  remark?: string;
}

export function listProviders(
  client: RequestClient,
  params: { status?: string; type?: string; page: number; pageSize: number }
): Promise<ListResult<Provider>> {
  const q = new URLSearchParams();
  q.set("page", String(params.page));
  q.set("pageSize", String(params.pageSize));
  if (params.status) q.set("status", params.status);
  if (params.type) q.set("type", params.type);
  return client.request<ListResult<Provider>>(`/api/v1/ai-models/providers?${q.toString()}`);
}

export function createProvider(client: RequestClient, input: ProviderInput): Promise<Provider> {
  return client.request<Provider>("/api/v1/ai-models/providers", { method: "POST", body: input });
}

export function updateProvider(client: RequestClient, id: string, input: ProviderInput): Promise<Provider> {
  return client.request<Provider>(`/api/v1/ai-models/providers/${id}`, { method: "PATCH", body: input });
}

export function updateProviderStatus(client: RequestClient, id: string, status: string): Promise<unknown> {
  return client.request(`/api/v1/ai-models/providers/${id}/status`, { method: "PATCH", body: { status } });
}

export function rotateProviderApiKey(client: RequestClient, id: string, apiKey: string): Promise<{ apiKeyMasked: string }> {
  return client.request<{ apiKeyMasked: string }>(`/api/v1/ai-models/providers/${id}/rotate-api-key`, {
    method: "POST",
    body: { apiKey }
  });
}

// --- models ---

export interface AiModel {
  id: string;
  providerId: string;
  name: string;
  modelKey: string;
  modelType: string;
  contextLength: number;
  defaultParameters: Record<string, unknown> | null;
  status: string;
  remark: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModelInput {
  providerId?: string;
  name: string;
  modelKey?: string;
  modelType?: string;
  contextLength?: number;
  remark?: string;
}

export function listModels(
  client: RequestClient,
  params: { providerId?: string; modelType?: string; status?: string; page: number; pageSize: number }
): Promise<ListResult<AiModel>> {
  const q = new URLSearchParams();
  q.set("page", String(params.page));
  q.set("pageSize", String(params.pageSize));
  if (params.providerId) q.set("providerId", params.providerId);
  if (params.modelType) q.set("modelType", params.modelType);
  if (params.status) q.set("status", params.status);
  return client.request<ListResult<AiModel>>(`/api/v1/ai-models/models?${q.toString()}`);
}

export function createModel(client: RequestClient, input: ModelInput): Promise<AiModel> {
  return client.request<AiModel>("/api/v1/ai-models/models", { method: "POST", body: input });
}

export function updateModel(client: RequestClient, id: string, input: ModelInput): Promise<AiModel> {
  return client.request<AiModel>(`/api/v1/ai-models/models/${id}`, { method: "PATCH", body: input });
}

export function updateModelStatus(client: RequestClient, id: string, status: string): Promise<unknown> {
  return client.request(`/api/v1/ai-models/models/${id}/status`, { method: "PATCH", body: { status } });
}

export interface ModelTestResult {
  ok: boolean;
  latencyMs: number;
  httpStatus: number;
  sampleOutput: string;
  promptTokens: number;
  totalTokens: number;
  errorCode?: string;
  errorMessage?: string;
}

/** Sends one real request to the model's provider to validate the credential + Base URL + model key + protocol. */
export function testModel(client: RequestClient, id: string, prompt?: string): Promise<ModelTestResult> {
  return client.request<ModelTestResult>(`/api/v1/ai-models/models/${id}/test`, {
    method: "POST",
    body: { prompt: prompt ?? "" }
  });
}

export function listAllProviders(client: RequestClient): Promise<ListResult<Provider>> {
  return listProviders(client, { page: 1, pageSize: 200 });
}

export function listAllModels(client: RequestClient): Promise<ListResult<AiModel>> {
  return listModels(client, { page: 1, pageSize: 200 });
}

// --- default model settings ---

export interface DefaultModelSettings {
  defaultChatModelId: string | null;
  defaultSummaryModelId: string | null;
  defaultEmbeddingModelId: string | null;
  defaultMultimodalModelId: string | null;
}

export function getDefaultModels(client: RequestClient): Promise<DefaultModelSettings> {
  return client.request<DefaultModelSettings>("/api/v1/ai-models/settings");
}

export function updateDefaultModels(client: RequestClient, input: Partial<DefaultModelSettings>): Promise<unknown> {
  return client.request("/api/v1/ai-models/settings", { method: "PATCH", body: input });
}

// --- AI executor config + tasks ---

export type AiExecutorStatus = "enabled" | "disabled";
export type AiExecutorRuntimeType = "desktop" | "server" | "remote";
export type AiExecutorAuthStatus = "not_authorized" | "authorizing" | "authorized" | "expired" | "error";
export type AiExecutorTaskStatus =
  | "pending"
  | "waiting_executor"
  | "running"
  | "waiting_user_scan"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export interface AiExecutorConfig {
  id: string;
  name: string;
  scopeType: string;
  scopeId: string;
  executorType: "codex";
  runtimeType: AiExecutorRuntimeType;
  status: AiExecutorStatus;
  isDefault: boolean;
  priority: number;
  autoRepairEnabled: boolean;
  triggerFailureCount: number;
  maxAttempts: number;
  taskTimeoutSeconds: number;
  maxConcurrency: number;
  allowPageActions: boolean;
  allowStorageRead: boolean;
  allowCdpRuntime: boolean;
  allowScriptSave: boolean;
  allowAutoActivate: boolean;
  appServerListen: string;
  authStatus: AiExecutorAuthStatus;
  authMethod: string;
  authAccountLabel: string;
  boundDeviceId: string;
  codexVersion: string;
  capabilities: Record<string, unknown>;
  lastHeartbeatAt: string | null;
  lastAuthCheckedAt: string | null;
  remark: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type AiExecutorConfigInput = Pick<
  AiExecutorConfig,
  | "name"
  | "executorType"
  | "runtimeType"
  | "status"
  | "isDefault"
  | "priority"
  | "autoRepairEnabled"
  | "triggerFailureCount"
  | "maxAttempts"
  | "taskTimeoutSeconds"
  | "maxConcurrency"
  | "allowPageActions"
  | "allowStorageRead"
  | "allowCdpRuntime"
  | "allowScriptSave"
  | "allowAutoActivate"
  | "appServerListen"
  | "remark"
>;

export interface AiExecutorAuthSession {
  executorId: string;
  runtimeType: AiExecutorRuntimeType;
  authMode: "desktop" | "device_auth";
  authStatus: AiExecutorAuthStatus;
  command: string;
  codexHome: string;
  verificationUri: string;
  userCode: string;
  expiresAt: string | null;
  message: string;
}

export interface AiExecutorAuthStatusInput {
  authStatus: AiExecutorAuthStatus;
  authMethod?: string;
  authAccountLabel?: string;
  boundDeviceId?: string;
  codexVersion?: string;
  capabilities?: Record<string, unknown>;
}

export interface AiExecutorTask {
  id: string;
  workspaceType: string;
  workspaceId: string;
  executorId: string;
  executorType: "codex";
  taskType: "script_repair";
  purpose: string;
  triggerReason: string;
  targetType: string;
  targetId: string;
  webSpaceId: string;
  scriptId: string;
  scriptVersionId: string;
  status: AiExecutorTaskStatus;
  codexThreadId: string;
  resultSummary: Record<string, unknown>;
  errorMessage: string;
  createdBy: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiExecutorTaskInput {
  executorId?: string;
  executorType?: "codex";
  taskType?: "script_repair";
  purpose?: string;
  triggerReason: string;
  targetType?: string;
  targetId?: string;
  webSpaceId?: string;
  scriptId?: string;
  scriptVersionId?: string;
  resultSummary?: Record<string, unknown>;
}

export interface AiExecutorEvent {
  id: string;
  taskId: string;
  sequence: number;
  eventType: string;
  level: "debug" | "info" | "success" | "warning" | "error";
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
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

export function getCodexExecutorConfig(client: RequestClient): Promise<AiExecutorConfig> {
  return client.request<AiExecutorConfig>("/api/v1/ai-executors/codex");
}

export function updateCodexExecutorConfig(client: RequestClient, input: AiExecutorConfigInput): Promise<AiExecutorConfig> {
  return client.request<AiExecutorConfig>("/api/v1/ai-executors/codex", { method: "PATCH", body: input });
}

export function listAiExecutors(
  client: RequestClient,
  params: { status?: string; runtimeType?: string; executorType?: string; page: number; pageSize: number }
): Promise<ListResult<AiExecutorConfig>> {
  const q = new URLSearchParams();
  q.set("page", String(params.page));
  q.set("pageSize", String(params.pageSize));
  if (params.status) q.set("status", params.status);
  if (params.runtimeType) q.set("runtimeType", params.runtimeType);
  if (params.executorType) q.set("executorType", params.executorType);
  return client.request<ListResult<AiExecutorConfig>>(`/api/v1/ai-executors?${q.toString()}`);
}

export function createAiExecutor(client: RequestClient, input: AiExecutorConfigInput): Promise<AiExecutorConfig> {
  return client.request<AiExecutorConfig>("/api/v1/ai-executors", { method: "POST", body: input });
}

export function updateAiExecutor(client: RequestClient, id: string, input: AiExecutorConfigInput): Promise<AiExecutorConfig> {
  return client.request<AiExecutorConfig>(`/api/v1/ai-executors/${id}`, { method: "PATCH", body: input });
}

export function authorizeAiExecutor(client: RequestClient, id: string): Promise<AiExecutorAuthSession> {
  return client.request<AiExecutorAuthSession>(`/api/v1/ai-executors/${id}/authorize`, { method: "POST" });
}

export function syncAiExecutorAuthStatus(
  client: RequestClient,
  id: string,
  input: AiExecutorAuthStatusInput
): Promise<AiExecutorConfig> {
  return client.request<AiExecutorConfig>(`/api/v1/ai-executors/${id}/auth-status`, { method: "POST", body: input });
}

export function listAiExecutorTasks(
  client: RequestClient,
  params: { status?: string; executorType?: string; page: number; pageSize: number }
): Promise<ListResult<AiExecutorTask>> {
  const q = new URLSearchParams();
  q.set("page", String(params.page));
  q.set("pageSize", String(params.pageSize));
  if (params.status) q.set("status", params.status);
  if (params.executorType) q.set("executorType", params.executorType);
  return client.request<ListResult<AiExecutorTask>>(`/api/v1/ai-executor-tasks?${q.toString()}`);
}

export function createAiExecutorTask(client: RequestClient, input: AiExecutorTaskInput): Promise<AiExecutorTask> {
  return client.request<AiExecutorTask>("/api/v1/ai-executor-tasks", {
    method: "POST",
    body: {
      executorType: "codex",
      taskType: "script_repair",
      ...input
    }
  });
}

export function cancelAiExecutorTask(client: RequestClient, id: string): Promise<AiExecutorTask> {
  return client.request<AiExecutorTask>(`/api/v1/ai-executor-tasks/${id}/cancel`, { method: "POST" });
}

export function listAiExecutorEvents(client: RequestClient, id: string, after = 0): Promise<AiExecutorEvent[]> {
  return client.request<AiExecutorEvent[]>(`/api/v1/ai-executor-tasks/${id}/events?after=${after}`);
}

export function listAiExecutorRawLogs(client: RequestClient, id: string, after = 0): Promise<AiExecutorRawLog[]> {
  return client.request<AiExecutorRawLog[]>(`/api/v1/ai-executor-tasks/${id}/raw-logs?after=${after}`);
}
