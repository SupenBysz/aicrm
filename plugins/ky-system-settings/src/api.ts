import type { RequestClient } from "@ky/admin-core";

export type SettingsMap = Record<string, string>;

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
