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
      key: "ky-access-management.menu-directory",
      label: "菜单目录",
      path: "/menu-directory",
      icon: "PartitionOutlined",
      menuKey: "platform.menu_catalog.view",
      requiredAnyPermissions: ["platform.menu_catalog.view", "platform.menu_catalog.manage"]
    }
  ],
  routes
};

export default accessManagementPlugin;
