import type { AdminPlugin } from "@ky/admin-core";
import { routes } from "./routes";
import { AI_CONFIGURATION_MENU_KEY } from "./permissions";

export const aiConfigurationPlugin: AdminPlugin = {
  name: "ky-ai-configuration",
  navGroup: "AI 配置",
  navOrder: 50,
  menus: [
    {
      key: "ky-ai-configuration.providers",
      label: "AI 供应商",
      path: "/ai-providers",
      icon: "ApiOutlined",
      menuKey: AI_CONFIGURATION_MENU_KEY,
      requiredPermission: "platform.ai_providers.view"
    },
    {
      key: "ky-ai-configuration.models",
      label: "AI 模型",
      path: "/ai-models",
      icon: "RobotOutlined",
      menuKey: AI_CONFIGURATION_MENU_KEY,
      requiredPermission: "platform.ai_models.view"
    },
    {
      key: "ky-ai-configuration.default-models",
      label: "默认模型",
      path: "/ai-default-models",
      icon: "StarOutlined",
      menuKey: AI_CONFIGURATION_MENU_KEY,
      requiredPermission: "platform.ai_model_settings.view"
    },
    {
      key: "ky-ai-configuration.executors",
      label: "AI 执行器",
      path: "/ai-executors",
      icon: "RobotOutlined",
      menuKey: AI_CONFIGURATION_MENU_KEY,
      requiredPermission: "platform.ai_executors.view"
    },
    {
      key: "ky-ai-configuration.executor-tasks",
      label: "执行器任务",
      path: "/ai-executor-tasks",
      icon: "FileSearchOutlined",
      menuKey: AI_CONFIGURATION_MENU_KEY,
      requiredPermission: "platform.ai_executor_tasks.view"
    }
  ],
  routes
};

export default aiConfigurationPlugin;
