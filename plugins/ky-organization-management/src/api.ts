import type { RequestClient } from "@ky/admin-core";

export interface ListResult<T> {
  items: T[];
  pagination: { page: number; pageSize: number; total: number };
}

export interface UserBrief {
  id: string;
  username: string;
  displayName: string;
  email: string;
  phone: string;
  status: string;
}

export interface OrgMember {
  id: string;
  userId: string;
  displayName: string;
  employeeNo: string;
  title: string;
  status: string;
  email: string;
  phone: string;
  joinedAt: string | null;
}

export function listOrgMembers(
  client: RequestClient,
  workspaceType: string,
  workspaceId: string,
  params: { page: number; pageSize: number }
): Promise<ListResult<OrgMember>> {
  const q = new URLSearchParams();
  q.set("page", String(params.page));
  q.set("pageSize", String(params.pageSize));
  return client.request<ListResult<OrgMember>>(
    `/api/v1/platform/organizations/${workspaceType}/${workspaceId}/members?${q.toString()}`
  );
}

export interface Agency {
  id: string;
  name: string;
  code: string;
  logoUrl: string;
  description: string;
  status: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  createdBy: string;
  creator: UserBrief | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgencyListParams {
  keyword?: string;
  status?: string;
  page: number;
  pageSize: number;
}

export interface AgencyInput {
  name: string;
  code?: string;
  logoUrl?: string;
  description?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
}

function listQuery(params: AgencyListParams): string {
  const q = new URLSearchParams();
  q.set("page", String(params.page));
  q.set("pageSize", String(params.pageSize));
  if (params.keyword) q.set("keyword", params.keyword);
  if (params.status) q.set("status", params.status);
  return q.toString();
}

export function listAgencies(client: RequestClient, params: AgencyListParams): Promise<ListResult<Agency>> {
  return client.request<ListResult<Agency>>(`/api/v1/platform/agencies?${listQuery(params)}`);
}

export function createAgency(client: RequestClient, input: AgencyInput): Promise<Agency> {
  return client.request<Agency>("/api/v1/platform/agencies", { method: "POST", body: input });
}

export function updateAgency(client: RequestClient, id: string, input: AgencyInput): Promise<Agency> {
  return client.request<Agency>(`/api/v1/platform/agencies/${id}`, { method: "PATCH", body: input });
}

export function updateAgencyStatus(
  client: RequestClient,
  id: string,
  status: string,
  reason?: string
): Promise<{ id: string; status: string }> {
  return client.request<{ id: string; status: string }>(`/api/v1/platform/agencies/${id}/status`, {
    method: "PATCH",
    body: { status, reason }
  });
}

// --- enterprises ---

export interface Enterprise {
  id: string;
  agencyId: string | null;
  name: string;
  code: string;
  logoUrl: string;
  description: string;
  status: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  createdBy: string;
  creator: UserBrief | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface EnterpriseListParams {
  keyword?: string;
  status?: string;
  agencyId?: string;
  page: number;
  pageSize: number;
}

export interface EnterpriseInput {
  agencyId?: string;
  name: string;
  code?: string;
  logoUrl?: string;
  description?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
}

export function listEnterprises(client: RequestClient, params: EnterpriseListParams): Promise<ListResult<Enterprise>> {
  const q = new URLSearchParams();
  q.set("page", String(params.page));
  q.set("pageSize", String(params.pageSize));
  if (params.keyword) q.set("keyword", params.keyword);
  if (params.status) q.set("status", params.status);
  if (params.agencyId) q.set("agencyId", params.agencyId);
  return client.request<ListResult<Enterprise>>(`/api/v1/platform/enterprises?${q.toString()}`);
}

export function createEnterprise(client: RequestClient, input: EnterpriseInput): Promise<Enterprise> {
  return client.request<Enterprise>("/api/v1/platform/enterprises", { method: "POST", body: input });
}

export function updateEnterprise(client: RequestClient, id: string, input: EnterpriseInput): Promise<Enterprise> {
  return client.request<Enterprise>(`/api/v1/platform/enterprises/${id}`, { method: "PATCH", body: input });
}

export function assignEnterpriseAgency(client: RequestClient, id: string, agencyId: string): Promise<Enterprise> {
  return client.request<Enterprise>(`/api/v1/platform/enterprises/${id}/agency`, {
    method: "PATCH",
    body: { agencyId }
  });
}

export function updateEnterpriseStatus(
  client: RequestClient,
  id: string,
  status: string
): Promise<{ id: string; status: string }> {
  return client.request<{ id: string; status: string }>(`/api/v1/platform/enterprises/${id}/status`, {
    method: "PATCH",
    body: { status }
  });
}

/** Fetch agencies for select options / id→name mapping (first page, large size). */
export function listAllAgencies(client: RequestClient): Promise<ListResult<Agency>> {
  return listAgencies(client, { page: 1, pageSize: 200 });
}

// --- departments (workspace-scoped; list returns a plain array) ---

export interface Department {
  id: string;
  workspaceType: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  code: string;
  leaderMembershipId: string | null;
  sortOrder: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface DepartmentInput {
  parentId?: string;
  name: string;
  code?: string;
  leaderMembershipId?: string;
  sortOrder?: number;
  status?: string;
}

export function listDepartments(client: RequestClient, status?: string): Promise<Department[]> {
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  const suffix = q.toString();
  return client.request<Department[]>(`/api/v1/departments${suffix ? `?${suffix}` : ""}`);
}

export function createDepartment(client: RequestClient, input: DepartmentInput): Promise<Department> {
  return client.request<Department>("/api/v1/departments", { method: "POST", body: input });
}

export function updateDepartment(client: RequestClient, id: string, input: DepartmentInput): Promise<{ id: string }> {
  return client.request<{ id: string }>(`/api/v1/departments/${id}`, { method: "PATCH", body: input });
}

export function deleteDepartment(client: RequestClient, id: string): Promise<{ id: string; deleted: boolean }> {
  return client.request<{ id: string; deleted: boolean }>(`/api/v1/departments/${id}`, { method: "DELETE" });
}

// --- teams (workspace-scoped; list returns a plain array) ---

export interface Team {
  id: string;
  workspaceType: string;
  workspaceId: string;
  departmentId: string | null;
  name: string;
  code: string;
  leaderMembershipId: string | null;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamInput {
  name: string;
  code?: string;
  departmentId?: string;
  leaderMembershipId?: string;
  description?: string;
  status?: string;
}

export function listTeams(client: RequestClient, departmentId?: string, status?: string): Promise<Team[]> {
  const q = new URLSearchParams();
  if (departmentId) q.set("departmentId", departmentId);
  if (status) q.set("status", status);
  const suffix = q.toString();
  return client.request<Team[]>(`/api/v1/teams${suffix ? `?${suffix}` : ""}`);
}

export function createTeam(client: RequestClient, input: TeamInput): Promise<Team> {
  return client.request<Team>("/api/v1/teams", { method: "POST", body: input });
}

export function updateTeam(client: RequestClient, id: string, input: TeamInput): Promise<{ id: string }> {
  return client.request<{ id: string }>(`/api/v1/teams/${id}`, { method: "PATCH", body: input });
}

export function setTeamMembers(client: RequestClient, id: string, membershipIds: string[]): Promise<{ id: string; memberCount: number }> {
  return client.request<{ id: string; memberCount: number }>(`/api/v1/teams/${id}/members`, {
    method: "POST",
    body: { membershipIds }
  });
}

// --- current organization profile ---

export interface CurrentOrganization {
  id: string;
  workspaceType: string;
  name: string;
  code: string;
  logoUrl: string;
  description: string;
  status: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
}

export interface CurrentOrganizationInput {
  name: string;
  logoUrl?: string;
  description?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
}

export function getCurrentOrganization(client: RequestClient): Promise<CurrentOrganization> {
  return client.request<CurrentOrganization>("/api/v1/organizations/current");
}

export function updateCurrentOrganization(client: RequestClient, input: CurrentOrganizationInput): Promise<CurrentOrganization> {
  return client.request<CurrentOrganization>("/api/v1/organizations/current", { method: "PATCH", body: input });
}

// --- qualifications (资质审核) ---
// Organizations submit qualifications from their own workspace; the platform
// reviews (approve/reject). No platform-side recording.

export interface QualificationMaterial {
  name: string;
  url: string;
}

export interface Qualification {
  id: string;
  targetType: string;
  targetId: string;
  qualificationType: string;
  materials: QualificationMaterial[];
  status: string;
  reviewUserId: string | null;
  reviewedAt: string | null;
  reviewRemark: string;
  createdAt: string;
  updatedAt: string;
}

export interface QualificationSubmitInput {
  qualificationType: string;
  materials?: QualificationMaterial[];
}

// org workspace: submit own qualification + list own
export function submitQualification(client: RequestClient, input: QualificationSubmitInput): Promise<Qualification> {
  return client.request<Qualification>("/api/v1/qualifications", { method: "POST", body: input });
}

export function listMyQualifications(
  client: RequestClient,
  params: { status?: string; page: number; pageSize: number }
): Promise<ListResult<Qualification>> {
  const q = new URLSearchParams();
  q.set("page", String(params.page));
  q.set("pageSize", String(params.pageSize));
  if (params.status) q.set("status", params.status);
  return client.request<ListResult<Qualification>>(`/api/v1/qualifications?${q.toString()}`);
}

// platform workspace: review queue
export function listQualifications(
  client: RequestClient,
  params: { status?: string; page: number; pageSize: number }
): Promise<ListResult<Qualification>> {
  const q = new URLSearchParams();
  q.set("page", String(params.page));
  q.set("pageSize", String(params.pageSize));
  if (params.status) q.set("status", params.status);
  return client.request<ListResult<Qualification>>(`/api/v1/platform/qualifications?${q.toString()}`);
}

export function approveQualification(client: RequestClient, id: string, remark: string): Promise<unknown> {
  return client.request(`/api/v1/platform/qualifications/${id}/approve`, { method: "PATCH", body: { remark } });
}

export function rejectQualification(client: RequestClient, id: string, remark: string): Promise<unknown> {
  return client.request(`/api/v1/platform/qualifications/${id}/reject`, { method: "PATCH", body: { remark } });
}
