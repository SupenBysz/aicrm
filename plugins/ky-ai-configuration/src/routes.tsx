import type { PluginRoute } from "@ky/admin-core";
import { ProvidersPage } from "./pages/providers-page";
import { ModelsPage } from "./pages/models-page";
import { DefaultModelsPage } from "./pages/default-models-page";

export const routes: PluginRoute[] = [
  { path: "/ai-providers", requiredPermission: "platform.ai_providers.view", element: <ProvidersPage /> },
  { path: "/ai-models", requiredPermission: "platform.ai_models.view", element: <ModelsPage /> },
  { path: "/ai-default-models", requiredPermission: "platform.ai_model_settings.view", element: <DefaultModelsPage /> }
];
