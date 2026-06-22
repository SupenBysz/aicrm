import { Result } from "antd";
import { createContext, useContext, useMemo, type PropsWithChildren, type ReactNode } from "react";
import type { ActionPermissionKey, MenuPermissionKey, PermissionKey } from "./index";

export interface PermissionState {
  permissions: PermissionKey[];
  actionPermissions: ActionPermissionKey[];
  menuKeys?: MenuPermissionKey[];
}

export interface PermissionContextValue extends PermissionState {
  can: (permission: PermissionKey) => boolean;
  canAction: (action: ActionPermissionKey) => boolean;
  canAny: (permissions?: PermissionKey[]) => boolean;
  canAnyAction: (actions?: ActionPermissionKey[]) => boolean;
  canMenu: (menuKey: MenuPermissionKey) => boolean;
  hasAll: (permissions?: PermissionKey[]) => boolean;
}

const emptyPermissionState: PermissionState = { actionPermissions: [], permissions: [] };
const defaultPermissionContext = createPermissionContextValue(emptyPermissionState);
const PermissionContext = createContext<PermissionContextValue>(defaultPermissionContext);

export function PermissionContextProvider({
  children,
  value
}: PropsWithChildren<{ value: PermissionState }>) {
  const contextValue = useMemo(() => createPermissionContextValue(value), [value]);
  return <PermissionContext.Provider value={contextValue}>{children}</PermissionContext.Provider>;
}

export function usePermissions() {
  return useContext(PermissionContext);
}

interface PermissionBoundaryProps {
  permissions: PermissionKey[];
  requiredPermissions?: PermissionKey[];
  fallback?: ReactNode;
}

export function PermissionBoundary({
  children,
  fallback,
  permissions,
  requiredPermissions
}: PropsWithChildren<PermissionBoundaryProps>) {
  if (!requiredPermissions?.length) {
    return <>{children}</>;
  }
  const hasAccess = requiredPermissions.every((permission) => permissions.includes(permission));
  if (hasAccess) {
    return <>{children}</>;
  }
  return (
    fallback ?? <Result status="403" subTitle="当前工作区没有该操作权限。" title="无权访问" />
  );
}

export function hasPermissions(permissions: PermissionKey[], requiredPermissions?: PermissionKey[]): boolean {
  if (!requiredPermissions?.length) return true;
  return requiredPermissions.every((permission) => permissions.includes(permission));
}

export function hasAnyPermission(permissions: PermissionKey[], requiredPermissions?: PermissionKey[]): boolean {
  if (!requiredPermissions?.length) return true;
  return requiredPermissions.some((permission) => permissions.includes(permission));
}

function createPermissionContextValue(value: PermissionState): PermissionContextValue {
  const permissions = dedupe(value.permissions);
  const actionPermissions = dedupe(value.actionPermissions);
  const menuKeys = value.menuKeys ? dedupe(value.menuKeys) : undefined;
  // The backend splits a membership's granted permission codes across `permissions`
  // (view/page category) and `actionPermissions` (action category). Authorization
  // checks must treat them as one flat set: a holder either has a permission code or
  // not — the category is only an organizational grouping. Pages call `can()` /
  // `canAny()` / `hasAll()` with action codes (e.g. *.update), so those must look in
  // both sets, otherwise create/edit/status buttons stay hidden despite the grant.
  const allPermissions = dedupe([...permissions, ...actionPermissions] as PermissionKey[]);
  return {
    actionPermissions,
    menuKeys,
    permissions,
    can: (permission) => allPermissions.includes(permission),
    canAction: (action) => actionPermissions.includes(action),
    canAny: (required) => hasAnyPermission(allPermissions, required),
    canAnyAction: (required) => {
      if (!required?.length) return true;
      return required.some((action) => actionPermissions.includes(action));
    },
    canMenu: (menuKey) => !menuKeys || menuKeys.includes(menuKey),
    hasAll: (required) => hasPermissions(allPermissions, required)
  };
}

function dedupe<T extends string>(values: T[]): T[] {
  return Array.from(new Set(values));
}
