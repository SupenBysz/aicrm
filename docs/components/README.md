# 项目组件复用索引

本文件由 scripts/generate_component_catalog.mjs 生成，请勿手改。组件中心入口：管理中心 → 系统设置 → 组件中心。

开发前按用途检索本文件或 component-index.json，优先antd、再Core、再组合模式；确需新增时说明现有能力缺口。experimental代表展示项验收状态，不改写原组件业务发布状态。

| 名称 | 用途 | 导入/归属 | 示例 |
| --- | --- | --- | --- |
| 设计基础与主题色板 | 展示现有配色、语义色和常用布局值；未统一的间距明确标注。 | @ky/admin-core / themeColors | [源码](../../plugins/ky-component-center/src/examples/design-tokens/usage.tsx) |
| 文字与图标 | 沿用Ant Design文字层级和图标，不创建重复基础控件。 | 组合模式 | [源码](../../plugins/ky-component-center/src/examples/typography-icons/usage.tsx) |
| 按钮 Button | 操作主次、加载和禁用状态。 | antd / Button | [源码](../../plugins/ky-component-center/src/examples/button/usage.tsx) |
| 输入 Input | 输入、清除、错误与禁用。 | antd / Input | [源码](../../plugins/ky-component-center/src/examples/input/usage.tsx) |
| 选择 Select | 选择器及下拉浮层。 | antd / Select | [源码](../../plugins/ky-component-center/src/examples/select/usage.tsx) |
| 开关 Switch | 布尔选择与加载。 | antd / Switch | [源码](../../plugins/ky-component-center/src/examples/switch/usage.tsx) |
| 状态标签 Tag | 语义色用于状态，不只依靠颜色解释含义。 | antd / Tag | [源码](../../plugins/ky-component-center/src/examples/tag/usage.tsx) |
| 表格 Table | 稳定rowKey、分页及窄屏横向滚动。 | antd / Table | [源码](../../plugins/ky-component-center/src/examples/table/usage.tsx) |
| 标签页 Tabs | 分组切换和禁用。 | antd / Tabs | [源码](../../plugins/ky-component-center/src/examples/tabs/usage.tsx) |
| 表单 Form | 保存通过原表单校验，模拟结果只留在预览。 | antd / Form | [源码](../../plugins/ky-component-center/src/examples/form/usage.tsx) |
| 抽屉布局 Drawer | 固定Header，标题左侧，保存右侧，正文独立滚动，避让主Header。 | antd / Drawer | [源码](../../plugins/ky-component-center/src/examples/drawer/usage.tsx) |
| 确认弹窗 Modal | 确认、取消与焦点返回，不执行真实危险操作。 | antd / Modal | [源码](../../plugins/ky-component-center/src/examples/modal/usage.tsx) |
| 提示 Alert | 可理解的反馈，明确异常及恢复方式。 | antd / Alert | [源码](../../plugins/ky-component-center/src/examples/alert/usage.tsx) |
| 空状态 Empty | 真实空数据与错误状态区分。 | antd / Empty | [源码](../../plugins/ky-component-center/src/examples/empty/usage.tsx) |
| 骨架 Skeleton | 首次加载占位，避免布局跳动。 | antd / Skeleton | [源码](../../plugins/ky-component-center/src/examples/skeleton/usage.tsx) |
| 列表页面 ListPageCard | 页面标题、新增操作、卡片工具栏统一布局。 | @ky/admin-core / ListPageCard | [源码](../../plugins/ky-component-center/src/examples/list-page/usage.tsx) |
| 详情面板 DetailPagePanel | 通用详情容器。 | @ky/admin-core / DetailPagePanel | [源码](../../plugins/ky-component-center/src/examples/detail-panel/usage.tsx) |
| 列表概览 ListOverview | 统计、筛选、错误旧值和撤权隐藏。 | @ky/admin-core / ListOverview | [源码](../../plugins/ky-component-center/src/examples/list-overview/usage.tsx) |
| 品牌组合 BrandLogoLockup | 图形与AI后缀按宽度缩放；16px为容器规范。 | @ky/admin-core / BrandLogoLockup | [源码](../../plugins/ky-component-center/src/examples/brand-logo/usage.tsx) |
| AI品牌后缀 BrandAISuffix | 可选AI后缀与分隔点，颜色跟随currentColor。 | @ky/admin-core / BrandAISuffix | [源码](../../plugins/ky-component-center/src/examples/ai-suffix/usage.tsx) |
| 外观选择 AppearanceControls | 四主题与亮暗/系统选项，本例选择不保存真实偏好。 | @ky/admin-core / AppearanceControls | [源码](../../plugins/ky-component-center/src/examples/theme-controls/usage.tsx) |
| 搜索＋概览＋表格 | 完整组合范例，演示URL筛选与统计范围。 | 组合模式 | [源码](../../plugins/ky-component-center/src/examples/list-pattern/usage.tsx) |
| 权限受限操作 | 模拟权限Provider；不将前端控制当后端授权。 | 组合模式 | [源码](../../plugins/ky-component-center/src/examples/permissions/usage.tsx) |
| 批量请求 runBatchRequests | 纯工具的模拟部分失败汇总；本例没有网络请求。 | @ky/admin-core / runBatchRequests | [源码](../../plugins/ky-component-center/src/examples/batch-requests/usage.tsx) |

详细规范：[项目复用规则](../../template/skills/aicrm-solution/references/component-reuse.md)。索引只含静态元数据，无业务数据和凭证。
