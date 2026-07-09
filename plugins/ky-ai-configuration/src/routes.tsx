import type { PluginRoute } from "@ky/admin-core";
import { ProvidersPage } from "./pages/providers-page";
import { ModelsPage } from "./pages/models-page";
import { DefaultModelsPage } from "./pages/default-models-page";
import { ExecutorsPage } from "./pages/executors-page";
import { ExecutorTasksPage } from "./pages/executor-tasks-page";

export const routes: PluginRoute[] = [
  { path: "/ai-providers", requiredPermission: "platform.ai_providers.view", element: <ProvidersPage /> },
  { path: "/ai-models", requiredPermission: "platform.ai_models.view", element: <ModelsPage /> },
  { path: "/ai-default-models", requiredPermission: "platform.ai_model_settings.view", element: <DefaultModelsPage /> },
  { path: "/ai-executors", requiredPermission: "platform.ai_executors.view", element: <ExecutorsPage /> },
  { path: "/ai-executor-tasks", requiredPermission: "platform.ai_executor_tasks.view", element: <ExecutorTasksPage /> }
];
