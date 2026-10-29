import assert from "node:assert/strict";
import test from "node:test";
import { createElement, useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  activateWorkspaceAreaScroll,
  createWorkspaceAreaRouteCache,
  createWorkspaceAreaScrollMemory,
  rememberWorkspaceAreaRoute,
  rememberWorkspaceAreaScroll,
  selectWorkspaceAreaRoute,
  workspaceAreaLocationKey
} from "./workspace-area-route-cache.ts";
import { WorkspaceAreaRoutePaneFrame } from "./workspace-area-route-pane.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const location = (pathname, key = pathname) => ({ pathname, search: "", hash: "", key });
const snapshot = (area, pathname, node, key = pathname) => ({
  pathKey: workspaceAreaLocationKey(location(pathname, key)),
  location: location(pathname, key),
  navigationType: "PUSH",
  node
});

test("区域内路由快照与滚动位置按访问上下文隔离", () => {
  let routes = createWorkspaceAreaRouteCache("user-a|workspace-a|member-a|permission-1");
  routes = rememberWorkspaceAreaRoute(routes, routes.scopeKey, "manage", snapshot("manage", "/w/platform/a/manage/stores", { state: "kept" }));
  const selected = selectWorkspaceAreaRoute({
    cache: routes,
    scopeKey: routes.scopeKey,
    area: "manage",
    activeArea: "workbench",
    activePathKey: "/w/platform/a/workbench/home",
    liveSnapshot: null
  });
  assert.deepEqual(selected?.node, { state: "kept" });
  assert.equal(selectWorkspaceAreaRoute({
    cache: routes,
    scopeKey: "user-a|workspace-a|member-a|permission-2",
    area: "manage",
    activeArea: "workbench",
    activePathKey: "/w/platform/a/workbench/home",
    liveSnapshot: null
  }), null);
  assert.equal(selectWorkspaceAreaRoute({
    cache: routes,
    scopeKey: routes.scopeKey,
    area: "manage",
    activeArea: "manage",
    activePathKey: "/w/platform/a/manage/stores",
    liveSnapshot: null,
    isAllowed: () => false
  }), null);

  let scroll = createWorkspaceAreaScrollMemory(routes.scopeKey, "manage");
  scroll = rememberWorkspaceAreaScroll(scroll, routes.scopeKey, "manage", 240);
  scroll = rememberWorkspaceAreaScroll(scroll, routes.scopeKey, "workbench", 90);
  assert.equal(activateWorkspaceAreaScroll(scroll, routes.scopeKey, "workbench").scrollTop, 90);
  assert.equal(activateWorkspaceAreaScroll(scroll, routes.scopeKey, "manage").scrollTop, 240);
  assert.equal(activateWorkspaceAreaScroll(scroll, "user-b|workspace-a|member-a|permission-1", "manage").scrollTop, 0);
});

test("同一路径导航保留已挂载页面节点和内部表单状态", async () => {
  function StatefulForm() {
    const [value, setValue] = useState("初始值");
    return createElement("button", { onClick: () => setValue("未保存输入") }, value);
  }
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(WorkspaceAreaRoutePaneFrame, {
      area: "manage",
      active: true,
      children: createElement(StatefulForm)
    }));
  });
  await act(async () => renderer.root.findByType("button").props.onClick());
  await act(async () => renderer.update(createElement(WorkspaceAreaRoutePaneFrame, {
    area: "manage",
    active: false,
    children: createElement(StatefulForm)
  })));
  assert.equal(renderer.root.findByProps({ "data-workspace-area": "manage" }).props.hidden, true);
  await act(async () => renderer.update(createElement(WorkspaceAreaRoutePaneFrame, {
    area: "manage",
    active: true,
    children: createElement(StatefulForm)
  })));
  assert.equal(renderer.root.findByProps({ "data-workspace-area": "manage" }).props.hidden, false);
  assert.equal(renderer.root.findByType("button").children[0], "未保存输入");
  await act(async () => renderer.unmount());
});

test("路由缓存命中时沿用原页面节点而非重建 Drawer 页面", () => {
  const scopeKey = "user|workspace|membership|permissions";
  const original = createElement("aside", { id: "drawer-state" }, "保持打开");
  const first = snapshot("manage", "/w/platform/root/manage/shops", original, "first-location");
  let routes = rememberWorkspaceAreaRoute(createWorkspaceAreaRouteCache(scopeKey), scopeKey, "manage", first);
  const changedLocation = snapshot("manage", first.pathKey, createElement("aside", { id: "new" }, "new"), "second-location");
  routes = rememberWorkspaceAreaRoute(routes, scopeKey, "manage", changedLocation);
  assert.equal(routes.manage?.node, original);
});

test("WorkspaceLayout 实际接入两个隐藏保活面板与访问范围", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./app.tsx", import.meta.url), "utf8");
  assert.match(source, /useNavigationType\(\)/);
  assert.match(source, /useOutlet\(\)/);
  assert.match(source, /areaScrollMemoryRef/);
  assert.match(source, /roles:[^\n]*sort\(\)[\s\S]*permissions:[^\n]*sort\(\)[\s\S]*actionPermissions:[^\n]*sort\(\)[\s\S]*menuKeys:[^\n]*sort\(\)/);
  assert.match(source, /membershipId:\s*workspace\.membershipId/);
  assert.match(source, /WorkspaceAreaRoutePane[\s\S]*area="workbench"[\s\S]*WorkspaceAreaRoutePane[\s\S]*area="manage"/);
  const headerAt = source.indexOf("<Layout.Header");
  const contentAt = source.indexOf("<Layout.Content", headerAt);
  const paneAt = source.indexOf("<WorkspaceAreaRoutePane", contentAt);
  assert.ok(headerAt >= 0 && contentAt > headerAt && paneAt > contentAt, "宿主 header 应位于 route pane 之外并保持常驻");
  assert.match(source, /const appearance\s*=\s*useAppearance\(\)/);
});
