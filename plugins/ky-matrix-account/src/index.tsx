import type { AdminPlugin } from "@ky/admin-core";
import { routes } from "./routes";
import { matrixAccountPermissions } from "./permissions";

export * from "./account-onboarding";

export const matrixAccountPlugin: AdminPlugin = {
  name: "ky-matrix-account",
  navGroup: "矩阵账号",
  navOrder: 10,
  workbenchMenus: [
    {
      key: "ky-matrix-account.root",
      label: "矩阵账号",
      path: "/workbench/matrix-accounts",
      icon: "AppstoreOutlined",
      menuKey: "menu.platform.matrix_accounts",
      requiredAnyPermissions: matrixAccountPermissions.view,
      children: [
        {
          key: "ky-matrix-account.douyin",
          label: "抖音账号",
          path: "/workbench/matrix-accounts/douyin",
          icon: "AppstoreOutlined",
          menuKey: "menu.platform.matrix_accounts",
          requiredAnyPermissions: matrixAccountPermissions.view
        },
        {
          key: "ky-matrix-account.kuaishou",
          label: "快手账号",
          path: "/workbench/matrix-accounts/kuaishou",
          icon: "AppstoreOutlined",
          menuKey: "menu.platform.matrix_accounts",
          requiredAnyPermissions: matrixAccountPermissions.view
        },
        {
          key: "ky-matrix-account.xiaohongshu",
          label: "小红书账号",
          path: "/workbench/matrix-accounts/xiaohongshu",
          icon: "AppstoreOutlined",
          menuKey: "menu.platform.matrix_accounts",
          requiredAnyPermissions: matrixAccountPermissions.view
        }
      ]
    }
  ],
  routes
};

export default matrixAccountPlugin;
