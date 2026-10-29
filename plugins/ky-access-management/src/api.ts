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
  permissionRevision: number;
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

export type MenuDirectoryType = "management" | "workbench";
export interface MenuDirectoryEntry {
  directoryType: MenuDirectoryType; menuKey: string; nodeType: "group" | "leaf"; parentKey?: string;
  name: string; icon: string; permissionCode: string; workspaceTypes: string[]; routeKey?: string;
  routePath?: string; pageType: "internal" | "webview"; status: "active" | "disabled"; sortOrder: number; revision: number;
}
export interface MenuNavigationItem {
  directoryType: MenuDirectoryType; menuKey: string; nodeType: "group" | "leaf"; parentKey?: string;
  name: string; icon: string; routeKey?: string; pageType: "internal" | "webview"; sortOrder: number;
}
export interface MenuWebViewConfig {
  directoryType: MenuDirectoryType; menuKey: string; configScope: "common" | "workspace"; inherited?: boolean;
  workspaceType: string; workspaceId: string; platform: string; defaultUrl: string; openMode: "embedded" | "window";
  navigationProtocols: string[]; scripts: Array<{identifier:string;versionPolicy:"pinned"|"latest_released";versionId?:string;version?:string}>;
  styles: Array<{identifier:string;versionPolicy:"pinned"|"latest_released";versionId?:string;version?:string}>;
  scheduleMode: "page_first"|"strict_document_start"; revision: number;
}

export function listMenuDirectory(client: RequestClient, directory: MenuDirectoryType, includeDisabled = false): Promise<{items:MenuDirectoryEntry[]}> {
  return client.request(`/api/v1/menu-directory/${directory}${includeDisabled ? "?includeDisabled=1" : ""}`);
}
export function listAssignableMenuDirectory(client: RequestClient, directory: MenuDirectoryType): Promise<{items:MenuDirectoryEntry[];ancestors:MenuDirectoryEntry[]}> {
  return client.request(`/api/v1/menu-directory/${directory}/assignable`);
}
export function saveMenuDirectoryEntry(client: RequestClient, directory: MenuDirectoryType, key: string, input: Partial<MenuDirectoryEntry> & {expectedRevision?:number}): Promise<MenuDirectoryEntry> {
  const {expectedRevision,...body}=input;
  return client.request(`/api/v1/menu-directory/${directory}/${encodeURIComponent(key)}`, {method:"PUT",...(expectedRevision ? {headers:{"X-KY-Expected-Revision":String(expectedRevision)}}:{}),body:{...body,expectedRevision}});
}
export function updateMenuDirectoryStatus(client: RequestClient, directory: MenuDirectoryType, key: string, status: "active"|"disabled", revision: number): Promise<unknown> {
  return client.request(`/api/v1/menu-directory/${directory}/${encodeURIComponent(key)}/status`, {method:"PATCH",headers:{"X-KY-Expected-Revision":String(revision)},body:{status}});
}
export function getMenuWebViewConfig(client: RequestClient,directory:MenuDirectoryType,key:string,scope?:"common"|"workspace"):Promise<MenuWebViewConfig>{const query=scope?`?scope=${scope}`:"";return client.request(`/api/v1/menu-webviews/${directory}/${encodeURIComponent(key)}/config${query}`);}
export function saveMenuWebViewConfig(client: RequestClient,directory:MenuDirectoryType,key:string,input:Partial<MenuWebViewConfig>&{configScope:"common"|"workspace";expectedRevision?:number}):Promise<MenuWebViewConfig>{const{expectedRevision,...body}=input;return client.request(`/api/v1/menu-webviews/${directory}/${encodeURIComponent(key)}/config`,{method:"PUT",...(expectedRevision?{headers:{"X-KY-Expected-Revision":String(expectedRevision)}}:{}),body:{...body,expectedRevision}});}

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

export function setRolePermissions(client: RequestClient, id: string, permissionIds: string[], expectedRevision:number): Promise<{permissionRevision:number}> {
  return client.request(`/api/v1/roles/${id}/permissions`, { method: "POST", headers:{"X-KY-Expected-Revision":String(expectedRevision)}, body: { permissionIds, expectedRevision } });
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
