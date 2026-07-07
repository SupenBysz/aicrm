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

export type WorkspaceBackendTitleMode = "full" | "short";

export interface WorkspaceBrandInfo {
  brandLogoTextLong?: string;
  brandLogoTextShort?: string;
  companyName?: string;
  logoTextLong?: string;
  logoTextShort?: string;
  name?: string;
}

function compactPlatformName(platformName: string): string {
  const normalized = platformName.trim() || "AiCRM";
  const hanChars = Array.from(normalized.matchAll(/\p{Script=Han}/gu), (match) => match[0]);
  if (hanChars.length > 0) return hanChars.slice(0, 2).join("");
  const compact = normalized.replace(/\s+/g, "");
  return Array.from(compact).slice(0, 6).join("") || "AiCRM";
}

function resolveLongLogo(brand: string | WorkspaceBrandInfo): string {
  if (typeof brand === "string") return brand.trim() || "AiCRM";
  return (
    brand.logoTextLong?.trim() ||
    brand.brandLogoTextLong?.trim() ||
    brand.name?.trim() ||
    brand.companyName?.trim() ||
    "AiCRM"
  );
}

function resolveShortLogo(brand: string | WorkspaceBrandInfo): string {
  if (typeof brand === "string") return compactPlatformName(brand);
  return brand.logoTextShort?.trim() || brand.brandLogoTextShort?.trim() || compactPlatformName(resolveLongLogo(brand));
}

export function workspaceBackendTitle(
  workspace: WorkspaceIdentity,
  platformName: string | WorkspaceBrandInfo = "AiCRM",
  mode: WorkspaceBackendTitleMode = "full"
): string {
  void workspace;
  if (mode === "short") return resolveShortLogo(platformName);
  return resolveLongLogo(platformName);
}

export function workspaceBackendSubtitle(workspace: WorkspaceIdentity): string {
  if (workspace.type === "platform") return "AI 智能 CRM，自动化搞定直播电商全域运营";
  if (workspace.type === "agency") return `当前机构：${workspace.name}`;
  return `当前企业：${workspace.name}`;
}

export function workspaceGroupDescription(type: WorkspaceType): string {
  if (type === "platform") return "处理平台级运营、组织审核与全局治理。";
  if (type === "agency") return "管理机构自身事务，以及旗下企业和员工关系。";
  return "进入企业仪表盘，处理企业组织、员工与业务事务。";
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
