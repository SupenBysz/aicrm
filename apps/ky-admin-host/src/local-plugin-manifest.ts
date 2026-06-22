import type { AdminPlugin } from "@ky/admin-core";
import { accessManagementPlugin } from "@ky/plugin-access-management";
import { aiConfigurationPlugin } from "@ky/plugin-ai-configuration";
import { auditManagementPlugin } from "@ky/plugin-audit-management";
import { identityManagementPlugin } from "@ky/plugin-identity-management";
import { notificationPlugin } from "@ky/plugin-notification";
import { organizationManagementPlugin } from "@ky/plugin-organization-management";
import { systemSettingsPlugin } from "@ky/plugin-system-settings";

export const localPlugins: AdminPlugin[] = [
  identityManagementPlugin,
  organizationManagementPlugin,
  accessManagementPlugin,
  auditManagementPlugin,
  notificationPlugin,
  systemSettingsPlugin,
  aiConfigurationPlugin
];
