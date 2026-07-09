import type { PluginRoute } from "@ky/admin-core";
import { MatrixAccountExecutorTerminalPage, MatrixAccountsPage } from "./pages/matrix-accounts-page";
import { matrixAccountPermissions } from "./permissions";

export const routes: PluginRoute[] = [
  {
    path: "/workbench/matrix-accounts/executor-terminal/:taskId",
    requiredAnyPermissions: matrixAccountPermissions.view,
    element: <MatrixAccountExecutorTerminalPage />
  },
  {
    path: "/workbench/matrix-accounts/douyin",
    requiredAnyPermissions: matrixAccountPermissions.view,
    element: <MatrixAccountsPage platform="douyin" />
  },
  {
    path: "/workbench/matrix-accounts/kuaishou",
    requiredAnyPermissions: matrixAccountPermissions.view,
    element: <MatrixAccountsPage platform="kuaishou" />
  },
  {
    path: "/workbench/matrix-accounts/xiaohongshu",
    requiredAnyPermissions: matrixAccountPermissions.view,
    element: <MatrixAccountsPage platform="xiaohongshu" />
  }
];
