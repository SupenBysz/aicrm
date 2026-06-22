import type { AdminPlugin } from "@ky/admin-core";
import { routes } from "./routes";

export const organizationManagementPlugin: AdminPlugin = {
  name: "ky-organization-management",
  navGroup: "组织管理",
  navOrder: 10,
  menus: [
    {
      key: "ky-organization-management.agencies",
      label: "机构管理",
      path: "/agencies",
      icon: "BankOutlined",
      menuKey: "platform.agencies.view",
      requiredPermission: "platform.agencies.view"
    },
    {
      key: "ky-organization-management.enterprises",
      label: "企业管理",
      path: "/enterprises",
      icon: "ShopOutlined",
      menuKey: "platform.enterprises.view",
      requiredPermission: "platform.enterprises.view"
    },
    {
      key: "ky-organization-management.qualifications",
      label: "资质审核",
      path: "/qualifications",
      icon: "SafetyCertificateOutlined",
      menuKey: "platform.qualifications.view",
      requiredPermission: "platform.qualifications.view"
    },
    {
      key: "ky-organization-management.qualification-submit",
      label: "资质提交",
      path: "/qualification-submit",
      icon: "SafetyCertificateOutlined",
      menuKey: "organization.qualification.view",
      requiredAnyPermissions: ["agency.qualification.view", "enterprise.qualification.view"]
    },
    {
      key: "ky-organization-management.current-organization",
      label: "当前组织",
      path: "/current-organization",
      icon: "IdcardOutlined",
      menuKey: "organization.profile.view",
      requiredAnyPermissions: ["agency.profile.view", "enterprise.profile.view"]
    },
    {
      key: "ky-organization-management.departments",
      label: "部门管理",
      path: "/departments",
      icon: "ApartmentOutlined",
      menuKey: "organization.departments.view",
      requiredAnyPermissions: ["agency.departments.view", "enterprise.departments.view"]
    },
    {
      key: "ky-organization-management.teams",
      label: "团队管理",
      path: "/teams",
      icon: "TeamOutlined",
      menuKey: "organization.teams.view",
      requiredAnyPermissions: ["agency.teams.view", "enterprise.teams.view"]
    }
  ],
  routes
};

export default organizationManagementPlugin;
