import assert from "node:assert/strict";
import test from "node:test";
import { buildMenuNavigation, normalizeMenuIconName } from "./menu-navigation-model.ts";

const fallbackGroupIconName = (_label, fallback = "AppstoreOutlined") => fallback;
const targetForWebView = (key) => `/menu-pages/management/${key}`;

test("菜单目录按分组、排序和语义图标构建，并支持服务端过滤后的权威叶节点", () => {
  const result = buildMenuNavigation({
    workspaceType: "platform",
    fallbackGroupLabel: "其他",
    fallbackGroupIconName,
    targetForWebView,
    authoritative: true,
    candidates: [],
    directory: [
      { menuKey: "web.second", name: "第二项", icon: "tiktok", parentKey: "group.tools", sortOrder: 20, nodeType: "leaf", pageType: "webview" },
      { menuKey: "group.tools", name: "工具", icon: "team", parentKey: null, sortOrder: 3, nodeType: "group", pageType: "internal" },
      { menuKey: "web.first", name: "第一项", icon: "douyin", parentKey: "group.tools", sortOrder: 10, nodeType: "leaf", pageType: "webview" },
      { menuKey: "web.inactive", name: "停用", icon: "AppstoreOutlined", parentKey: null, sortOrder: 1, nodeType: "leaf", pageType: "webview", status: "disabled" }
    ],
    allowDynamicWebView: () => true
  });
  assert.equal(normalizeMenuIconName("team"), "TeamOutlined");
  assert.equal(normalizeMenuIconName("tiktok"), "TikTokOutlined");
  assert.deepEqual(result.groups.map((group) => [group.key, group.label, group.iconName]), [["group.tools", "工具", "TeamOutlined"]]);
  assert.deepEqual(result.groups[0].items.map((item) => [item.menuKey, item.iconName]), [
    ["web.first", "TikTokOutlined"],
    ["web.second", "TikTokOutlined"]
  ]);
  assert.deepEqual(result.standalone, []);
});

test("静态候选权限与动态叶节点权限继续受限，缺少权威投影字段不扩大范围", () => {
  const result = buildMenuNavigation({
    workspaceType: "agency",
    fallbackGroupLabel: "其他",
    fallbackGroupIconName,
    targetForWebView,
    authoritative: true,
    candidates: [{ key: "static.allowed", menuKey: "static.allowed", label: "静态", iconName: "AppstoreOutlined", target: "/static", sortOrder: 1, groupSortOrder: 1 }],
    directory: [
      { menuKey: "static.allowed", name: "静态", icon: "", parentKey: null, sortOrder: 1, nodeType: "leaf", pageType: "internal" },
      { menuKey: "web.allowed", name: "授权叶", icon: "", parentKey: null, sortOrder: 2, nodeType: "leaf", pageType: "webview" },
      { menuKey: "web.group", name: "分组", icon: "", parentKey: null, sortOrder: 3, nodeType: "group", pageType: "webview" }
    ],
    allowCandidate: () => false,
    allowDynamicWebView: (row) => row.menuKey === "web.allowed"
  });
  assert.deepEqual(result.standalone.map((item) => item.menuKey), ["web.allowed"]);
  assert.deepEqual(result.groups, []);
});
