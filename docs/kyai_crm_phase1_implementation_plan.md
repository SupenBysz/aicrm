# KyaiCRM 第一阶段实施计划

> 文档状态：已锁定 / Phase 1 基线  
> 项目名称：KyaiCRM  
> 当前阶段：第一阶段 / 多租户用户中心与多后台身份底座  
> 编写日期：2026-06-15  
> 参照项目：`/data/Kysion/zhipinai_v2`  
> 关联文档：
> - `docs/kyai_crm_multi_tenant_identity_requirements.md`
> - `docs/kyai_crm_technical_selection.md`
> - `docs/kyai_crm_architecture.md`
> - `docs/kyai_crm_data_model.md`
> - `docs/kyai_crm_permission_matrix.md`

---

## 1. 文档目的

本文档用于规划 KyaiCRM 第一阶段的实施路径。

第一阶段目标不是建设 CRM 业务，而是建设一个可复用的多租户用户中心与多后台身份底座。该底座需要严格复用 zhipinai_v2 的架构、代码组织、权限模式、表设计思路和部署方式。

---

## 2. 第一阶段总体目标

第一阶段完成后，系统应具备：

1. 新项目工程骨架。
2. 后台 Host + Plugin 架构。
3. 用户注册、登录、bootstrap。
4. 平台、机构、企业后台入口。
5. 后台身份选择与切换。
6. 平台、机构、企业、部门、团队基础管理。
7. 成员与邀请。
8. 角色、权限、数据范围。
9. 通知与审计。
10. 系统设置。
11. AI 供应商与模型配置。
12. Nginx + systemd 原生部署。
13. 基础验收脚本。

明确不做：

- CRM 业务。
- 移动端。
- IM。
- AI 员工。
- AI 执行器。
- AI 协作。
- AI 人才市场。

---

## 3. 实施原则

1. **先骨架，后页面，最后完善操作。**
2. **先复用参照项目，再做 KyaiCRM 差异扩展。**
3. **先跑通登录、bootstrap、工作区切换。**
4. **所有页面和接口都必须绑定 workspace。**
5. **前端权限只做体验，后端权限才是安全边界。**
6. **第一阶段服务数量保持可控。**
7. **AI 只做配置层。**
8. **每个阶段必须有可验证结果。**

---

## 4. 推荐实施阶段

```text
Phase 1.1 项目初始化
Phase 1.2 后台 Host 和 Core
Phase 1.3 数据库 schema 与 seed
Phase 1.4 Auth / Bootstrap
Phase 1.5 组织主体管理
Phase 1.6 成员与邀请
Phase 1.7 权限中心与数据范围
Phase 1.8 通知与审计
Phase 1.9 AI 配置
Phase 1.10 部署与验收
```

---

## 5. Phase 1.1 项目初始化

### 5.1 目标

创建 KyaiCRM 项目基础目录和工作区配置。

### 5.2 目录结构

```text
KyaiCRM/
├── apps/
│   └── ky-admin-host/
├── packages/
│   └── ky-admin-core/
├── plugins/
│   ├── ky-identity-management/
│   ├── ky-organization-management/
│   ├── ky-access-management/
│   ├── ky-audit-management/
│   ├── ky-notification/
│   ├── ky-system-settings/
│   └── ky-ai-configuration/
├── services/
│   ├── ky-auth-service/
│   ├── ky-org-service/
│   ├── ky-membership-service/
│   └── ky-ai-model-service/
├── ops/
│   ├── db/
│   ├── native/
│   └── seed/
├── scripts/
├── docs/
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── go.work
└── README.md
```

### 5.3 工作内容

- 初始化根 `package.json`。
- 初始化 `pnpm-workspace.yaml`。
- 初始化 `turbo.json`。
- 初始化 `go.work`。
- 建立 apps / packages / plugins / services / ops / scripts / docs。
- 统一 `ky-*` 命名。
- 统一 `KY_*` 环境变量前缀。
- 迁移或复制当前 docs 文档到新项目 docs。

### 5.4 验收标准

- `pnpm install` 可执行。
- `pnpm lint`、`pnpm typecheck` 脚本存在。
- `go work` 可识别服务目录。
- 目录结构符合文档。

---

## 6. Phase 1.2 后台 Host 和 Core

### 6.1 目标

搭建后台壳层和插件协议。

### 6.2 工作内容

#### ky-admin-core

实现或复用：

- 插件类型。
- 菜单类型。
- 路由类型。
- 权限上下文。
- 工作区上下文。
- request client 类型。
- plugin registry。
- breadcrumb 类型。
- workbench contribution 类型。
- header action 类型。
- query namespace 类型。

#### ky-admin-host

实现或复用：

- React + Vite 项目。
- Ant Design 主布局。
- 登录页。
- 注册页。
- 邀请页。
- 后台身份选择页。
- `/403` 页面。
- `/w/:workspaceType/:workspaceId` 路由框架。
- workspace switcher。
- menu builder。
- route guard。
- plugin loader。
- request client。
- session store，key 为 `ky.admin.session.v1`。

### 6.3 验收标准

- 本地可启动后台。
- 未登录进入登录页。
- mock bootstrap 可展示后台身份选择。
- 可进入 mock 平台 / 机构 / 企业工作台。
- 插件可贡献菜单和路由。
- 无权限路由进入 `/403`。

---

## 7. Phase 1.3 数据库 schema 与 seed

### 7.1 目标

建立第一阶段数据库结构和初始数据。

### 7.2 SQL 文件建议

```text
ops/db/001_identity_schema.sql
ops/db/002_organization_schema.sql
ops/db/003_membership_schema.sql
ops/db/004_access_schema.sql
ops/db/005_audit_notification_schema.sql
ops/db/006_system_setting_schema.sql
ops/db/007_ai_model_schema.sql
ops/db/008_seed.sql
```

### 7.3 工作内容

建表：

- `ky_user`
- `ky_user_credential`
- `ky_user_session`
- `ky_login_log`
- `ky_agency`
- `ky_enterprise`
- `ky_agency_enterprise_relation`
- `ky_department`
- `ky_team`
- `ky_membership`
- `ky_membership_department`
- `ky_membership_team`
- `ky_invitation`
- `ky_role`
- `ky_permission`
- `ky_role_permission`
- `ky_membership_role`
- `ky_role_data_scope`
- `ky_audit_log`
- `ky_notification`
- `ky_notification_read`
- `ky_system_announcement`
- `ky_system_setting`
- `ky_dictionary`
- `ky_dictionary_item`
- `ky_ai_provider`
- `ky_ai_model`
- `ky_ai_model_setting`

初始化：

- platform_root。
- 平台超级管理员。
- 平台 membership。
- 平台、机构、企业内置角色。
- 菜单权限、页面权限、操作权限。
- 默认系统设置。

### 7.4 验收标准

- 空库可执行 schema。
- seed 后存在平台超级管理员。
- seed 后存在 platform_root。
- seed 后存在基础权限点。
- seed 后可支持 bootstrap 查询。

---

## 8. Phase 1.4 Auth / Bootstrap

### 8.1 目标

实现认证、登录、bootstrap 和多后台身份返回。

### 8.2 服务

```text
ky-auth-service
```

### 8.3 工作内容

接口：

```text
POST /api/v1/auth/login
POST /api/v1/auth/logout
POST /api/v1/auth/register
GET  /api/v1/auth/me
GET  /api/v1/auth/bootstrap
```

Bootstrap 返回：

- user。
- workspaces。
- workspace type。
- workspace id。
- membership id。
- roles。
- permissions。
- actionPermissions。
- menuKeys。
- data scope。

### 8.4 前端联调

- 登录成功保存 session。
- 调用 bootstrap。
- 无身份进入无身份页。
- 单身份直接进入工作台。
- 多身份进入身份选择页。
- 切换身份刷新菜单和权限。

### 8.5 验收标准

- 平台管理员可登录。
- bootstrap 返回平台身份。
- 同一用户可返回多个身份。
- 前端可选择不同身份进入。
- workspace header 正确注入。

---

## 9. Phase 1.5 组织主体管理

### 9.1 目标

实现平台、机构、企业、部门、团队基础管理。

### 9.2 服务

```text
ky-org-service
```

### 9.3 前端插件

```text
plugins/ky-organization-management
```

### 9.4 工作内容

平台后台：

- 机构列表。
- 创建机构。
- 机构详情。
- 机构状态管理。
- 企业列表。
- 创建企业。
- 企业详情。
- 企业归属机构。

机构后台：

- 机构信息。
- 机构部门。
- 机构团队。
- 服务企业。

企业后台：

- 企业信息。
- 企业部门。
- 企业团队。

### 9.5 验收标准

- 平台管理员可创建机构和企业。
- 企业可直属平台。
- 企业可归属机构。
- 机构后台只能看到本机构。
- 企业后台只能看到本企业。
- 部门支持树形结构。
- 团队支持跨部门成员。

---

## 10. Phase 1.6 成员与邀请

### 10.1 目标

实现成员管理和邀请机制。

### 10.2 服务

```text
ky-membership-service
```

### 10.3 前端插件

```text
plugins/ky-identity-management
plugins/ky-organization-management
```

### 10.4 工作内容

成员管理：

- 平台成员。
- 机构成员。
- 企业成员。
- 成员详情。
- 成员状态。
- 成员部门。
- 成员团队。

邀请：

- 邀请平台成员。
- 邀请机构成员。
- 邀请企业成员。
- 接受邀请。
- 邀请过期。
- 邀请取消。

### 10.5 验收标准

- 管理员可邀请成员。
- 被邀请用户可接受邀请。
- 接受邀请后生成 membership。
- 成员可分配部门和团队。
- 禁用成员后无法进入对应后台。
- 用户账号状态和成员状态互不混淆。

---

## 11. Phase 1.7 权限中心与数据范围

### 11.1 目标

实现角色、权限、成员授权、数据范围。

### 11.2 服务

```text
ky-membership-service
```

### 11.3 前端插件

```text
plugins/ky-access-management
```

### 11.4 工作内容

- 权限列表。
- 角色列表。
- 创建角色。
- 编辑角色。
- 角色分配权限。
- 成员分配角色。
- 数据范围配置。
- menuKeys 计算。
- permissions 计算。
- actionPermissions 计算。

### 11.5 验收标准

- 不同角色看到不同菜单。
- 无页面权限进入 `/403`。
- 无操作权限按钮不显示。
- 直接调用无权限接口被拒绝。
- 工作区切换后权限重新计算。
- 部门负责人只能看到部门范围。
- 团队负责人只能看到团队范围。

---

## 12. Phase 1.8 通知与审计

### 12.1 目标

实现操作审计和通知中心。

### 12.2 服务

第一阶段可放在：

```text
ky-membership-service
```

后续可拆为：

```text
ky-notification-service
```

### 12.3 前端插件

```text
plugins/ky-audit-management
plugins/ky-notification
```

### 12.4 工作内容

审计：

- 登录日志。
- 操作日志。
- 权限变更日志。
- 成员变更日志。
- AI 配置变更日志。

通知：

- 我的通知。
- 未读数。
- 全部已读。
- 系统公告。
- 平台 / 机构 / 企业通知。

### 12.5 验收标准

- 关键操作写入审计日志。
- 不同后台身份只能看授权范围日志。
- Header 显示未读数。
- 通知可标记已读。
- 发布系统公告后目标用户可见。

---

## 13. Phase 1.9 AI 配置

### 13.1 目标

实现 AI 供应商与模型配置，不引入 AI 业务模块。

### 13.2 服务

```text
ky-ai-model-service
```

### 13.3 前端插件

```text
plugins/ky-ai-configuration
```

### 13.4 工作内容

- AI 供应商列表。
- 新增供应商。
- 编辑供应商。
- 启停供应商。
- AI 模型列表。
- 新增模型。
- 编辑模型。
- 启停模型。
- 默认模型配置。
- AI 配置审计。

### 13.5 明确不做

- AI 员工。
- AI 执行器。
- AI 工作流。
- AI 协作。
- AI 对话页面。
- AI 人才市场。

### 13.6 验收标准

- 平台授权角色可管理供应商和模型。
- 只读角色只能查看。
- 非平台授权角色看不到或不能进入 AI 配置。
- 修改 AI 配置写入审计日志。

---

## 14. Phase 1.10 部署与验收

### 14.1 目标

完成原生 VM 部署和基础验收。

### 14.2 运维文件

```text
ops/native/external-dependencies.env.example
ops/native/ky-admin-host.nginx.conf
ops/native/ky-auth-service.service
ops/native/ky-org-service.service
ops/native/ky-membership-service.service
ops/native/ky-ai-model-service.service
```

### 14.3 部署脚本

```text
scripts/deploy_database.sh
scripts/deploy_services.sh
scripts/deploy_frontend.sh
scripts/verify_deployment.sh
scripts/seed_dev_data.sh
scripts/build_services.sh
scripts/build_frontend.sh
```

### 14.4 验收脚本覆盖

- 前端 healthz。
- 服务 readyz。
- 登录。
- Bootstrap。
- 工作区切换。
- 平台后台菜单。
- 机构后台菜单。
- 企业后台菜单。
- 权限拒绝。
- 机构 / 企业基础查询。
- 成员邀请。
- 通知未读数。
- AI 模型配置查询。

### 14.5 验收标准

- Nginx 可访问后台。
- 所有 systemd 服务正常运行。
- 所有 readyz 通过。
- 平台管理员可登录。
- 多身份用户可切换后台。
- 权限边界正确。
- 审计日志正常记录。

---

## 15. 关键里程碑

| 里程碑 | 结果 |
|---|---|
| M1 工程骨架 | 项目目录、pnpm、turbo、go.work 完成 |
| M2 后台壳层 | Host + Core + 插件注册跑通 |
| M3 数据库 | schema + seed 完成 |
| M4 登录与身份 | auth + bootstrap + workspace switch 完成 |
| M5 组织结构 | 平台 / 机构 / 企业 / 部门 / 团队完成 |
| M6 成员邀请 | membership + invitation 完成 |
| M7 权限中心 | 角色、权限、数据范围完成 |
| M8 通知审计 | audit + notification 完成 |
| M9 AI 配置 | provider + model 完成 |
| M10 部署验收 | Nginx + systemd + verify 完成 |

---

## 16. 实施风险

### 16.1 权限模型复杂

风险：平台、机构、企业、部门、团队范围容易混淆。

控制：

- 所有接口强制 workspace header。
- 所有查询明确 workspace scope。
- 权限矩阵先于页面开发确认。

### 16.2 复用参照项目时引入不需要的业务

风险：误引入 AI 员工、IM、招聘、移动端等模块。

控制：

- 只复用底座能力。
- AI 只保留供应商和模型配置。
- 不复制 AI agent、collab、executor、mobile 业务代码。

### 16.3 Host 职责膨胀

风险：业务页面写入 Host，破坏插件架构。

控制：

- Host 只负责登录、布局、workspace、权限和插件加载。
- 业务页面必须在 plugins 下。

### 16.4 服务拆分过细

风险：第一阶段服务过多导致部署复杂。

控制：

- 第一阶段控制在 4 个核心服务。
- 第一阶段不部署独立 `ky-notification-service`，通知先放在 membership service。

---

## 17. 第一阶段完成定义

第一阶段完成必须同时满足：

1. 文档齐全。
2. 工程骨架可运行。
3. 平台、机构、企业后台入口可用。
4. 用户可拥有多个后台身份。
5. 用户可切换后台身份。
6. 菜单、页面、操作权限正确。
7. 部门、团队可管理。
8. 成员邀请可用。
9. 审计日志可用。
10. 通知中心可用。
11. AI 供应商和模型配置可用。
12. 原生 VM 部署链路可用。
13. 验收脚本通过。

---

## 18. 下一步建议

完成本文档后，建议继续补充：

1. `docs/kyai_crm_admin_pages.md`：页面与菜单清单。
2. `docs/kyai_crm_api_contracts.md`：API 接口契约。
3. `docs/kyai_crm_workspace_layout.md`：项目目录与命名规范。
4. `docs/kyai_crm_deployment.md`：部署方案。

随后进入项目初始化和代码骨架创建。
