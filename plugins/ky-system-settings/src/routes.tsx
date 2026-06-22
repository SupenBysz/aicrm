import type { PluginRoute } from "@ky/admin-core";
import { SettingsPage } from "./pages/settings-page";
import { DictionariesPage } from "./pages/dictionaries-page";

export const routes: PluginRoute[] = [
  {
    path: "/settings",
    requiredAnyPermissions: ["platform.settings.view", "agency.settings.view", "enterprise.settings.view"],
    element: <SettingsPage />
  },
  {
    path: "/dictionaries",
    requiredPermission: "platform.dictionaries.view",
    element: <DictionariesPage />
  }
];
