import type { WorkspaceIdentity } from "@ky/admin-core";

export const ADMIN_SESSION_KEY = "ky.admin.session.v1";
export const ADMIN_BOOTSTRAP_KEY = "ky.admin.bootstrap.v1";
export const ADMIN_WORKSPACE_KEY = "ky.admin.currentWorkspace.v1";

export interface AdminSession {
  token: string;
  expiresAt: string;
}

export interface CurrentUser {
  id: string;
  displayName: string;
  avatarUrl: string;
  phone?: string;
  email?: string;
}

export interface BootstrapState {
  user: CurrentUser;
  workspaces: WorkspaceIdentity[];
  recommendedWorkspaceId?: string | null;
}

export function loadSession(): AdminSession | null {
  return readJSON<AdminSession>(ADMIN_SESSION_KEY);
}

export function saveSession(session: AdminSession) {
  localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem(ADMIN_SESSION_KEY);
  localStorage.removeItem(ADMIN_BOOTSTRAP_KEY);
  localStorage.removeItem(ADMIN_WORKSPACE_KEY);
}

export function loadBootstrap(): BootstrapState | null {
  return readJSON<BootstrapState>(ADMIN_BOOTSTRAP_KEY);
}

export function setBootstrap(bootstrap: BootstrapState) {
  localStorage.setItem(ADMIN_BOOTSTRAP_KEY, JSON.stringify(bootstrap));
}

export function loadCurrentWorkspace(): WorkspaceIdentity | null {
  return readJSON<WorkspaceIdentity>(ADMIN_WORKSPACE_KEY);
}

export function selectWorkspace(workspace: WorkspaceIdentity) {
  localStorage.setItem(ADMIN_WORKSPACE_KEY, JSON.stringify(workspace));
}

export function workspaceWorkbenchPath(workspace: WorkspaceIdentity) {
  return `/w/${workspace.type}/${workspace.id}/workbench`;
}

function readJSON<T>(key: string): T | null {
  const raw = localStorage.getItem(key);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}
