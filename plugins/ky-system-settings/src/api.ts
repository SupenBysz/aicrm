import type { RequestClient } from "@ky/admin-core";

export type SettingsMap = Record<string, string>;

export interface PlatformProfile {
  companyName: string;
  brandLogoTextLong: string;
  brandLogoTextShort: string;
  icpRecord: string;
  updatedAt?: string;
}

export function getPlatformProfile(client: RequestClient): Promise<PlatformProfile> {
  return client.request<PlatformProfile>("/api/v1/platform/platform-profile");
}

export function updatePlatformProfile(client: RequestClient, input: PlatformProfile): Promise<PlatformProfile> {
  return client.request<PlatformProfile>("/api/v1/platform/platform-profile", { method: "PATCH", body: input });
}

export interface NotificationTemplate {
  templateKey: string;
  templateName: string;
  notificationType: string;
  title: string;
  content: string;
  description: string;
  enabled: boolean;
  updatedAt?: string;
}

export function listNotificationTemplates(client: RequestClient): Promise<{ items: NotificationTemplate[] }> {
  return client.request<{ items: NotificationTemplate[] }>("/api/v1/platform/notification-templates");
}

export function updateNotificationTemplate(
  client: RequestClient,
  key: string,
  input: { templateName: string; title: string; content: string; description: string }
): Promise<NotificationTemplate> {
  return client.request<NotificationTemplate>(`/api/v1/platform/notification-templates/${key}`, { method: "PATCH", body: input });
}

export function updateNotificationTemplateStatus(client: RequestClient, key: string, enabled: boolean): Promise<unknown> {
  return client.request(`/api/v1/platform/notification-templates/${key}/status`, { method: "PATCH", body: { enabled } });
}

export function resetNotificationTemplate(client: RequestClient, key: string): Promise<NotificationTemplate> {
  return client.request<NotificationTemplate>(`/api/v1/platform/notification-templates/${key}/reset`, { method: "POST" });
}

export interface AppVersionRule {
  id: string;
  platform: string;
  channel: string;
  latestVersionCode: number;
  latestVersionName: string;
  minSupportedVersionCode: number;
  forceUpdate: boolean;
  updateTitle: string;
  updateNotes: string;
  updateUrl: string;
  enabled: boolean;
  internalRemark: string;
  updatedAt?: string;
}

export type AppVersionRuleInput = Omit<AppVersionRule, "id" | "updatedAt">;

export function listAppVersionRules(client: RequestClient): Promise<{ items: AppVersionRule[] }> {
  return client.request<{ items: AppVersionRule[] }>("/api/v1/platform/app-version-rules");
}

export function createAppVersionRule(client: RequestClient, input: AppVersionRuleInput): Promise<AppVersionRule> {
  return client.request<AppVersionRule>("/api/v1/platform/app-version-rules", { method: "POST", body: input });
}

export function updateAppVersionRule(client: RequestClient, id: string, input: AppVersionRuleInput): Promise<AppVersionRule> {
  return client.request<AppVersionRule>(`/api/v1/platform/app-version-rules/${id}`, { method: "PATCH", body: input });
}

export function deleteAppVersionRule(client: RequestClient, id: string): Promise<{ id: string; deleted: boolean }> {
  return client.request<{ id: string; deleted: boolean }>(`/api/v1/platform/app-version-rules/${id}`, { method: "DELETE" });
}

export interface StorageSetting {
  providerKey: string;
  endpoint: string;
  region: string;
  bucket: string;
  bucketPrivate: boolean;
  forcePathStyle: boolean;
  prefix: string;
  publicDomain: string;
  accessKeyId: string;
  hasSecret: boolean;
  lastTestStatus: string;
  lastTestMessage?: string;
  lastTestAt?: string;
  updatedAt?: string;
}

export function getStorageSetting(client: RequestClient): Promise<StorageSetting> {
  return client.request<StorageSetting>("/api/v1/platform/storage-setting");
}

export function updateStorageSetting(client: RequestClient, input: Record<string, unknown>): Promise<StorageSetting> {
  return client.request<StorageSetting>("/api/v1/platform/storage-setting", { method: "PATCH", body: input });
}

export function rotateStorageSecret(client: RequestClient, secretAccessKey: string): Promise<{ hasSecret: boolean }> {
  return client.request<{ hasSecret: boolean }>("/api/v1/platform/storage-setting/rotate-secret", { method: "POST", body: { secretAccessKey } });
}

export function testStorageSetting(client: RequestClient): Promise<{ ok: boolean; latencyMs: number; errorMessage?: string }> {
  return client.request("/api/v1/platform/storage-setting/test", { method: "POST" });
}

// --- SMS service ---
export interface SMSAccount {
  id: string;
  accountName: string;
  providerKey: string;
  region: string;
  accessKeyId: string;
  hasSecret: boolean;
  defaultSignatureId: string;
  status: string;
  remark: string;
  lastTestStatus: string;
  lastTestMessage?: string;
}
export interface SMSSignature {
  id: string;
  accountId: string;
  signatureName: string;
  status: string;
  remark: string;
}
export interface SMSTemplate {
  id: string;
  accountId: string;
  scene: string;
  templateCode: string;
  codeVariable: string;
  codeTtlSeconds: number;
  dailyLimit: number;
  intervalSeconds: number;
  status: string;
  remark: string;
  lastTestStatus: string;
  lastTestMessage?: string;
}

const smsBase = "/api/v1/platform/sms";
export const listSMSAccounts = (c: RequestClient) => c.request<{ items: SMSAccount[] }>(`${smsBase}/accounts`);
export const createSMSAccount = (c: RequestClient, b: Record<string, unknown>) => c.request<SMSAccount>(`${smsBase}/accounts`, { method: "POST", body: b });
export const updateSMSAccount = (c: RequestClient, id: string, b: Record<string, unknown>) => c.request<SMSAccount>(`${smsBase}/accounts/${id}`, { method: "PATCH", body: b });
export const deleteSMSAccount = (c: RequestClient, id: string) => c.request(`${smsBase}/accounts/${id}`, { method: "DELETE" });
export const listSMSSignatures = (c: RequestClient) => c.request<{ items: SMSSignature[] }>(`${smsBase}/signatures`);
export const createSMSSignature = (c: RequestClient, b: Record<string, unknown>) => c.request(`${smsBase}/signatures`, { method: "POST", body: b });
export const updateSMSSignature = (c: RequestClient, id: string, b: Record<string, unknown>) => c.request(`${smsBase}/signatures/${id}`, { method: "PATCH", body: b });
export const deleteSMSSignature = (c: RequestClient, id: string) => c.request(`${smsBase}/signatures/${id}`, { method: "DELETE" });
export const listSMSTemplates = (c: RequestClient) => c.request<{ items: SMSTemplate[] }>(`${smsBase}/templates`);
export const createSMSTemplate = (c: RequestClient, b: Record<string, unknown>) => c.request(`${smsBase}/templates`, { method: "POST", body: b });
export const updateSMSTemplate = (c: RequestClient, id: string, b: Record<string, unknown>) => c.request(`${smsBase}/templates/${id}`, { method: "PATCH", body: b });
export const deleteSMSTemplate = (c: RequestClient, id: string) => c.request(`${smsBase}/templates/${id}`, { method: "DELETE" });
export const testSMSTemplate = (c: RequestClient, id: string, phoneNumber: string) =>
  c.request<{ ok: boolean; latencyMs: number; errorMessage?: string }>(`${smsBase}/templates/${id}/test`, { method: "POST", body: { phoneNumber } });

// --- Email service ---
export interface EmailAccount {
  id: string; accountName: string; providerKey: string; host: string; port: number; encryption: string;
  username: string; hasPassword: boolean; fromEmail: string; fromName: string; replyToEmail: string;
  status: string; remark: string; lastTestStatus: string; lastTestMessage?: string;
}
export interface EmailIdentity {
  id: string; accountId: string; identityName: string; fromEmail: string; fromName: string; replyToEmail: string; status: string; remark: string;
}
export interface EmailTemplate {
  id: string; accountId: string; identityId: string; scene: string; subject: string; body: string;
  codeVariable: string; codeTtlSeconds: number; dailyLimit: number; intervalSeconds: number;
  status: string; remark: string; lastTestStatus: string; lastTestMessage?: string;
}

const emailBase = "/api/v1/platform/email";
export const listEmailAccounts = (c: RequestClient) => c.request<{ items: EmailAccount[] }>(`${emailBase}/accounts`);
export const createEmailAccount = (c: RequestClient, b: Record<string, unknown>) => c.request<EmailAccount>(`${emailBase}/accounts`, { method: "POST", body: b });
export const updateEmailAccount = (c: RequestClient, id: string, b: Record<string, unknown>) => c.request<EmailAccount>(`${emailBase}/accounts/${id}`, { method: "PATCH", body: b });
export const deleteEmailAccount = (c: RequestClient, id: string) => c.request(`${emailBase}/accounts/${id}`, { method: "DELETE" });
export const listEmailIdentities = (c: RequestClient) => c.request<{ items: EmailIdentity[] }>(`${emailBase}/identities`);
export const createEmailIdentity = (c: RequestClient, b: Record<string, unknown>) => c.request(`${emailBase}/identities`, { method: "POST", body: b });
export const updateEmailIdentity = (c: RequestClient, id: string, b: Record<string, unknown>) => c.request(`${emailBase}/identities/${id}`, { method: "PATCH", body: b });
export const deleteEmailIdentity = (c: RequestClient, id: string) => c.request(`${emailBase}/identities/${id}`, { method: "DELETE" });
export const listEmailTemplates = (c: RequestClient) => c.request<{ items: EmailTemplate[] }>(`${emailBase}/templates`);
export const createEmailTemplate = (c: RequestClient, b: Record<string, unknown>) => c.request(`${emailBase}/templates`, { method: "POST", body: b });
export const updateEmailTemplate = (c: RequestClient, id: string, b: Record<string, unknown>) => c.request(`${emailBase}/templates/${id}`, { method: "PATCH", body: b });
export const deleteEmailTemplate = (c: RequestClient, id: string) => c.request(`${emailBase}/templates/${id}`, { method: "DELETE" });
export const testEmailTemplate = (c: RequestClient, id: string, toEmail: string) =>
  c.request<{ ok: boolean; latencyMs: number; errorMessage?: string }>(`${emailBase}/templates/${id}/test`, { method: "POST", body: { toEmail } });

export function getOrgSettings(client: RequestClient): Promise<{ settings: SettingsMap }> {
  return client.request<{ settings: SettingsMap }>("/api/v1/settings");
}

export function updateOrgSettings(client: RequestClient, settings: SettingsMap): Promise<{ settings: SettingsMap }> {
  return client.request<{ settings: SettingsMap }>("/api/v1/settings", { method: "PATCH", body: { settings } });
}

export function getPlatformSettings(client: RequestClient): Promise<{ settings: SettingsMap }> {
  return client.request<{ settings: SettingsMap }>("/api/v1/platform/system-settings");
}

export function updatePlatformSettings(client: RequestClient, settings: SettingsMap): Promise<{ settings: SettingsMap }> {
  return client.request<{ settings: SettingsMap }>("/api/v1/platform/system-settings", {
    method: "PATCH",
    body: { settings }
  });
}

export interface DictionaryItem {
  label: string;
  value: string;
  sortOrder: number;
  status: string;
}

export interface Dictionary {
  id: string;
  code: string;
  name: string;
  status: string;
  items: DictionaryItem[];
}

export function listDictionaries(client: RequestClient): Promise<Dictionary[]> {
  return client.request<Dictionary[]>("/api/v1/dictionaries");
}
