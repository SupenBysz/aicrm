import type { AdminPlugin } from "@ky/admin-core";
import { routes } from "./routes";

export const auditManagementPlugin: AdminPlugin = {
  name: "ky-audit-management",
  navGroup: "审计中心",
  navOrder: 70,
  menus: [
    {
      key: "ky-audit-management.audit-logs",
      label: "审计日志",
      path: "/audit-logs",
      icon: "FileSearchOutlined",
      menuKey: "audit.logs.view",
      requiredAnyPermissions: ["platform.audit.view", "agency.audit.view", "enterprise.audit.view"]
    },
    {
      key: "ky-audit-management.login-logs",
      label: "登录日志",
      path: "/login-logs",
      icon: "LoginOutlined",
      menuKey: "audit.login_logs.view",
      requiredPermission: "platform.login_logs.view"
    }
  ],
  routes
};

export default auditManagementPlugin;
