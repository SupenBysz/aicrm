import type { PluginRoute } from "@ky/admin-core";
import { RolesPage } from "./pages/roles-page";
import { PermissionsPage } from "./pages/permissions-page";
import { DataScopesPage } from "./pages/data-scopes-page";

export const routes: PluginRoute[] = [
  {
    path: "/roles",
    requiredAnyPermissions: ["platform.roles.view", "agency.roles.view", "enterprise.roles.view"],
    element: <RolesPage />
  },
  {
    path: "/permissions",
    requiredAnyPermissions: ["platform.permissions.view", "agency.permissions.view", "enterprise.permissions.view"],
    element: <PermissionsPage />
  },
  {
    path: "/data-scopes",
    requiredAnyPermissions: ["platform.data_scopes.view", "agency.data_scopes.view", "enterprise.data_scopes.view"],
    element: <DataScopesPage />
  }
];
