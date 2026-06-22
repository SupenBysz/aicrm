import type { WorkspaceIdentity, WorkspaceType } from "@ky/admin-core";

export const WORKSPACE_TYPE_ORDER: WorkspaceType[] = ["platform", "agency", "enterprise"];

export function workspaceTypeLabel(type: WorkspaceType): string {
  if (type === "platform") return "平台";
  if (type === "agency") return "机构";
  return "企业";
}

export function workspaceTypeColor(type: WorkspaceType): string {
  if (type === "platform") return "#722ed1";
  if (type === "agency") return "#1677ff";
  return "#13c2c2";
}

export function workspaceBackendTitle(workspace: WorkspaceIdentity): string {
  if (workspace.type === "platform") return "KyaiCRM 平台后台";
  if (workspace.type === "agency") return "KyaiCRM 机构后台";
  return "KyaiCRM 企业后台";
}

export function workspaceBackendSubtitle(workspace: WorkspaceIdentity): string {
  if (workspace.type === "platform") return "当前工作区：平台控制台";
  if (workspace.type === "agency") return `当前机构：${workspace.name}`;
  return `当前企业：${workspace.name}`;
}

export function workspaceGroupDescription(type: WorkspaceType): string {
  if (type === "platform") return "处理平台级运营、组织审核与全局治理。";
  if (type === "agency") return "管理机构自身事务，以及旗下企业和员工关系。";
  return "进入企业工作台，处理企业组织、员工与业务事务。";
}

export function rolesLabel(workspace: WorkspaceIdentity): string {
  return workspace.roles.map((role) => role.name).join("、") || "无";
}

export interface WorkspaceGroup {
  type: WorkspaceType;
  workspaces: WorkspaceIdentity[];
}

export function groupWorkspaces(workspaces: WorkspaceIdentity[]): WorkspaceGroup[] {
  return WORKSPACE_TYPE_ORDER.map((type) => ({
    type,
    workspaces: workspaces.filter((workspace) => workspace.type === type)
  })).filter((group) => group.workspaces.length > 0);
}

export function filterWorkspaces(workspaces: WorkspaceIdentity[], keyword: string): WorkspaceIdentity[] {
  const text = keyword.trim().toLowerCase();
  if (!text) return workspaces;
  return workspaces.filter((workspace) => {
    const haystack = [
      workspace.name,
      workspaceTypeLabel(workspace.type),
      rolesLabel(workspace)
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(text);
  });
}
