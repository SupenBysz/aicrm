import type { AdminPlugin } from "@ky/admin-core";
import { routes } from "./routes";

export const systemSettingsPlugin: AdminPlugin = {
  name: "ky-system-settings",
  navGroup: "系统设置",
  navOrder: 60,
  menus: [

    {
      key: "ky-system-settings.plugins",
      label: "插件管理",
      path: "/system/plugins",
      icon: "ApiOutlined",
      menuKey: "menu.platform.plugin_management",
      requiredPermission: "platform.plugin_management.view"
    },
    {
      key: "ky-system-settings.hub",
      label: "系统配置",
      path: "/system",
      icon: "SettingOutlined",
      menuKey: "system.settings.view",
      requiredAnyPermissions: [
        "platform.settings.view",
      "platform.documents.view",
        "platform.appearance.view",
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
    },
    { key: "ky-component-center.catalog", label: "组件中心", path: "/system/components", icon: "AppstoreOutlined", menuKey: "platform.component_center.view", requiredPermission: "platform.component_center.view" }
  ],
  routes
};

export default systemSettingsPlugin;
