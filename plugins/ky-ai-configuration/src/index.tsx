import type { AdminPlugin } from "@ky/admin-core";
import { routes } from "./routes";

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
      menuKey: "ai.providers.view",
      requiredPermission: "platform.ai_providers.view"
    },
    {
      key: "ky-ai-configuration.models",
      label: "AI 模型",
      path: "/ai-models",
      icon: "RobotOutlined",
      menuKey: "ai.models.view",
      requiredPermission: "platform.ai_models.view"
    },
    {
      key: "ky-ai-configuration.default-models",
      label: "默认模型",
      path: "/ai-default-models",
      icon: "StarOutlined",
      menuKey: "ai.settings.view",
      requiredPermission: "platform.ai_model_settings.view"
    }
  ],
  routes
};

export default aiConfigurationPlugin;
