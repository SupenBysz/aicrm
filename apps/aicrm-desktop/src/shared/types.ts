export type WorkspaceType = "platform" | "agency" | "enterprise";

export interface DesktopConfig {
  apiBaseUrl: string;
  webUrl: string;
}

export interface DesktopSession {
  token: string;
  expiresAt: string;
}

export interface CurrentUser {
  id: string;
  username?: string;
  displayName: string;
  avatarUrl: string;
  phone?: string;
  email?: string;
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

export interface BootstrapState {
  user: CurrentUser;
  workspaces: WorkspaceIdentity[];
  recommendedWorkspaceId?: string | null;
}

export interface LoginInput {
  account: string;
  password: string;
}

export interface LoginResult extends DesktopSession {
  user: Pick<CurrentUser, "id" | "username" | "displayName" | "avatarUrl">;
}

export interface ApiEnvelope<T> {
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
}

export interface DesktopApiRequest {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  token?: string;
}

export interface DesktopApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  envelope: ApiEnvelope<T>;
}

export interface DesktopWindowState {
  platform: NodeJS.Platform;
  isMaximized: boolean;
  isMinimized: boolean;
  isFullScreen: boolean;
  isFocused: boolean;
  isAlwaysOnTop: boolean;
}

export interface DesktopOpenDevToolsResult {
  opened: boolean;
  reason?: "production" | "unavailable";
}

export type DesktopNetworkLogStatus = "completed" | "failed";

export interface DesktopNetworkLogEntry {
  id: string;
  status: DesktopNetworkLogStatus;
  method: string;
  url: string;
  resourceType: string;
  statusCode?: number;
  error?: string;
  startedAt: string;
  completedAt: string;
  durationMs?: number;
}

export interface DesktopNetworkLogSnapshot {
  enabled: boolean;
  maxEntries: number;
  entries: DesktopNetworkLogEntry[];
}
