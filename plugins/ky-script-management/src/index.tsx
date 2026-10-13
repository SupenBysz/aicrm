import type { AdminPlugin } from "@ky/admin-core";
import { routes } from "./routes";
import { scriptManagementPermissions } from "./permissions";

// 管理中心一级菜单由 navGroup 生成，menus 直接注册可访问的二级路由项。
export const scriptManagementPlugin: AdminPlugin = {
  name: "ky-script-management",
  navGroup: "脚本管理",
  navOrder: 82,
  menus: [
    {
      key: "ky-script-management.douyin",
      label: "抖店脚本",
      icon: "CodeOutlined",
      path: "/script-management/douyin-scripts",
      menuKey: scriptManagementPermissions.menu,
      requiredPermission: scriptManagementPermissions.view
    }
  ],
  routes
};

export default scriptManagementPlugin;
