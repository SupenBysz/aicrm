# 2026-10-29 多配色主题与个人偏好发布

目标：`https://console.kysion.com` / `kycrm-staging`。用户授权立即部署，并补充修复桌面窗口按钮下方分隔线断开。

## 来源与运行版本

- 源码提交 `43f3a2e201c6c11b3f6cccf24f872709f5c818a3`，包含主题主体 `5f1972a` 和窗口分隔线修复 `43f3a2e`，均已推送 Gitea main。
- [集中构建 40868436858](https://github.com/SupenBysz/kysion-build/actions/runs/40868436858) 成功。构建仓库提交 `2a528f67c09209d1ca89836bebbc9bccc0a4ed58`；与此前审核版本的差异仅为其他项目文件，KyCRM 工作流和取源码脚本逐文件无变化。
- 产物 ID `12894832231`，SHA256 `4e6f0695ed380bb0e2b819e099ac1919cd46114609398ae98cc2df17ae6f3cfc`；七镜像摘要、OCI源码标识及源码仓库标签逐项通过校验。
- 运行清单 `85223012ce3e2573998d0844c0e2013406c545aa` 已推送 deploy/staging，并手动同步 Argo；自动同步保持关闭。

## 备份与迁移

- 变更前 Argo Synced/Healthy，六服务1/1；回滚清单 `0259fe2828c30647fba6ce0a490ac95fc4815d21`。
- 备份Job `kycrm-before-appearance-20261029` Complete。文件 `kycrm-20261029T114808Z.dump`，677185字节，SHA256 `ffc160cb4ed8e208cf306af9db54bbe732cd874a58b80713df47ba6297b6e7b3`。
- 独立Job `kycrm-appearance-backup-verify` 回读校验和、文件大小、pg_restore列表均通过。本地卷备份不等于异地灾备，本次没有再执行完整还原演练。
- 迁移Job `kycrm-migrate-43f3a2e201c6` Complete，新增106：本人外观、平台默认、平台外观变更表与独立权限。
- 发布前71条、发布后72条迁移台账与源码文件名/校验和完全一致；新表DML及序列运行权限核验通过，未手动扩大运行角色DDL权限。

## 已核验

- 六个Deployment均只有1个新副本且1/1可用，运行镜像与发布产物逐项一致；Argo Synced/Healthy，无残留OutOfSync资源。
- 更新前后认证API冒烟通过：登录、bootstrap、各业务读取、服务健康、外部内部接口隔离、Executor预期503；测试会话均注销并确认失效。
- 新主题接口：未登录本人读取401；公共默认、本人读取、平台默认读取200；新权限目录可见。本次不修改真实用户外观或平台默认。
- 公网JS `/assets/index-2ae-zM17.js`、CSS `/assets/index-CshiaHky.css` 已核验个人偏好、平台外观权限及窗口按钮兼容样式。
- Edge新标签实际打开系统配置，确认平台默认表单、三套配色与亮暗预览；用户菜单能打开个人偏好侧滑，旧版本机外观明确标为尚未设为账号偏好。截图确认标题位于主Header下方，原有品牌编辑标签未刷新或修改。
- 本地隔离客户端实际刷新后，暗色窗口按钮下的分隔线连续到右侧；原因为等高按钮浮层背景模糊覆盖Header底边，已预留1px并移除集成区模糊。宿主兼容样式随Web部署，旧客户端加载新页面即可消费。
- Desktop源码类型检查与构建通过；本次未分发新客户端安装包，不能据此声称已安装客户端的原生背景桥接已升级。

## 验收边界

- 本次没有在准生产执行真实账号主题写入、断网／延迟写入、跨窗口冲突或业务WebView登录、历史、滚动保持全流程。
- 线上浏览器第一次带外观深链接进入时，旧缓存权限尚未刷新曾回退基础信息；权限刷新后外观页签正常可进入。此首次权限缓存时序不计为深链接完整验收通过，后续跟进 [ops-log #75](https://gitea.jditco.ltd/kysion/ops-log/issues/75)。
- 兼容性测试与本地基础UI结果详见 `docs/appearance-theme/实施与验证记录.md`，不等同全部业务页和所有窗口尺寸验收。

## 回滚

回到旧运行清单 `0259fe2828c30647fba6ce0a490ac95fc4815d21` 并手动同步Argo。新增106表及记录保留，不删表、不自动降级数据库；数据库破坏性恢复须另行处理新增数据并获得授权。

运维记录按 K3s 工作空间规范留痕：[ops-log #74](https://gitea.jditco.ltd/kysion/ops-log/issues/74)。

## 镜像

- web: `ghcr.io/supenbysz/kycrm-web@sha256:bc654b7d6224eee613ca81ee96516d5fc6ed5949ab4a08e4680970fdc5ecf1d0`
- auth: `ghcr.io/supenbysz/kycrm-auth@sha256:423eba05562551333982e65c54cea06cb2b63e607da8f9de968256c6dc61a232`
- org: `ghcr.io/supenbysz/kycrm-org@sha256:daeb7872cb466e8064ff9f77bc3eebe77f59e5d4a27eef7047b8d56fcaf1a602`
- membership: `ghcr.io/supenbysz/kycrm-membership@sha256:df04f0f56e2a8738590413a84956da8024e3e5867bb0c565342e0ecd230b927d`
- matrix: `ghcr.io/supenbysz/kycrm-matrix@sha256:7d62a174b7ba0789c8a6e4500bb570c4c181889f78069b0b81c6912668149bb6`
- ai: `ghcr.io/supenbysz/kycrm-ai@sha256:b6d7b2c0c82faf48cb3452d7eb60bbba7dcfe0c0adedd5a4f8ccdcfabb96e018`
- migrate: `ghcr.io/supenbysz/kycrm-migrate@sha256:5264436dc51235715ce43250d70f570741551f6088ed562f35980413a126118b`
