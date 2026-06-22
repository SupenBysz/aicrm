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
}

export function getDefaultModels(client: RequestClient): Promise<DefaultModelSettings> {
  return client.request<DefaultModelSettings>("/api/v1/ai-models/settings");
}

export function updateDefaultModels(client: RequestClient, input: Partial<DefaultModelSettings>): Promise<unknown> {
  return client.request("/api/v1/ai-models/settings", { method: "PATCH", body: input });
}
