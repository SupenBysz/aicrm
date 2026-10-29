# 2026-10-29 外部贡献准生产发布

用户授权：立即部署。目标为唯一准生产测试环境 `console.kysion.com` / `kycrm-staging`。

## 本轮范围

- 复用贡献 PR #6—#9 的原提交，合入版权配置、组织统计、机构品牌及默认关闭的域名基础代码。
- 修复统计权限并集与故障分层，按秒秀原项目恢复通用品牌/统计交互。
- 机构列表顺序：机构、域名、动态统计、所属用户、联系人、状态、创建时间、创建人、操作。
- 域名入口、托管接入、自动化就绪及源站隔离声明均保持 0；不部署 Executor/Worker/Gateway，不修改 CF、DNS 或 NS。
- 新品牌的查看、修改、发布三项权限仅增量授予既有平台超级管理员；其他角色不自动授权。本轮不授予域名权限，管理与激活均不开放。

## 发布前基线

- 发布前源码 main：`efa0ae667187d249e0c7d2f8f85019b805651a97`。
- 发布前 deploy/staging：`3a787e68747fb9b90f138f255886febff75746de`，Argo Synced/Healthy，六个应用 Deployment 均 1/1。
- 已保存六组件镜像与配置回滚基线；已创建独立发布前备份 Job，完成结果在运行验收记录中补充。
- 迁移 100—104 已通过独立测试库新装、99 基线升级及重复运行验证；已完成相关 Go、前端类型/构建及部分本地浏览器验证。
- Executor 的完整 Linux 测试、真实 CF 及完整跨入口验收不在本次启用范围，不能将默认关闭代码发布称为域名功能已上线。

## 执行状态

已发布并完成线上只读业务验收。运行版本与下方发布标识对应；后续仅文档/部署初始化 SQL 归档提交不代表重新构建。

## 回滚

保留上一 deploy/staging 提交与镜像 digest，应用异常时回退该运行清单并手动同步 Argo；保留新增表、列和审计，不自动降级数据库。若出现已启用机构入口，禁止用无隔离二进制回滚；本轮未启用此类入口。

## 发布过程补充

原始发布前备份 Job 两次连接数据库被拒绝，数据库本身保持就绪，尚未执行任何迁移。加入连接就绪检查后的 `kycrm-pre-release-20261029-iteration-v2` 已完成，备份文件 `kycrm-20261029T061932Z.dump`。备份 CronJob 与迁移镜像入口同步加入有界就绪等待，仅等待连接、不自动重放 SQL。

## 发布完成记录

- Gitea 原贡献 PR #6、#7、#8、#9 均通过正式合并保留贡献历史；修复与交互对齐 PR #10 已合并。
- 运行源码：`88ba73d23a54833d97e00d3d2f5b8c347f5ccd4e`。
- GitHub 集中构建：[40828986965](https://github.com/SupenBysz/kysion-build/actions/runs/40828986965)，成功；七个组件产物均由同一源码构建。
- 运行清单：`deploy/staging` 的 `db714bc06f0449b004e6d5a647d8dcca2cfab957`。所有六个 Deployment 镜像逐一与产物 digest 比对通过。
- 产物 ID：`12877643754`；压缩包 SHA256：`18099273803302dcb01daa1f81771b5aa5c7ab76c2009bf2070b9e06ebc8a588`。
- 备份：`kycrm-20261029T061932Z.dump`，565444 字节；SHA256 `b24f0723fca61958a5cd6a4e1bcc0b8a270b74bd4d04c4115084f90eb173dc2f`。本地卷内备份，不能视为异地灾备。
- 迁移 Job：`kycrm-migrate-88ba73d23a54` Complete；版本 100—104 完成，迁移台账 70 条、最大版本 104，全部文件名与 SHA256 对照当前源码通过。
- 受保护的系统角色未取消保护；通过可审计、幂等、增量部署 SQL 初始化品牌三权限，保留既有权限和数据范围，不冒充用户修改角色。
- 六个应用 Deployment（web/auth/org/membership/matrix/ai）均 1/1 available，新 Pod 无重启。Argo `Synced / Healthy`，自动同步仍关闭。
- 清除了旧版本无 Pod 引用的生成式代理 ConfigMap，以消除唯一的残留资源差异。

### 线上验收

- 登录、bootstrap、角色、权限、机构、企业、基础信息、矩阵账号、AI 模型接口通过；服务健康全部 healthy。测试会话已退出并验证失效。
- 内部路径和未知 API 保持 404；未部署 Executor 接口保持 503。
- 既有机构统计查询成功；机构品牌读取 200，未知草稿素材 404，未写入机构品牌或新增验收业务数据。
- 公共入口返回 `institution: false`，未开放机构域名入口。
- 直接打开线上 `console.kysion.com` 浏览器验收，已显示“机构 → 域名 → 动态统计 → 所属用户 → 联系人 → 状态 → 创建时间 → 创建人 → 操作”；“品牌”按钮可见，品牌侧滑窗可正常打开，顶部保存草稿/回滚/发布及图片预览、版权预览均存在。
- 本轮线上只读验收未执行真实机构的上传、发布、回滚，以免改变现有配置；这些写入交互此前在隔离本地测试环境验证。完整 Linux Executor、真实 CF/DNS 与跨域名入口验收尚未执行。

### 未启用项

域名内部调用要求 HTTPS 或回环地址，而当前服务发现使用 ClusterIP HTTP；对应适配未完成，因此不授予域名查看、管理、激活权限。域名列当前显示“—”，不代表域名接入已经完成。Worker/Gateway/Executor 均未部署，未改动 CF/DNS/NS 或其他业务。

### 七组件不可变镜像

- ai: `ghcr.io/supenbysz/kycrm-ai@sha256:a867c380d9e39a0df000b823ff31bcdea91707059bccaf2bc831a74d9c5ff498`
- auth: `ghcr.io/supenbysz/kycrm-auth@sha256:58cf9a30dcedb57f51d74a26659fd996e7400f5d4c3780d5753a009a27d221cb`
- matrix: `ghcr.io/supenbysz/kycrm-matrix@sha256:e19675dca04278a76daca8f3a8bd11829b2f29f72e6fae8a17db1c28253d2fae`
- membership: `ghcr.io/supenbysz/kycrm-membership@sha256:0f505573dbeec630945ee028ada5e3938f189c2ef298dcb2110b3e7219cc9787`
- migrate: `ghcr.io/supenbysz/kycrm-migrate@sha256:c769a47db1615281f03bea304c8a27c789a57b970c4a7044d6164e393fd5828f`
- org: `ghcr.io/supenbysz/kycrm-org@sha256:43e768ae0c24137bf329b53f037bfa06c507446ea3bbcedd23a2c129d933f196`
- web: `ghcr.io/supenbysz/kycrm-web@sha256:b9d7a80a356e8e078ff1954a62fb85bc0a322c83ce417ffd0987da65213bd80c`
