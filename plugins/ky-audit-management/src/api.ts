import type { RequestClient } from "@ky/admin-core";

export interface ListResult<T> {
  items: T[];
  pagination: { page: number; pageSize: number; total: number };
}

export interface AuditLog {
  id: string;
  actorUserId: string | null;
  actorName: string;
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
  params: { page: number; pageSize: number;startAt?:string;endAt?:string;endBefore?:string;account?:string;userId?:string;result?:string }
): Promise<ListResult<LoginLog>> {
  const q = new URLSearchParams();
  q.set("page", String(params.page));
  q.set("pageSize", String(params.pageSize));
  for(const key of ["startAt","endAt","endBefore","account","userId","result"] as const){if(params[key])q.set(key,params[key])}
  return client.request<ListResult<LoginLog>&{filterVersion?:number}>(`/api/v1/login-logs?${q.toString()}`).then(data=>{if(params.endBefore&&data.filterVersion!==1)throw new Error("日志时间筛选待升级，未展示未确认的筛选结果");return data});
}
