# 完整业务模块脚手架

## 创建命令

完整业务模块使用：

```bash
scripts/create_business_module.sh \
  --slug customer-management \
  --title 客户管理 \
  --fields "customerNo:string:客户编号,level:string:客户等级,amount:number:成交金额" \
  --workspace-types enterprise \
  --nav-group CRM \
  --route-path /customers \
  --api-base /api/v1/customers \
  --http-port 18101
```

## 参数说明

| 参数 | 含义 | 默认值 |
| --- | --- | --- |
| `--slug` | 业务模块 slug，小写短横线 | 必填 |
| `--title` | 菜单、页面和服务中文标题 | 必填 |
| `--fields` | 字段规格，逗号分隔 `field:type:label` | `remark:text:备注` |
| `--workspace-types` | 工作区类型，逗号分隔 | `platform` |
| `--nav-group` | 前端导航分组 | 默认等于 title |
| `--nav-order` | 前端导航排序 | `80` |
| `--route-path` | 前端页面路由 | `/<slug>` |
| `--icon` | Ant Design 图标名称 | `AppstoreOutlined` |
| `--api-base` | 后端 API 基础路径 | `/api/v1/<slug>` |
| `--service-name` | Go 服务名 | `ky-<slug>-service` |
| `--http-port` | 服务本地端口 | `18100` |
| `--table-name` | 数据表名 | `ky_<slug 下划线>` |
| `--permission-resource` | 权限资源名 | `<slug 下划线>` |
| `--skip-register-host` | 不注册 admin host | 默认注册 |
| `--skip-register-service` | 不注册 go.work / 服务脚本 / systemd | 默认注册 |
| `--skip-register-nginx` | 不注册 Nginx API 代理 | 默认注册 |
| `--dry-run` | 只预览计划 | 默认写文件 |

字段类型支持：`string`、`text`、`int`、`number`、`bool`。

## 生成内容

脚本会生成或修改：

```text
plugins/ky-<slug>/                         前端后台插件
services/ky-<slug>-service/                独立 Go 业务服务
ops/db/<next>_<resource>_business_module.sql
ops/native/ky-<slug>-service.service
ops/native/external-dependencies.env.example
ops/native/ky-admin-host.nginx.conf
go.work
scripts/build_services.sh
scripts/deploy_services.sh
apps/ky-admin-host/package.json
apps/ky-admin-host/src/local-plugin-manifest.ts
```

前端插件包含列表页、抽屉表单、状态胶囊筛选、批量启停、右侧冻结操作列和 API client。

Go 服务包含：

- `GET /readyz`、`GET /healthz`。
- `GET/POST <api-base>`。
- `GET/PATCH/DELETE <api-base>/{id}`。
- `PATCH <api-base>/{id}/status`。
- Token、会话、工作区身份和权限校验骨架。

SQL 包含：

- 业务表。
- 工作区、状态、更新时间索引。
- `menu.<workspace>.<resource>` 菜单权限。
- `<workspace>.<resource>.view/create/update/update_status/delete` 权限。
- 内置 owner/admin 角色授权。

## 生成后要求

- 新服务端口必须避免和已有服务冲突。
- `--workspace-types` 必须与业务真实可见范围一致。
- 生成 SQL 是模板起点，复杂唯一约束、数据范围和审计字段需要按业务继续细化。
- 新服务默认使用同一个租户库和 `KY_AUTH_TOKEN_SECRET`，不要额外引入独立认证。
- admin host typecheck 前先 build `@ky/admin-core` 和新插件。
