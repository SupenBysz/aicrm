import { scriptManagementPlugin } from "@ky/plugin-script-management";
import type { AdminPlugin } from "@ky/admin-core";
import { accessManagementPlugin } from "@ky/plugin-access-management";
import { aiConfigurationPlugin } from "@ky/plugin-ai-configuration";
import { auditManagementPlugin } from "@ky/plugin-audit-management";
import { identityManagementPlugin } from "@ky/plugin-identity-management";
import { matrixAccountPlugin } from "@ky/plugin-matrix-account";
import { notificationPlugin } from "@ky/plugin-notification";
import { organizationManagementPlugin } from "@ky/plugin-organization-management";
import { systemSettingsPlugin } from "@ky/plugin-system-settings";
import { componentCenterPlugin } from "@ky/plugin-component-center";

export const localPlugins: AdminPlugin[] = [
  scriptManagementPlugin,
  matrixAccountPlugin,
  identityManagementPlugin,
  organizationManagementPlugin,
  accessManagementPlugin,
  auditManagementPlugin,
  notificationPlugin,
  systemSettingsPlugin,
  aiConfigurationPlugin,
  componentCenterPlugin
];
