# 准生产测试环境

更新时间：2026-10-29（Asia/Shanghai）。本文件描述部署合同，实时验收以发布记录为准。

- 唯一环境：`kycrm-staging`，入口 `https://console.kysion.com`。无独立正式生产环境。
- 源码事实源为 Gitea `kysion/kycrm`；GitHub `SupenBysz/kysion-build` 只管理集中构建工作流。
- 首期 Web、auth、org、membership、matrix、ai；Executor 延后，相关请求明确返回 503。
- 七个镜像（含迁移镜像）发布到私有 GHCR，运行清单必须固定 digest，禁止部署 UNRELEASED/latest。
- 首次发布手动执行；首次业务验收前不配置自动同步或自动触发。

## 构建

`ops/container` 包含 Web、普通服务与迁移容器。Node/Go/Nginx/Postgres 基础镜像固定摘要；Go服务以非root身份运行。源码上下文通过 `.dockerignore` 排除凭据和本地产物。编译器、pnpm锁文件、Go模块和Codex协议校验均不得绕过。

集中构建的输入只接受当前 Gitea main 的完整提交SHA；工作流及Actions固定审核版本。构建与镜像发布分Job，不让源码构建脚本读取镜像发布身份或集群凭据。PR不触发发布。

## 资源与配置

`ops/k3s/infrastructure` 是运维管理的基础设施，不纳入应用自动prune；数据库和备份PVC不得通过应用回滚删除。

`ops/k3s/overlays/staging` 为运行清单；批准镜像摘要写入专用 `deploy/staging` 分支。Argo AppProject只接受本项目仓库、目标命名空间和允许的应用资源类型，初次不启用自动同步。

Secret在带外配置，不提交YAML明文：

| Secret | 用途 |
|---|---|
| ghcr-read | 只读镜像拉取凭据，记录到期日并提前轮换 |
| kycrm-database-admin | 独立PostgreSQL实例引导，仅数据库运维使用 |
| kycrm-migrator | 数据库所有者迁移连接；不注入应用Pod |
| kycrm-runtime | 运行连接、JWT签名、内部服务认证及稳定设置加密密钥 |

普通服务显式监听Pod接口，服务间使用ClusterIP DNS。公网仅进入Web代理；内部API及未知API路径返回404。Caddy终止TLS，Web代理向服务声明HTTPS原始协议；此配置仅适用于当前受控入口。

## 数据库

新建独立 PostgreSQL 实例及空库，不连接其他项目数据库。迁移角色持DDL权限，运行角色只有业务表DML和序列权限，不拥有数据库、schema、表，也不能修改迁移账本。首期保持既有服务共享schema合同，不宣称已完成按服务私表拆权。

迁移Job以发布SHA唯一命名，backoffLimit=0。沿用 `scripts/deploy_database.sh` 的完整迁移列表、SHA256账本及advisory lock；失败停止发布，不自动重试破坏性步骤。开发密码脚本不用于上线，初始管理员使用带外生成的独立随机密码。

数据库单副本和local-path不是HA。数据PV设Retain，数据库定时逻辑备份保留于独立PVC；该PVC仍为节点本地存储。验收必须包含一次新库恢复演练；异机/异地备份未完成时应作为明确限制记录，不能把本地双PVC称为灾备。

## 验收与回滚

检查迁移账本、探针、登录/bootstrap/logout、工作区/角色权限、菜单/系统设置、持久化重启、内部接口隔离及原站点回归。Executor及真实短信/邮件/第三方付费调用不属于本批验收。

回滚记录上一版完整镜像摘要和配置Git提交，回退deploy分支后由Argo同步。DDL不随镜像回滚；不兼容迁移应阻断，恢复备份前处理新增数据并单独批准破坏性恢复。首次验收未完成时自动发布保持关闭。
