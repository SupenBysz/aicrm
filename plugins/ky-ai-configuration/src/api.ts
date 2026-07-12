import type { EventStreamSubscription, RequestClient } from "@ky/admin-core";

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

// --- Agent Executor canonical control plane ---

export type AiExecutorStatus = "enabled" | "disabled";
export type AiExecutorRuntimeType = "desktop" | "server";
export type AiExecutorCredentialStatus = "unknown" | "not_authorized" | "authorized" | "expired" | "revoked";
export type AiExecutorReadinessStatus = "unknown" | "checking" | "ready" | "degraded" | "unavailable";

export interface AiExecutorConfig {
  id: string;
  name: string;
  executorType: "codex";
  runtimeType: AiExecutorRuntimeType;
  status: AiExecutorStatus;
  isDefault: boolean;
  defaultModelKey: string | null;
  configRevision: number;
  credentialStatus: AiExecutorCredentialStatus;
  currentCredentialRevision: number | null;
  catalogRevision: number;
  readinessStatus: AiExecutorReadinessStatus;
  readinessReasonCode: string;
  readinessRevision: number;
  allowScriptSave: boolean;
  autoRepairEnabled: boolean;
  triggerFailureCount: number;
  maxAttempts: number;
  taskTimeoutSeconds: number;
  revocationEpoch: number;
  scriptMaintenanceReady: boolean;
  readinessObservedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiExecutorCreateInput {
  name: string;
  runtimeType: AiExecutorRuntimeType;
  status?: AiExecutorStatus;
  isDefault?: boolean;
  allowScriptSave?: boolean;
  autoRepairEnabled?: boolean;
  triggerFailureCount?: number;
  maxAttempts?: number;
  taskTimeoutSeconds?: number;
}

export interface AiExecutorPatchInput {
  expectedRevision: number;
  name?: string;
  status?: AiExecutorStatus;
  isDefault?: boolean;
  defaultModelKey?: string | null;
  allowScriptSave?: boolean;
  autoRepairEnabled?: boolean;
  triggerFailureCount?: number;
  maxAttempts?: number;
  taskTimeoutSeconds?: number;
}

export interface AiExecutorModelCatalogItem {
  catalogItemId: string;
  modelKey: string;
  displayName: string;
  inputModalities: string[];
  supportedReasoningEfforts: string[];
  hidden: boolean;
  upgradeModelKey?: string;
  status: string;
  catalogRevision: number;
  codexVersion: string;
  lastSeenAt: string;
}

export interface AiExecutorWorkspaceGrant {
  id: string;
  executorId: string;
  workspaceType: "platform" | "agency" | "enterprise";
  workspaceId: string;
  status: "enabled" | "disabled";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type AiExecutorAuthorizationIntent = "authorize" | "change_account";
export type AiExecutorAuthorizationStatus =
  | "starting"
  | "waiting_user"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "interrupted"
  | "superseded";

export interface AiExecutorAuthorizationSession {
  id: string;
  executorId: string;
  runtimeType: AiExecutorRuntimeType;
  flowType: string;
  intent: AiExecutorAuthorizationIntent;
  status: AiExecutorAuthorizationStatus;
  sequence: number;
  revision: number;
  userActionRequired: boolean;
  sessionDeadlineAt: string;
  accountSummary: Record<string, unknown>;
  failure: { code: string } | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiExecutorAuthorizationUserAction {
  verificationUrl: string;
  userCode: string;
  sessionDeadlineAt: string;
}

export type AiExecutorAuthorizationEventName =
  | "authorization.session.changed"
  | "authorization.session.terminal"
  | "authorization.stream.closed";

export interface AiExecutorAuthorizationEventData {
  sessionId: string;
  sequence: number;
  occurredAt?: string;
  session?: AiExecutorAuthorizationSession;
  reason?: "terminal" | string;
}

export interface AiExecutorAuthorizationHistoryItem {
  sequence: number;
  event: AiExecutorAuthorizationEventName;
  occurredAt: string;
  data: AiExecutorAuthorizationEventData;
}

export interface AiExecutorAuthorizationHistory {
  items: AiExecutorAuthorizationHistoryItem[];
  nextSequence: number;
  hasMore: boolean;
}

export interface AiExecutorAuthorizationWatcher {
  after?: number;
  signal?: AbortSignal;
  onSession: (session: AiExecutorAuthorizationSession) => void;
  onClosed?: (reason: string) => void;
  onOpen?: () => void;
  onError?: (error: unknown) => void;
}

export interface AiExecutorAsyncCommand {
  taskId?: string;
  operationId?: string;
  status: "pending" | "awaiting_device";
  commandTicket?: string;
  expiresAt?: string;
}

/**
 * Catalog refresh/readiness/credential command routes are locked in the v9.1
 * contract but are not registered by the current service build. Keeping this
 * false prevents a UI click from falling through to a legacy service route.
 */
export const AI_EXECUTOR_COMMAND_ROUTES_READY = false;

/** Desktop authorization remains blocked until device identity + handoff APIs are wired end to end. */
export const AI_EXECUTOR_DESKTOP_HANDOFF_READY = false;

export type AiExecutorTaskStatus =
  | "pending"
  | "waiting_executor"
  | "running"
  | "waiting_user_scan"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

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
  tokenUsage?: AiExecutorTokenUsage;
  createdBy: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiExecutorTokenUsage {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
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
  return client
    .request<{ items: AiExecutorConfig[]; pagination?: ListResult<AiExecutorConfig>["pagination"] }>(
      `/api/v1/ai-executors?${q.toString()}`
    )
    .then((result) => {
      if (result.pagination) return { items: result.items, pagination: result.pagination };
      const filtered = result.items.filter(
        (item) =>
          (!params.status || item.status === params.status) &&
          (!params.runtimeType || item.runtimeType === params.runtimeType) &&
          (!params.executorType || item.executorType === params.executorType)
      );
      const start = (params.page - 1) * params.pageSize;
      return {
        items: filtered.slice(start, start + params.pageSize),
        pagination: { page: params.page, pageSize: params.pageSize, total: filtered.length }
      };
    });
}

export function getAiExecutor(client: RequestClient, id: string): Promise<AiExecutorConfig> {
  return client.request<AiExecutorConfig>(`/api/v1/ai-executors/${id}`);
}

export function createAiExecutor(
  client: RequestClient,
  input: AiExecutorCreateInput,
  key = newIdempotencyKey()
): Promise<AiExecutorConfig> {
  return client.request<AiExecutorConfig>("/api/v1/ai-executors", {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: input
  });
}

export function updateAiExecutor(client: RequestClient, id: string, input: AiExecutorPatchInput): Promise<AiExecutorConfig> {
  return client.request<AiExecutorConfig>(`/api/v1/ai-executors/${id}`, { method: "PATCH", body: input });
}

export function listAiExecutorModels(
  client: RequestClient,
  id: string,
  includeHidden = false
): Promise<{ items: AiExecutorModelCatalogItem[] }> {
  return client.request<{ items: AiExecutorModelCatalogItem[] }>(
    `/api/v1/ai-executors/${id}/models?includeHidden=${includeHidden ? "true" : "false"}`
  );
}

export function listAiExecutorWorkspaceGrants(
  client: RequestClient,
  id: string
): Promise<{ items: AiExecutorWorkspaceGrant[] }> {
  return client.request<{ items: AiExecutorWorkspaceGrant[] }>(`/api/v1/ai-executors/${id}/workspace-grants`);
}

export function putAiExecutorWorkspaceGrant(
  client: RequestClient,
  executorId: string,
  workspaceType: AiExecutorWorkspaceGrant["workspaceType"],
  workspaceId: string,
  expectedRevision: number
): Promise<AiExecutorWorkspaceGrant> {
  return client.request<AiExecutorWorkspaceGrant>(
    `/api/v1/ai-executors/${executorId}/workspace-grants/${workspaceType}/${workspaceId}`,
    { method: "PUT", body: { expectedRevision } }
  );
}

export function deleteAiExecutorWorkspaceGrant(
  client: RequestClient,
  grant: Pick<AiExecutorWorkspaceGrant, "executorId" | "workspaceType" | "workspaceId" | "revision">
): Promise<AiExecutorWorkspaceGrant> {
  return client.request<AiExecutorWorkspaceGrant>(
    `/api/v1/ai-executors/${grant.executorId}/workspace-grants/${grant.workspaceType}/${grant.workspaceId}`,
    { method: "DELETE", body: { expectedRevision: grant.revision } }
  );
}

export function refreshAiExecutorModelCatalog(
  client: RequestClient,
  executor: Pick<AiExecutorConfig, "id" | "configRevision" | "catalogRevision">,
  key = newIdempotencyKey()
): Promise<AiExecutorAsyncCommand> {
  return client.request<AiExecutorAsyncCommand>(`/api/v1/ai-executors/${executor.id}/model-catalog/refresh`, {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: { expectedExecutorRevision: executor.configRevision, expectedCatalogRevision: executor.catalogRevision }
  });
}

export function checkAiExecutorReadiness(
  client: RequestClient,
  executor: Pick<AiExecutorConfig, "id" | "configRevision" | "currentCredentialRevision" | "catalogRevision">,
  key = newIdempotencyKey()
): Promise<AiExecutorAsyncCommand> {
  return client.request<AiExecutorAsyncCommand>(`/api/v1/ai-executors/${executor.id}/readiness/check`, {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: {
      expectedExecutorRevision: executor.configRevision,
      expectedCredentialRevision: executor.currentCredentialRevision,
      expectedCatalogRevision: executor.catalogRevision
    }
  });
}

export function verifyAiExecutorCredential(
  client: RequestClient,
  executor: Pick<AiExecutorConfig, "id" | "configRevision" | "currentCredentialRevision">,
  key = newIdempotencyKey()
): Promise<AiExecutorAsyncCommand> {
  return client.request<AiExecutorAsyncCommand>(`/api/v1/ai-executors/${executor.id}/credential/verify`, {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: {
      expectedExecutorRevision: executor.configRevision,
      expectedCredentialRevision: executor.currentCredentialRevision
    }
  });
}

export function revokeAiExecutorCredential(
  client: RequestClient,
  executor: Pick<AiExecutorConfig, "id" | "currentCredentialRevision">,
  input: { force?: boolean; confirmationToken?: string },
  key = newIdempotencyKey()
): Promise<unknown> {
  return client.request(`/api/v1/ai-executors/${executor.id}/credential/revoke`, {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: {
      expectedCredentialRevision: executor.currentCredentialRevision,
      force: Boolean(input.force),
      ...(input.confirmationToken ? { confirmationToken: input.confirmationToken } : {})
    }
  });
}

export function createAiExecutorAuthorizationSession(
  client: RequestClient,
  executorId: string,
  intent: AiExecutorAuthorizationIntent,
  key = newIdempotencyKey()
): Promise<AiExecutorAuthorizationSession> {
  return client.request<AiExecutorAuthorizationSession>(`/api/v1/ai-executors/${executorId}/authorization-sessions`, {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: { intent }
  });
}

export async function getCurrentAiExecutorAuthorizationSession(
  client: RequestClient,
  executorId: string
): Promise<AiExecutorAuthorizationSession | null> {
  try {
    return await client.request<AiExecutorAuthorizationSession>(
      `/api/v1/ai-executors/${executorId}/authorization-sessions/current`
    );
  } catch (error) {
    if (errorCode(error) === "not_found") return null;
    throw error;
  }
}

export function getAiExecutorAuthorizationSession(
  client: RequestClient,
  sessionId: string
): Promise<AiExecutorAuthorizationSession> {
  return client.request<AiExecutorAuthorizationSession>(`/api/v1/ai-executor-authorization-sessions/${sessionId}`);
}

export function getAiExecutorAuthorizationUserAction(
  client: RequestClient,
  sessionId: string
): Promise<AiExecutorAuthorizationUserAction> {
  return client.request<AiExecutorAuthorizationUserAction>(
    `/api/v1/ai-executor-authorization-sessions/${sessionId}/user-action`
  );
}

export function reopenAiExecutorAuthorizationSession(
  client: RequestClient,
  session: Pick<AiExecutorAuthorizationSession, "id" | "revision">,
  key = newIdempotencyKey()
): Promise<AiExecutorAuthorizationUserAction> {
  return client.request<AiExecutorAuthorizationUserAction>(
    `/api/v1/ai-executor-authorization-sessions/${session.id}/reopen`,
    {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: { expectedSessionRevision: session.revision }
    }
  );
}

export function cancelAiExecutorAuthorizationSession(
  client: RequestClient,
  session: Pick<AiExecutorAuthorizationSession, "id" | "revision">,
  key = newIdempotencyKey()
): Promise<AiExecutorAuthorizationSession> {
  return client.request<AiExecutorAuthorizationSession>(
    `/api/v1/ai-executor-authorization-sessions/${session.id}/cancel`,
    {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: { expectedSessionRevision: session.revision }
    }
  );
}

export function listAiExecutorAuthorizationEvents(
  client: RequestClient,
  sessionId: string,
  after: number,
  limit = 200
): Promise<AiExecutorAuthorizationHistory> {
  return client.request<AiExecutorAuthorizationHistory>(
    `/api/v1/ai-executor-authorization-sessions/${sessionId}/events?after=${after}&limit=${limit}`
  );
}

export function watchAiExecutorAuthorizationSession(
  client: RequestClient,
  sessionId: string,
  watcher: AiExecutorAuthorizationWatcher
): EventStreamSubscription {
  const controller = new AbortController();
  const close = () => controller.abort();
  if (watcher.signal) {
    if (watcher.signal.aborted) close();
    else watcher.signal.addEventListener("abort", close, { once: true });
  }
  let inner: EventStreamSubscription | null = null;
  const done = (async () => {
    let cursor = validEventCursor(watcher.after) ? watcher.after! : 0;
    let streamClosed = false;
    while (!controller.signal.aborted) {
      const history = await listAiExecutorAuthorizationEvents(client, sessionId, cursor);
      for (const item of history.items) {
        cursor = applyAuthorizationEvent(item.event, item.sequence, item.data, cursor, sessionId, watcher);
        if (item.event === "authorization.stream.closed") streamClosed = true;
      }
      if (streamClosed || !history.hasMore) break;
      if (!validEventCursor(history.nextSequence) || history.nextSequence < cursor) {
        throw new Error("授权事件历史游标无效");
      }
      cursor = history.nextSequence;
    }
    if (controller.signal.aborted || streamClosed) return;
    if (!client.subscribe) throw new Error("当前 Host 不支持可信授权事件流");
    inner = client.subscribe<AiExecutorAuthorizationEventData>(
      `/api/v1/ai-executor-authorization-sessions/${sessionId}/events-stream`,
      {
        after: cursor,
        signal: controller.signal,
        onOpen: watcher.onOpen,
        onError: watcher.onError,
        onEvent: (event) => {
          if (!isAuthorizationEventName(event.event)) return;
          if (event.id == null) {
            if (event.event === "authorization.stream.closed") {
              applyAuthorizationConnectionClose(event.data, sessionId, watcher);
            }
            return;
          }
          cursor = applyAuthorizationEvent(event.event, event.id, event.data, cursor, sessionId, watcher);
        }
      }
    );
    await inner.done;
  })().catch((error) => {
    if (!controller.signal.aborted) watcher.onError?.(error);
  }).finally(() => {
    watcher.signal?.removeEventListener("abort", close);
  });
  return {
    close() {
      close();
      inner?.close();
    },
    done
  };
}

function applyAuthorizationConnectionClose(
  data: AiExecutorAuthorizationEventData,
  sessionId: string,
  watcher: AiExecutorAuthorizationWatcher
) {
  if (!data || data.sessionId !== sessionId || typeof data.reason !== "string" || data.reason.trim() === "") {
    watcher.onError?.(new Error("授权事件连接关闭投影无效"));
    return;
  }
  watcher.onClosed?.(data.reason);
}

function applyAuthorizationEvent(
  event: AiExecutorAuthorizationEventName,
  sequence: number,
  data: AiExecutorAuthorizationEventData,
  cursor: number,
  expectedSessionId: string,
  watcher: AiExecutorAuthorizationWatcher
): number {
  if (!validEventCursor(sequence) || sequence <= cursor) return cursor;
  if (!data || data.sessionId !== expectedSessionId || (event !== "authorization.stream.closed" && data.session?.id !== expectedSessionId)) {
    throw new Error("授权事件安全投影无效");
  }
  if (data.sequence !== sequence || data.sessionId === "") throw new Error("授权事件序列不一致");
  if (event === "authorization.stream.closed") {
    watcher.onClosed?.(data.reason ?? "terminal");
  } else if (data.session) {
    watcher.onSession(data.session);
  }
  return sequence;
}

function isAuthorizationEventName(value: string): value is AiExecutorAuthorizationEventName {
  return [
    "authorization.session.changed",
    "authorization.session.terminal",
    "authorization.stream.closed"
  ].includes(value);
}

function validEventCursor(value: number | undefined): boolean {
  return value == null || (Number.isSafeInteger(value) && value >= 0);
}

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error != null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
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
