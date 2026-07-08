# 权限、菜单和 API 规则

## 命名规则

- 插件目录：`plugins/ky-<module-slug>`。
- 插件包名：`@ky/plugin-<module-slug>`。
- 插件导出变量：`<camelSlug>Plugin`。
- 菜单 key：`ky-<module-slug>.main`。
- 页面路由：优先使用名词复数，例如 `/customers`。
- 前端插件权限前缀：默认 `platform.<resource>`，资源名使用下划线，例如 `platform.customers`。
- 完整业务模块权限：按工作区生成 `<workspace>.<resource>.<action>`，例如 `enterprise.customers.view`。

## 权限占位

脚手架默认生成：

```ts
export const customerManagementPermissions = {
  view: "platform.customers.view",
  create: "platform.customers.create",
  update: "platform.customers.update",
  delete: "platform.customers.delete"
} as const;
```

完整业务模块会按工作区生成：

```ts
export const customerManagementModulePermissions = {
  view: ["enterprise.customers.view"],
  create: ["enterprise.customers.create"],
  update: ["enterprise.customers.update"],
  updateStatus: ["enterprise.customers.update_status"],
  delete: ["enterprise.customers.delete"]
};
```

接入业务时必须确认：

- 菜单 `menuKey` 使用 view 权限；多工作区模块使用 `requiredAnyPermissions`。
- 路由单工作区可使用 `requiredPermission`，多工作区必须使用 `requiredAnyPermissions`。
- 新建按钮检查 create 权限。
- 编辑检查 update 权限。
- 启停检查 `update_status` 权限。
- 删除或危险操作检查 delete 权限。
- 批量操作需要独立权限时，新增明确 action 权限。

## API 占位

前端插件脚手架默认生成 `api.ts` 占位。完整业务模块脚手架会生成可调用的前端 API client。接入真实业务时：

- API 路径使用 `/api/v1/<resource>`。
- 分页使用统一响应结构。
- 请求必须通过 `useRequestClient()` 获取 client。
- 查询条件变化后清空选择态。
- 后端未提供批量接口时，前端可临时用 `runBatchRequests` 汇总失败。

## 后端和 SQL 规则

- 完整业务模块默认生成独立服务 `services/ky-<slug>-service`。
- 服务必须读取 `shared/go.mod` 推导当前 Go module path，不要硬编码模板仓库路径。
- 服务接口必须校验 Bearer token、会话、工作区 Header、成员身份和权限。
- SQL 权限种子必须可重复执行，使用 `ON CONFLICT`。
- 业务表默认包含 `workspace_type`、`workspace_id`、`status`、`created_by`、`updated_by`、`created_at`、`updated_at`、`deleted_at`。
- Nginx API 代理要转发 Authorization 和 `X-KY-*` 工作区请求头。

## 列表页规则

- 使用 `ListPageCard`。
- `title` 为 H3 标题，由公共组件负责。
- `subtitle` 在多选时显示 `已选择 N 项` 和 `清空选择`。
- `toolbar` 放查询输入和 `Segmented` 状态筛选。
- 新增按钮放 `extra` 的最右侧。
- 批量按钮放新增按钮左侧。
- 表格设置 `scroll={{ x: ... }}`。
- 操作列设置 `fixed: "right"`、`className: "table-action-column"`。

## Host 注册规则

只有用户明确要求把模块加入当前后台时，才使用 `--register-host`。注册后检查：

- `apps/ky-admin-host/package.json` 增加插件依赖。
- `apps/ky-admin-host/src/local-plugin-manifest.ts` 增加 import。
- `localPlugins` 数组包含新插件。
- admin host typecheck 前需要先 build 新插件依赖。
