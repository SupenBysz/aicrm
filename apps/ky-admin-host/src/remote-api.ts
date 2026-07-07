import type { RequestOptions, WorkspaceIdentity } from "@ky/admin-core";
import { HostRequestClient } from "./plugin-request-client";
import { loadCurrentWorkspace, type AdminSession, type BootstrapState, type CurrentUser } from "./app-store";
import { withDesktopClientLoginPayload } from "./desktop-client";

const client = new HostRequestClient(loadCurrentWorkspace);

/** Shared request client instance provided to plugin pages via RequestClientProvider. */
export const requestClient = client;

export interface LoginInput {
  account: string;
  password: string;
  clientMode?: string;
  clientName?: string;
}

export interface LoginResult extends AdminSession {
  user: Pick<CurrentUser, "id" | "username" | "displayName" | "avatarUrl">;
}

export interface RegisterInput {
  displayName: string;
  email?: string;
  phone?: string;
  password: string;
}

export interface RegisterResult extends AdminSession {
  userId: string;
}

export interface ChangeLoginPasswordInput {
  currentPassword: string;
  newPassword: string;
}

export async function login(input: LoginInput, options: Pick<RequestOptions, "skipAuthRedirect"> = {}) {
  return client.request<LoginResult>("/api/v1/auth/login", {
    method: "POST",
    body: withDesktopClientLoginPayload(input),
    skipAuthRedirect: options.skipAuthRedirect
  });
}

export async function register(input: RegisterInput) {
  return client.request<RegisterResult>("/api/v1/auth/register", {
    method: "POST",
    body: input
  });
}

export async function bootstrap() {
  return client.request<BootstrapState>("/api/v1/auth/bootstrap");
}

export async function logout() {
  return client.request<{ success: boolean }>("/api/v1/auth/logout", { method: "POST" });
}

export async function changeLoginPassword(input: ChangeLoginPasswordInput) {
  return client.request<{ changed: boolean }>("/api/v1/auth/change-password", {
    method: "POST",
    body: input
  });
}

export function pickWorkspace(workspaces: WorkspaceIdentity[], workspaceType?: string, workspaceId?: string) {
  return workspaces.find((workspace) => workspace.type === workspaceType && workspace.id === workspaceId) ?? null;
}

export function pickRecommendedWorkspace(state: BootstrapState) {
  return state.workspaces.find((workspace) => workspace.id === state.recommendedWorkspaceId) ?? state.workspaces[0] ?? null;
}
