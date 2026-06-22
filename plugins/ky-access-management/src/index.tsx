import type { AdminPlugin } from "@ky/admin-core";
import { routes } from "./routes";

export const accessManagementPlugin: AdminPlugin = {
  name: "ky-access-management",
  navGroup: "权限中心",
  navOrder: 30,
  menus: [
    {
      key: "ky-access-management.roles",
      label: "角色管理",
      path: "/roles",
      icon: "SafetyCertificateOutlined",
      menuKey: "access.roles.view",
      requiredAnyPermissions: ["platform.roles.view", "agency.roles.view", "enterprise.roles.view"]
    },
    {
      key: "ky-access-management.permissions",
      label: "权限目录",
      path: "/permissions",
      icon: "KeyOutlined",
      menuKey: "access.permissions.view",
      requiredAnyPermissions: ["platform.permissions.view", "agency.permissions.view", "enterprise.permissions.view"]
    },
    {
      key: "ky-access-management.data-scopes",
      label: "数据范围",
      path: "/data-scopes",
      icon: "PartitionOutlined",
      menuKey: "access.data_scopes.view",
      requiredAnyPermissions: ["platform.data_scopes.view", "agency.data_scopes.view", "enterprise.data_scopes.view"]
    }
  ],
  routes
};

export default accessManagementPlugin;
