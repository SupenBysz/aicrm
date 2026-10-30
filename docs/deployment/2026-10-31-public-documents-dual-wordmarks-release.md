# 2026-10-31 协议文档、亮暗文字 LOGO 与主题缩略预览发布

用户授权立即部署至 console.kysion.com / kycrm-staging。

## 已发布主批次

- Gitea PR #26，源码 `2a0483157622351dc01423f110cb42eacb333cfb`；GitHub 集中构建 `41121555513` 全部成功，构建仓库源码 `44e0a228e7eb2e536d857aca361f7f7e2e3430c7`，工作流与源码拉取脚本对照已审查版本一致。
- 发布归档 `13009231468`，SHA256 `32121b13adfb30786ea80ff3b4a2943dc3f4e86ab1eed4178e054419fe5dce71`；待发布镜像清单、配置摘要及来源标签已核验。
- GitOps `e6b58d15232cde37cc06f9f0980a6c98430997da`，更新 Web/Auth/Org/Membership，Matrix/AI 保持原镜像。Argo Synced / Healthy / Succeeded，六个部署全部就绪。
- 新增平台系统配置“协议与文档”、公开阅读入口；平台/机构独立亮暗文字 Logo；主题选择改为亮暗 Logo 缩略预览，AI 使用对应主题色。

## 备份、迁移与权限

- 备份 `/backups/kycrm-20261030T201350Z.dump`，709808 bytes，SHA256 `587fdc7b7e389a0d2e16fef8743375dc0a36242546da2c80d438bc990a5f7488`。独立只读 Job 校验摘要与 pg_restore 归档目录通过；未执行实际恢复，不代表异地灾备。
- 迁移 Job `kycrm-migrate-2a0483157622` 成功；113 checksum `190c626857e4ce06e7e3efc103d831ada728d1f3418758b17f6c106359c82079`。112 为其他未合并迭代预留，本批不补写该迁移。
- 7 项文档权限及保护的平台 owner 授权核验通过。运行角色对文档版本仅 SELECT/INSERT，UPDATE/DELETE 为 false。
- 首个权限 Job 在 PostgreSQL 首次网络就绪前连接被拒，未执行 SQL；增加仅连接就绪重试后以 v2 Job 成功，SQL 事务仅执行一次。
- 删除了已经没有 Pod 引用的旧代理 ConfigMap，未执行全量 prune。

## 验收与边界

- 通用登录/bootstrap/角色/权限/业务列表/服务健康/logout 回归通过，测试会话已注销，Executor 仍按预期 503 禁用。
- 登录后的文档列表、两类入口绑定及平台暗色素材字段读取通过；公开链接无登录可读（当前空列表），不存在文档返回 404，后台文档 API 匿名访问返回 401，公开阅读页面可加载。
- 浏览器线上个人偏好中四套主题均为亮暗两组 Kysion + AI 缩略图，已不再显示 Aa。未改变业务品牌配置，未创建或发布任何真实协议。
- 暗色自定义图片尚未上传的旧配置使用品牌文字回退；线上视觉核验发现后缀空间不足，PR #27 增加 fitText，进入仅 Web 的后续修复批次。
- 回退应使用上一 GitOps 完整运行清单；新增表及文档数据保留，禁止仅为镜像回退删除113或已发布文档版本。若需数据恢复，必须单独批准并处理备份后的新增数据。

## 主批次镜像

- web: `ghcr.io/supenbysz/kycrm-web@sha256:c1789ed2e78198ebe4141c2295194eece314ca229ca8ab0ffc7cfbf4f04c3925`
- auth: `ghcr.io/supenbysz/kycrm-auth@sha256:d940cf113c5818c24f7dd0a0f20165d7b03013814752168d1316ee5b45f375a3`
- org: `ghcr.io/supenbysz/kycrm-org@sha256:527ae8590ac751bd3e7b1a4735d78eef916652862fa5169dbcbd6023934129c9`
- membership: `ghcr.io/supenbysz/kycrm-membership@sha256:f792291f9f820fe373aa206dd3fc17a1af6f0bfcb4dacd6febf48a7f2cb82317`
- migrate: `ghcr.io/supenbysz/kycrm-migrate@sha256:fd417909e0c850d389e5159e117a5b043b76b1cb87cc3ed5a4588dc3bbcc4177`

## 仅 Web 的兼容修复批次

- PR #27，源码 `d9b632c79f1947ce8912724fb12fe8e6e63d1427`，集中构建 `41123581278` 全部成功；归档 `13009362781`，SHA256 `f7ac8ce41eb0cf983bb28c96f2a0a5badd75e454f0e55a0f5f43984f12089ff2`。
- 导航品牌启用共享 `fitText`，仅对无图片的文字回退按容器可用宽度计算文字与 AI 后缀总宽度。图片模式保持原有缩放行为。
- 本批次没有执行数据库迁移，只更新 Web；其余服务保持主批次的已验收镜像。
- GitOps: `d1aa14a248b95fd72642e1563376d69112100db4`。
- Web: `ghcr.io/supenbysz/kycrm-web@sha256:3233aee072404405412aa23cedcafb7993fbb49e8cd06f9adf520857ea8e1b25`。
- 最终核验：Argo Synced / Healthy；六个部署就绪，只有 Web 在修复批次改变摘要；通用认证/API 和文档只读回归通过。浏览器刷新后顶部 Kysion + AI 完整显示，主题缩略图已为新版。
