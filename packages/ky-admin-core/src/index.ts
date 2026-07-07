export type WorkspaceType = "platform" | "agency" | "enterprise";

export type PermissionKey = string;
export type ActionPermissionKey = string;
export type MenuPermissionKey = string;

export interface CurrentUser {
  id: string;
  username?: string;
  displayName: string;
  avatarUrl: string;
  phone?: string;
  email?: string;
}

export interface ListQueryState {
  page: number;
  pageSize: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  keyword?: string;
  status?: string;
  type?: string;
}

export interface WorkspaceRole {
  id: string;
  code: string;
  name: string;
}

export interface WorkspaceDataScope {
  scopeType: string;
  departmentIds?: string[];
  teamIds?: string[];
  agencyIds?: string[];
  enterpriseIds?: string[];
}

export interface WorkspaceIdentity {
  id: string;
  type: WorkspaceType;
  name: string;
  membershipId: string;
  roles: WorkspaceRole[];
  permissions: string[];
  actionPermissions: string[];
  menuKeys: string[];
  dataScopes: WorkspaceDataScope[];
}

export interface WorkspacePermissionState {
  workspace: WorkspaceIdentity;
  permissions: Set<string>;
  actionPermissions: Set<string>;
  menuKeys: Set<string>;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  skipAuthRedirect?: boolean;
}

export interface RequestClient {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
}

export interface PluginMenuItem {
  key: string;
  label: string;
  path: string;
  menuKey: string;
  /** Icon name resolved by the host icon registry (e.g. "BankOutlined"). */
  icon?: string;
  requiredPermission?: string;
  requiredAnyPermissions?: PermissionKey[];
  children?: PluginMenuItem[];
}

export interface PluginRoute {
  path: string;
  requiredPermission?: string;
  requiredAnyPermissions?: PermissionKey[];
  element: unknown;
}

export interface HeaderAction {
  key: string;
  requiredPermission?: string;
  element: unknown;
}

export interface WorkbenchContribution {
  key: string;
  workspaceTypes: WorkspaceType[];
  requiredPermission?: string;
  element: unknown;
}

export interface AdminPlugin {
  name: string;
  /** Sidebar group title for this plugin's menus. */
  navGroup?: string;
  /** Relative ordering of this plugin's group in the sidebar (lower first). */
  navOrder?: number;
  menus?: PluginMenuItem[];
  routes?: PluginRoute[];
  headerActions?: HeaderAction[];
  workbenchContributions?: WorkbenchContribution[];
}

// Shared admin framework (page shells, list-query state, permission + identity
// contexts) ported from the reference admin-core to accelerate module pages.
export * from "./page-shell";
export * from "./batch-actions";
export * from "./url-state";
export * from "./permissions";
export * from "./user-context";
export * from "./workspace-context";
export * from "./request-context";
