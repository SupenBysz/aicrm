import type { AdminPlugin } from "@ky/admin-core";
import { routes } from "./routes";

export const identityManagementPlugin: AdminPlugin = {
  name: "ky-identity-management",
  navGroup: "身份管理",
  navOrder: 20,
  menus: [
    {
      key: "ky-identity-management.members",
      label: "用户管理",
      path: "/members",
      icon: "TeamOutlined",
      menuKey: "identity.members.view",
      requiredAnyPermissions: ["platform.members.view", "agency.members.view", "enterprise.members.view"]
    },
    {
      key: "ky-identity-management.invitations",
      label: "邀请管理",
      path: "/invitations",
      icon: "UsergroupAddOutlined",
      menuKey: "identity.invitations.view",
      requiredAnyPermissions: ["platform.invitations.view", "agency.invitations.view", "enterprise.invitations.view"]
    }
  ],
  routes
};

export default identityManagementPlugin;
