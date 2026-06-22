import type { RequestClient } from "@ky/admin-core";

export interface ListResult<T> {
  items: T[];
  pagination: { page: number; pageSize: number; total: number };
}

export interface DataScope {
  scopeType: string;
  departmentIds?: string[];
  teamIds?: string[];
  agencyIds?: string[];
  enterpriseIds?: string[];
}

export interface Role {
  id: string;
  workspaceType: string;
  workspaceId: string | null;
  name: string;
  code: string;
  description: string;
  isSystem: boolean;
  status: string;
  permissionIds: string[];
  dataScopes: DataScope[];
}

export interface Permission {
  id: string;
  code: string;
  name: string;
  category: string;
  resource: string;
  action: string;
  workspaceTypes: string[];
  status: string;
}

export interface RoleInput {
  name: string;
  code?: string;
  description?: string;
  permissionIds?: string[];
  dataScope?: DataScope;
}

export function listRoles(
  client: RequestClient,
  params: { status?: string; page: number; pageSize: number }
): Promise<ListResult<Role>> {
  const q = new URLSearchParams();
  q.set("page", String(params.page));
  q.set("pageSize", String(params.pageSize));
  if (params.status) q.set("status", params.status);
  return client.request<ListResult<Role>>(`/api/v1/roles?${q.toString()}`);
}

export function createRole(client: RequestClient, input: RoleInput): Promise<Role> {
  return client.request<Role>("/api/v1/roles", { method: "POST", body: input });
}

export function updateRole(client: RequestClient, id: string, input: RoleInput): Promise<Role> {
  return client.request<Role>(`/api/v1/roles/${id}`, { method: "PATCH", body: input });
}

export function updateRoleStatus(client: RequestClient, id: string, status: string): Promise<unknown> {
  return client.request(`/api/v1/roles/${id}/status`, { method: "PATCH", body: { status } });
}

export function setRolePermissions(client: RequestClient, id: string, permissionIds: string[]): Promise<unknown> {
  return client.request(`/api/v1/roles/${id}/permissions`, { method: "POST", body: { permissionIds } });
}

export function listPermissions(
  client: RequestClient,
  params?: { workspaceType?: string; category?: string }
): Promise<Permission[]> {
  const q = new URLSearchParams();
  if (params?.workspaceType) q.set("workspaceType", params.workspaceType);
  if (params?.category) q.set("category", params.category);
  const suffix = q.toString();
  return client.request<Permission[]>(`/api/v1/permissions${suffix ? `?${suffix}` : ""}`);
}

export interface DataScopeDefinition {
  scopeType: string;
  label: string;
}

export function listDataScopes(
  client: RequestClient
): Promise<{ definitions: DataScopeDefinition[]; current: DataScope[] }> {
  return client.request<{ definitions: DataScopeDefinition[]; current: DataScope[] }>("/api/v1/data-scopes");
}
