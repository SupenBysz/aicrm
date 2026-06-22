import type { PluginRoute } from "@ky/admin-core";
import { AuditLogsPage } from "./pages/audit-logs-page";
import { LoginLogsPage } from "./pages/login-logs-page";

export const routes: PluginRoute[] = [
  {
    path: "/audit-logs",
    requiredAnyPermissions: ["platform.audit.view", "agency.audit.view", "enterprise.audit.view"],
    element: <AuditLogsPage />
  },
  {
    path: "/login-logs",
    requiredPermission: "platform.login_logs.view",
    element: <LoginLogsPage />
  }
];
