import type { AdminPlugin } from "@ky/admin-core";
import { routes } from "./routes";

export const systemSettingsPlugin: AdminPlugin = {
  name: "ky-system-settings",
  navGroup: "系统设置",
  navOrder: 60,
  menus: [
    {
      key: "ky-system-settings.hub",
      label: "系统配置",
      path: "/system",
      icon: "SettingOutlined",
      menuKey: "system.settings.view",
      requiredAnyPermissions: [
        "platform.settings.view",
        "agency.settings.view",
        "enterprise.settings.view",
        "platform.dictionaries.view",
        "platform.basic_info.view",
        "platform.notification_templates.view",
        "platform.storage.view",
        "platform.sms.view",
        "platform.email.view",
        "platform.app_version.view"
      ]
    }
  ],
  routes
};

export default systemSettingsPlugin;
