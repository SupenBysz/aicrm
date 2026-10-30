import { lazy, Suspense } from "react";
import { Spin } from "antd";
import type { PluginRoute } from "@ky/admin-core";
const Page = lazy(() => import("./pages/component-center-page"));
const element = <Suspense fallback={<Spin aria-label="正在加载组件中心" />}><Page /></Suspense>;
export const routes: PluginRoute[] = [
  { path: "/system/components", requiredPermission: "platform.component_center.view", element },
  { path: "/system/components/:componentId", requiredPermission: "platform.component_center.view", element }
];
