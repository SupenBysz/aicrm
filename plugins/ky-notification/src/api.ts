import type { RequestClient } from "@ky/admin-core";

export interface ListResult<T> {
  items: T[];
  pagination: { page: number; pageSize: number; total: number };
}

export interface Notification {
  id: string;
  scopeType: string;
  scopeId: string;
  title: string;
  content: string;
  notificationType: string;
  read: boolean;
  createdAt: string;
}

export function listNotifications(
  client: RequestClient,
  params: { read?: string; type?: string; page: number; pageSize: number }
): Promise<ListResult<Notification>> {
  const q = new URLSearchParams();
  q.set("page", String(params.page));
  q.set("pageSize", String(params.pageSize));
  if (params.read) q.set("read", params.read);
  if (params.type) q.set("type", params.type);
  return client.request<ListResult<Notification>>(`/api/v1/notifications?${q.toString()}`);
}

export function notificationUnreadCount(client: RequestClient): Promise<{ count?: number; unreadCount?: number }> {
  return client.request<{ count?: number; unreadCount?: number }>("/api/v1/notifications/unread-count");
}

export function markNotificationRead(client: RequestClient, id: string): Promise<unknown> {
  return client.request(`/api/v1/notifications/${id}/read`, { method: "PATCH" });
}

export function markAllNotificationsRead(client: RequestClient): Promise<unknown> {
  return client.request("/api/v1/notifications/read-all", { method: "POST" });
}

// --- announcements ---

export interface Announcement {
  id: string;
  title: string;
  content: string;
  targetScope: string;
  targetIds: string[];
  status: string;
  publishedAt: string | null;
  createdAt: string;
}

export function listAnnouncements(
  client: RequestClient,
  params: { status?: string; page: number; pageSize: number }
): Promise<ListResult<Announcement>> {
  const q = new URLSearchParams();
  q.set("page", String(params.page));
  q.set("pageSize", String(params.pageSize));
  if (params.status) q.set("status", params.status);
  return client.request<ListResult<Announcement>>(`/api/v1/announcements?${q.toString()}`);
}

export interface AnnouncementInput {
  title: string;
  content: string;
  targetScope?: string;
  targetIds?: string[];
}

export function createAnnouncement(client: RequestClient, input: AnnouncementInput): Promise<Announcement> {
  return client.request<Announcement>("/api/v1/announcements", { method: "POST", body: input });
}

export function publishAnnouncement(client: RequestClient, id: string): Promise<unknown> {
  return client.request(`/api/v1/announcements/${id}/publish`, { method: "PATCH" });
}

// --- targeting option sources (for "指定组织/用户") ---

export interface TargetOption {
  value: string;
  label: string;
}

export async function listAgencyOptions(client: RequestClient): Promise<TargetOption[]> {
  const r = await client.request<ListResult<{ id: string; name: string; code: string }>>(
    "/api/v1/platform/agencies?page=1&pageSize=200"
  );
  return r.items.map((a) => ({ value: a.id, label: a.code ? `${a.name}（${a.code}）` : a.name }));
}

export async function listEnterpriseOptions(client: RequestClient): Promise<TargetOption[]> {
  const r = await client.request<ListResult<{ id: string; name: string; code: string }>>(
    "/api/v1/platform/enterprises?page=1&pageSize=200"
  );
  return r.items.map((e) => ({ value: e.id, label: e.code ? `${e.name}（${e.code}）` : e.name }));
}

export async function searchUserOptions(client: RequestClient, keyword: string): Promise<TargetOption[]> {
  const q = new URLSearchParams({ limit: "20" });
  if (keyword) q.set("keyword", keyword);
  const r = await client.request<{ items: { id: string; displayName: string; email: string }[] }>(
    `/api/v1/platform/users?${q.toString()}`
  );
  return r.items.map((u) => ({ value: u.id, label: u.email ? `${u.displayName}（${u.email}）` : u.displayName }));
}
