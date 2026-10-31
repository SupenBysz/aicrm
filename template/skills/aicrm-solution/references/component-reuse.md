# 组件复用与展示标准

适用于新增/修改后台UI、公共组件、主题、表单、抽屉和列表。纯服务端或纯文字任务不必浏览全部目录。

## 开发前找已有实现

- 从项目根检索 `docs/components/README.md` 或 `docs/components/component-index.json` 的用途、导出名与关键词。后台入口是“管理中心 → 系统设置 → 组件中心”。
- 优先Ant Design现有控件，再选Core公开组件、现有组合模式。Core组件只放跨插件能力，不把单页业务组件搬入Core。
- 当前场景已有匹配的项目标准时优先用它，不能因为能用antd拼装就重复实现；基础控件直接用antd，避免无价值转发封装。
- 能直接复用则使用公开导入；有通用缺口则评估兼容扩展；确需新增时在PR写明现有实现为何不适用和新组件归属。普通实现选择无需额外用户批准。
- experimental是展示条目的验收状态，不代表原组件线上不可用。不得为“让目录看起来稳定”无证据修改状态。

## 变更同步

目录事实源：`plugins/ky-component-center/src/catalog/metadata.ts`。交互示例在同插件的`src/examples/<id>/usage.tsx`，必须真实引用组件、独立编译和完整可复制；预览与源码展示共用此文件。不要手改生成索引或public/component-examples资源。

```sh
corepack pnpm components:generate
corepack pnpm components:check
corepack pnpm components:test
```

公共组件变更需核对对应示例和使用规范，运行适当的交互/布局验证；不写只镜像实现的测试。修改源码/元数据后生成索引并检查差异；索引记录关联公共源码指纹，漂移检查不能替代语义审查。弃用项需指定替代、兼容期和调用方迁移，先迁移再删除。

## 列表概览布局

页面级概览通过`ListPageCard.overview`传入，位于标题下、筛选和表格卡片外。不得将ListOverview放进表格children、toolbar或表头。概览使用业务名称，保留统计范围、权限隔离和筛选回第一页合同；存在可交互总数指标时避免重复“全部记录”按钮。

## 示例边界

仅可信仓库代码及虚构数据。示例不得读取Host session、真实偏好、localStorage、window.parent/top或原生桥，不得发业务fetch或任意外部请求。未知模拟请求失败，不兜底真实接口。主题、Router、QueryClient和Portal属于独立预览文档；不能为演示直接导入Host真实上下文。

CSP/iframe不被称为可执行任意不可信代码的安全沙箱。抽屉继续遵守 [固定Header布局规范](drawer-layout.md)，正文滚动、标题左侧、操作右侧、避让主Header。

## 交付说明

涉及UI的PR写“复用依据”：使用了哪些组件/模式、新增缺口、示例/规范更新及验证结果。无新UI可写不适用。构建、浏览器和安装客户端分别报告；组件中心不自动授权发布。

## 平台外观编辑

涉及平台默认与个人外观时，遵循 [平台外观交互合同](../../../../docs/platform-appearance-interaction.md)：选择只产生临时预览，显式保存后提交平台默认；不能把预览写入个人偏好、登录快照或原生窗口。失败通过轻量浮层反馈，保留草稿和 revision，版本冲突必须先确认并读取最新设置。复用 `AppearanceControls` 和 `ListPageCard`，不另造选择器。
