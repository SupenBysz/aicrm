import type { RequestClient } from "@ky/admin-core";

export interface ListResult<T> {
  items: T[];
  pagination: { page: number; pageSize: number; total: number };
}

export interface Member {
  id: string;
  userId: string;
  workspaceType: string;
  workspaceId: string;
  displayName: string;
  employeeNo: string;
  title: string;
  status: string;
  email: string;
  phone: string;
  joinedAt: string | null;
  departmentIds: string[];
  teamIds: string[];
  roleIds: string[];
}

export interface MemberListParams {
  keyword?: string;
  status?: string;
  departmentId?: string;
  teamId?: string;
  page: number;
  pageSize: number;
}

export function listMembers(client: RequestClient, params: MemberListParams): Promise<ListResult<Member>> {
  const q = new URLSearchParams();
  q.set("page", String(params.page));
  q.set("pageSize", String(params.pageSize));
  if (params.keyword) q.set("keyword", params.keyword);
  if (params.status) q.set("status", params.status);
  if (params.departmentId) q.set("departmentId", params.departmentId);
  if (params.teamId) q.set("teamId", params.teamId);
  return client.request<ListResult<Member>>(`/api/v1/workspace/members?${q.toString()}`);
}

export function updateMemberStatus(client: RequestClient, id: string, status: string, reason?: string): Promise<unknown> {
  return client.request(`/api/v1/workspace/members/${id}/status`, { method: "PATCH", body: { status, reason } });
}

export function removeMember(client: RequestClient, id: string): Promise<unknown> {
  return client.request(`/api/v1/workspace/members/${id}`, { method: "DELETE" });
}

export interface DepartmentAssignment {
  departmentId: string;
  isPrimary: boolean;
}

export function assignMemberDepartments(client: RequestClient, id: string, departments: DepartmentAssignment[]): Promise<unknown> {
  return client.request(`/api/v1/workspace/members/${id}/departments`, { method: "POST", body: { departments } });
}

export function assignMemberTeams(client: RequestClient, id: string, teamIds: string[]): Promise<unknown> {
  return client.request(`/api/v1/workspace/members/${id}/teams`, { method: "POST", body: { teamIds } });
}

// --- invitations ---

export interface Invitation {
  id: string;
  workspaceType: string;
  workspaceId: string;
  invitationType: string;
  inviteeEmail: string | null;
  inviteePhone: string | null;
  token: string;
  presetRoleIds: string[];
  presetDepartmentIds: string[];
  presetTeamIds: string[];
  status: string;
  expiresAt: string;
  acceptedUserId: string | null;
  acceptedAt: string | null;
  createdAt: string;
}

export interface InvitationListParams {
  status?: string;
  page: number;
  pageSize: number;
}

export function listInvitations(client: RequestClient, params: InvitationListParams): Promise<ListResult<Invitation>> {
  const q = new URLSearchParams();
  q.set("page", String(params.page));
  q.set("pageSize", String(params.pageSize));
  if (params.status) q.set("status", params.status);
  return client.request<ListResult<Invitation>>(`/api/v1/invitations?${q.toString()}`);
}

export interface CreateInvitationInput {
  invitationType?: string;
  inviteeEmail?: string;
  inviteePhone?: string;
  roleIds?: string[];
  departmentIds?: string[];
  teamIds?: string[];
  expiresAt?: string;
}

export function createInvitation(client: RequestClient, input: CreateInvitationInput): Promise<Invitation> {
  return client.request<Invitation>("/api/v1/invitations", { method: "POST", body: input });
}

export function cancelInvitation(client: RequestClient, id: string): Promise<unknown> {
  return client.request(`/api/v1/invitations/${id}/cancel`, { method: "PATCH" });
}
