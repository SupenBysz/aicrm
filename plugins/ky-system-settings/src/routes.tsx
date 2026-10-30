import type { PluginRoute } from "@ky/admin-core";
import { SettingsHubPage } from "./pages/settings-hub-page";
import { PluginManagementPage } from "./pages/plugin-management-page";

export const routes: PluginRoute[] = [
  { path: "/system/plugins", requiredPermission: "platform.plugin_management.view", element: <PluginManagementPage /> },
  {
    path: "/system",
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
    ],
    element: <SettingsHubPage />
  }
];
