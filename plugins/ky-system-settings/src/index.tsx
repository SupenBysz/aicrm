import type { AdminPlugin } from "@ky/admin-core";
import { routes } from "./routes";

export const systemSettingsPlugin: AdminPlugin = {
  name: "ky-system-settings",
  navGroup: "系统设置",
  navOrder: 60,
  menus: [
    {
      key: "ky-system-settings.settings",
      label: "系统设置",
      path: "/settings",
      icon: "SettingOutlined",
      menuKey: "system.settings.view",
      requiredAnyPermissions: ["platform.settings.view", "agency.settings.view", "enterprise.settings.view"]
    },
    {
      key: "ky-system-settings.dictionaries",
      label: "数据字典",
      path: "/dictionaries",
      icon: "BookOutlined",
      menuKey: "system.dictionaries.view",
      requiredPermission: "platform.dictionaries.view"
    }
  ],
  routes
};

export default systemSettingsPlugin;
