import type { RequestClient } from "@ky/admin-core";

export interface ListResult<T> {
  items: T[];
  pagination: { page: number; pageSize: number; total: number };
}

export interface AuditLog {
  id: string;
  actorUserId: string | null;
  actorMembershipId: string | null;
  workspaceType: string;
  workspaceId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  result: string;
  requestId: string;
  source: string;
  remark: string;
  createdAt: string;
}

export interface AuditLogListParams {
  action?: string;
  resourceType?: string;
  actorUserId?: string;
  page: number;
  pageSize: number;
}

export function listAuditLogs(client: RequestClient, params: AuditLogListParams): Promise<ListResult<AuditLog>> {
  const q = new URLSearchParams();
  q.set("page", String(params.page));
  q.set("pageSize", String(params.pageSize));
  if (params.action) q.set("action", params.action);
  if (params.resourceType) q.set("resourceType", params.resourceType);
  if (params.actorUserId) q.set("actorUserId", params.actorUserId);
  return client.request<ListResult<AuditLog>>(`/api/v1/audit-logs?${q.toString()}`);
}

export interface LoginLog {
  id: string;
  userId: string | null;
  loginAccount: string;
  result: string;
  failReason: string;
  ipAddress: string;
  userAgent: string;
  createdAt: string;
}

export function listLoginLogs(
  client: RequestClient,
  params: { page: number; pageSize: number }
): Promise<ListResult<LoginLog>> {
  const q = new URLSearchParams();
  q.set("page", String(params.page));
  q.set("pageSize", String(params.pageSize));
  return client.request<ListResult<LoginLog>>(`/api/v1/login-logs?${q.toString()}`);
}
