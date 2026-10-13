import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("脚本编写帮助与 Web 专用窗口 JSSDK/运行时契约一致", async () => {
  const source = await readFile(new URL("./pages/script-management-page.tsx", import.meta.url), "utf8");
  const start = source.indexOf(" const helpSections=[");
  const end = source.indexOf(" const helpContent=", start);
  assert.ok(start >= 0 && end > start, "帮助章节边界缺失");
  const help = source.slice(start, end);
  for (const title of ["JSSDK 入门", "生命周期与注入时机", "网络请求与响应", "宿主上下文", "窗口标题", "工具栏按钮与 Ant Design", "公共脚本", "完整业务脚本示例", "授权与错误处理", "URL 匹配", "JavaScript 编写规范", "幂等与重复执行", "CSS 与 JavaScript", "调试与版本排查"]) {
    assert.ok(help.includes(title), `缺少帮助章节：${title}`);
  }
  for (const schedulerEvent of ["document_start", "dom_content_loaded", "document_idle", "load", "spa_route_change", "user_action"]) {
    assert.ok(help.includes(schedulerEvent), `缺少调度事件：${schedulerEvent}`);
  }
  for (const lifecycleEvent of ["documentStart", "domReady", "pageLoad", "routeChange", "userAction"]) {
    assert.ok(help.includes(lifecycleEvent), `缺少脚本生命周期事件：${lifecycleEvent}`);
  }
  for (const api of ["on(event, handler)", "once(event, handler)", "off(event, handler?)", "subscribeRequest", "subscribeResponse", "interceptRequest", "interceptResponse", "jssdk.host", "jssdk.store", "jssdk.store.getStoreInfo()", "jssdk.store.setStoreInfo(input)", "jssdk.host.upload({ url, purpose: \"logo\" })", "jssdk.window", "jssdk.ui", "jssdk.window.addActionButton", "jssdk.ui.message", "jssdk.ui.notification", "jssdk.ui.modal.confirm", "jssdk.public.register", "getCapabilities()", "NetworkMatch", "NetworkOptions", "NetworkEvent", "NetworkDecision", "NetworkHandlerEvent", "LifecycleDetail", "WebWindowStoreInfo", "WebWindowCurrentUserInfo", "WebWindowTitleState", "fillLoginForm", "getStoreInfo", "getCurrentUser", "updateLoginSpaceInfo(input)", "Promise<LoginSpaceInfo>", "logged_in"]) {
    assert.ok(help.includes(api), `缺少 JSSDK 契约：${api}`);
  }
  for (const boundary of ["仅由受信宿主显式派发语义动作；当前没有产品操作入口", "detail 包含 actionId 与 url", "不会自动监听页面 click、input、keydown", "matchConfiguredUrlRules=false", "v.run_at", "page_first", "strict_document_start", "missed_document_start", "-10000 至 10000", "NETWORK_CAPABILITY_DENIED", "NETWORK_DECISION_EXPIRED", "512 KiB", "getCapabilities()", "不代表当前资源已经获准使用"]) {
    assert.ok(help.includes(boundary), `缺少运行时边界：${boundary}`);
  }
  assert.doesNotMatch(help, /WebWindowManager\.dispatchUserAction/);
  assert.doesNotMatch(help, /当前仅维护版本配置，不执行脚本注入/);
  assert.doesNotMatch(help, /JSSDK 示例|数据结构/);
  assert.doesNotMatch(help, /DD_LOGIN|抖店运行时/);
  assert.doesNotMatch(help, /所有资源统一在 document_start/);
  assert.doesNotMatch(help, /CSS 先于 JavaScript/);
  assert.doesNotMatch(help, /全部标记为规划中/);

  assert.match(source, /readHelpDrawerWidth\(getHelpDrawerStorage\(\)/, "帮助抽屉未从持久化偏好读取默认宽度");
  assert.match(source, /help-drawer-sizing/, "帮助抽屉宽度计算未使用独立 helper");
  assert.match(source, /clampHelpDrawerWidth/, "帮助抽屉未接入宽度 clamp helper");
  assert.match(source, /resizeHelpDrawerWidth/, "帮助抽屉未接入拖拽宽度 helper");
  assert.match(source, /nudgeHelpDrawerWidth/, "帮助抽屉方向键未接入实际宽度 helper");
  assert.match(source, /const actual=applyHelpWidth\(helpWidth\);helpDragRef\.current=\{startX:event\.clientX,startWidth:actual\}/, "拖拽起点未使用实际显示宽度");
  assert.match(source, /tabIndex=\{0\}/, "拖拽把手缺少键盘可达性");
  assert.match(source, /aria-valuemin=\{helpWidthForViewport\(560\)\}/, "拖拽把手缺少最小宽度信息");
  assert.match(source, /aria-valuemax=\{helpWidthForViewport\(1600\)\}/, "拖拽把手缺少最大宽度信息");
  assert.match(source, /onHelpResizeKeyDown/, "拖拽把手缺少键盘调整处理");
  assert.match(source, /event\.key==='ArrowLeft'\?24:-24/, "键盘调整方向不符合拖拽方向");
  for (const marker of ["helpFullscreen", "helpDragging", "脚本编写帮助", "全屏显示", "退出全屏", "拖动调整帮助窗口宽度", "pointermove", "pointerup", "pointercancel", "mouseup", "document.body.style.cursor", "document.body.style.userSelect"]) {
    assert.ok(source.includes(marker), `缺少帮助抽屉交互契约：${marker}`);
  }
  assert.match(source, /is-fullscreen/, "缺少全屏状态样式钩子");
  assert.match(source, /is-resizing/, "缺少拖拽状态样式钩子");
  assert.match(source, /import \{ jssdkCompletionItems \} from "\.\.\/jssdk-reference"/, "Monaco 未接入集中维护的 JSSDK 关键词提示");
  const reference = await readFile(new URL("./jssdk-reference.ts", import.meta.url), "utf8");
  assert.match(reference, /label: "jssdk\.host\.updateLoginSpaceInfo"/, "Monaco 关键词提示缺少登录空间 SDK 方法");
  assert.match(reference, /label: "jssdk\.host\.upload（店铺 LOGO）"/, "Monaco 关键词提示缺少远程店铺 LOGO 上传 SDK 方法");
  assert.match(reference, /label: "jssdk\.store\.setStoreInfo"/, "Monaco 关键词提示缺少店铺资料更新 SDK 方法");
  assert.match(source, /登录空间列表显示的 UUID 由服务端生成/, "帮助未说明登录空间 UUID 的来源与用途边界");
  assert.match(source, /不会把页面 Cookie 转发给图片站/, "帮助未说明远程图片上传的凭据边界");
  assert.match(reference, /updateLoginSpaceInfo（仅名称）/, "Monaco 缺少独立更新名称示例");
  assert.match(reference, /updateLoginSpaceInfo（仅登录状态）/, "Monaco 缺少独立更新登录状态示例");
  for (const marker of ['provider: "antd"', 'provider: "iconfont"', 'mode: "font-class"', 'mode: "unicode"', 'mode: "symbol"', 'label: "jssdk.ui.message.success"', 'label: "jssdk.ui.modal.confirm"']) {
    assert.ok(reference.includes(marker), `Monaco 关键词提示缺失：${marker}`);
  }
  assert.match(source, /当前最新稳定版打包 Ant Design/);
  assert.match(source, /页面完整导航或 SPA 路由变化时，旧按钮和回调会被清理/);
  assert.match(source, /工具栏最多显示 4 个按钮/);
  assert.match(help, /displayName 与 loginStatus 可独立提供/);
  assert.match(help, /不会上传浏览器数据，也不能修改同步状态/);
  assert.match(help, /await sdk\.host\.updateLoginSpaceInfo\(\{ displayName:/);
  assert.match(help, /await sdk\.host\.updateLoginSpaceInfo\(\{ loginStatus: "logged_in" \}\)/);

  const examples = [...help.matchAll(/<pre[^>]*>\{`([\s\S]*?)`}<\/pre>/g)].map((match) => match[1]);
  assert.ok(examples.length >= 7, "各 API 主题的完整示例缺失");
  assert.match(source, /script-writing-help-fields/, "缺少逐字段解释表");
  for (const field of ["version", "lifecycle", "net", "host", "window", "public", "getCapabilities()", "NetworkMatch", "NetworkOptions", "NetworkEvent", "NetworkDecision", "action", "url", "method", "headers", "body", "status", "responseHeaders", "decisionToken", "subscriptions", "continue / abort / redirect / fulfill", "user.id", "user.username", "user.displayName", "user.avatarUrl", "user.status", "organization.id", "organization.name", "organization.code", "organization.status", "workspace.type", "workspace.id", "workspace.name", "roles", "fetchedAt", "hasPassword", "loginStatus", "accountSelector", "passwordSelector", "submitSelector", "accountFilled", "passwordFilled", "submitted", "color", "fontSize", "fontWeight", "letterSpacing", "fontFamily", "width", "align", "visible", "identifier", "factory", "返回对象", "get / has"]) {
    assert.ok(help.includes(field), `字段解释缺失：${field}`);
  }
  const observedExample = examples.find((example) => example.includes("subscribeResponse"));
  assert.ok(observedExample, "缺少响应观察示例");
  assert.doesNotMatch(observedExample, /\.(abort|redirect|fulfill)\s*\(/, "观察示例不应调用拦截决策");
  const businessStart = help.indexOf('{key:"business-example"');
  const businessEnd = help.indexOf('{key:"errors"', businessStart);
  assert.ok(businessStart >= 0 && businessEnd > businessStart, "完整业务示例章节位置或边界缺失");
  const business = help.slice(businessStart, businessEnd);
  for (const marker of ["KWW_PUBLIC_DEPENDENCIES", "模板插入处的", "全文识别这份声明", "factory 需返回导出对象", "必需方法是否导出由模板在业务逻辑前检查", "publicIdentifiers", "jssdk.public.register", "jssdk.public.get(identifier)", "ORDER_HELPERS", "不动态加载", "orders.example.com/orders/123?tab=detail", "公共脚本：注册订单工具", "业务脚本：增强订单详情", "window.jssdk", "jssdk.public?.get(\"ORDER_HELPERS\")", "normalizeOrderId", "Symbol.for(\"kww.script-management.orders-example.v1\")", "publicApi.has(\"ORDER_HELPERS\")", "if (window[instanceKey]) return", "delete window[instanceKey]", "lifecycle.on(\"domReady\"", "lifecycle.on(\"routeChange\"", "jssdk.host.getStoreInfo()", "jssdk.window.setHeaderTitle({ text:", "jssdk.window.resetTitle()", "jssdk.net.subscribeResponse(", "stages: [\"responseHeaders\"]", "includeBody: false", "event.status", "responseObserverReady", "disposeDomReady()", "disposeRouteChange()", "pagehide", "网络观察未获授权，保留页面原行为", "保留页面原行为", "getCapabilities()", "不代表当前脚本已获授权"]) {
    assert.ok(business.includes(marker), `完整业务示例缺少契约内容：${marker}`);
  }
  assert.doesNotMatch(business, /jssdk\.public\.load\s*\(/, "示例不能虚构公共脚本动态加载 API");
  assert.doesNotMatch(business, /\.(abort|redirect|fulfill)\s*\(/, "公共业务示例只能观察网络，不应做拦截决策");
  const businessExamples = [...business.matchAll(/<pre[^>]*>\{`([\s\S]*?)`}<\/pre>/g)].map((match) => match[1]);
  assert.equal(businessExamples.length, 2, "完整业务示例应分别提供公共脚本和业务脚本代码块");
  for (const marker of ["先在公共脚本管理中启用此资源", "源码中的模板声明依赖", "服务端按 KWW_PUBLIC_DEPENDENCIES 准备模块", "导航可能让公共脚本再次运行", "复用已有命名空间", "纯转换函数", "普通浏览器或能力未注入时直接退出", "公共脚本方法未导出", "稳定单例标记", "routeChange 继续跟进 SPA 导航", "旧的异步店铺信息返回后会被丢弃", "串行队列避免多个路由更新并行", "路径 /orders/:id", "接口返回完整店铺上下文；本例只使用其中的 storeName/account 作为展示标题", "标题 API 只改变宿主窗口标题", "只恢复先前设置的宿主标题", "只观察虚构订单 API 的 GET 响应头阶段", "includeBody:false", "只读取状态码用于诊断", "网络观察未获授权时降级", "订阅异步返回取消函数", "页面先关闭", "清理保持幂等", "恢复宿主标题并释放单例标记", "等订阅建立完成后再执行它", "等当前串行更新结束", "页面离开时回收当前文档资源"]) {
    assert.ok(businessExamples.join("\n").includes(marker), `完整业务示例注释缺少说明：${marker}`);
  }
  assert.match(businessExamples[0], /try \{[\s\S]*jssdk\.public\.register\([\s\S]*identifier: "ORDER_HELPERS"[\s\S]*factory: \(\{ jssdk \}\) => \([\s\S]*normalizeOrderId:[\s\S]*catch \(error\)/);
  assert.match(businessExamples[0], /publicApi\.has\("ORDER_HELPERS"\)/, "公共脚本缺少重复注册保护");
  assert.doesNotMatch(help, /factory: \(\{ exports \}\)/, "帮助示例不得依赖跨 contextBridge 的参数对象回写");
  assert.match(businessExamples[1], /Symbol\.for\("kww\.script-management\.orders-example\.v1"\)[\s\S]*if \(window\[instanceKey\]\) return/ , "业务脚本缺少稳定单例幂等保护");
  assert.match(businessExamples[1], /jssdk\.net\.subscribeResponse[\s\S]*includeBody: false[\s\S]*event\.status/);
  assert.match(businessExamples[1], /function cleanup\(\)[\s\S]*disposeDomReady\(\)[\s\S]*disposeRouteChange\(\)[\s\S]*delete window\[instanceKey\][\s\S]*disposeResponseObserver\?\.\(\)/, "pagehide 未同时清理生命周期、单例标记和网络观察订阅");
  assert.doesNotMatch(businessExamples[1], /console\.(?:log|info|warn)\([^\n]*(?:event\.(?:url|headers|body)|location\.href)/, "业务示例不应记录完整 URL 或网络内容");
  for (const action of ["continue", "abort", "redirect", "fulfill"]) {
    assert.match(help, new RegExp(`action[^\\n]*${action}`), `缺少 NetworkDecision 动作说明：${action}`);
  }
  assert.match(help, /redirect 仅在请求阶段使用 decision\.url/);
  assert.match(help, /redirect 必填；请求 continue 可选/);
  assert.match(help, /不校验 redirect 目标来源/);
  assert.match(help, /订阅 match 自动应用到新目标/);
  assert.match(help, /自行限制为可信且业务允许的 URL/);
  assert.match(help, /continue 在请求阶段可替换请求方法/);
  assert.match(help, /响应阶段不要传入该字段/);
  assert.match(help, /响应阶段不要用 continue 传 body/);
  assert.match(help, /本地决策路径不额外过滤敏感头/);
  assert.match(help, /超过 512 KiB 时继续原请求\/响应/);
  assert.match(help, /fulfill.*默认 200/);
  assert.match(help, /body 默认空字符串/);
  assert.match(help, /interceptRequest\(/);
  assert.match(help, /interceptResponse\(/);
  assert.match(help, /不要依赖.*continue.*修改响应字段/);
  assert.doesNotMatch(help, /敏感头仍受宿主策略过滤|响应头.*仍由宿主过滤/);
  assert.doesNotMatch(help, /redirect.*宿主来源校验|redirect.*自动.*匹配规则/);
  for (const urlExample of ["https://shop.example.com/product/list?channel=1", "channel=2", "https://shop.example.com/product/42?channel=1", "https://shop.example.com/products/42", "https://shop.example.com/product/*", "https://other.example.com/product/42", "任一命中即可", "最多 32 条", "ignoreQuery", "publicIdentifiers", "matchConfiguredUrlRules=true", "matchConfiguredUrlRules=false", "不在服务端按 URL 过滤"]) {
    assert.ok(help.includes(urlExample), `缺少 URL 匹配示例/边界：${urlExample}`);
  }
  assert.doesNotMatch(help, /continue 按请求\/响应阶段应用 url\/method\/headers\/body/);
  for (const example of examples) {
    assert.doesNotMatch(example, /Token|Cookie|Storage|executeJavaScript|insertCSS/);
    Function(`async function __helpExample__(){\n${example}\n}`);
  }
});
