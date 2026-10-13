import type { PluginRoute } from "@ky/admin-core";
import { ScriptManagementPage } from "./pages/script-management-page";
import { scriptManagementPermissions } from "./permissions";

export const routes: PluginRoute[] = [
  {
    path: "/script-management/douyin-scripts",
    requiredPermission: scriptManagementPermissions.view,
    element: <ScriptManagementPage />
  }
];
