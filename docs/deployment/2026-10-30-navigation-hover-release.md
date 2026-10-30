# 2026-10-30 导航菜单悬停反馈发布

用户授权立即部署，目标console.kysion.com / kycrm-staging，仅晋级Web。

- 修复提交0a976fd，PR #19普通合并，源码41204491f97efa2043ba3a947c1fde926bcc2949。
- 集中构建41007783623，构建源323d19144f022f6ab4a518730971864d0fd56a21；工作流及源码拉取脚本与已审查版本一致。
- 发布前运行清单1a5e325aa84d823ce730f41fbbf559a91b72f7ce，Argo Synced/Healthy，自动同步关闭。
- 复用admin-accent-soft/admin-accent，为未选中、非禁用菜单项和非禁用分组标题提供65%浅主题色混合背景及150ms过渡，保留已选中背景。跟随现有主题和亮暗模式。
- Host生产构建、diff检查通过。无数据库迁移、菜单/权限/后端变更，不发布安装客户端。
- 回退使用上个运行清单Web摘要；无数据变更，不需要数据库还原。

## 发布结果

- 集中构建41007783623全部成功；归档12955844620，SHA-256 `d7b8c042749d59d8abd88e0cc53f04830db52cd1a232a9a4a7de06b15d8b8b8e`。镜像校验一次TLS EOF中断后只读重试成功，Web manifest/config摘要、平台及源码标签均匹配。
- Web镜像`ghcr.io/supenbysz/kycrm-web@sha256:5f42b3e7bbba126d2ef6c07a08bd64542ac984842a111c62fce23172296e300e`。
- 运行清单`a0a87bf24fbd650921e1bf14cb02dc0cad606d39`，Argo Synced/Healthy/Succeeded，自动同步仍关闭；六个Deployment就绪，其他五服务镜像和generation均保持基线。
- 线上主CSS `/assets/main-CpbkOzmC.css`已确认包含菜单/分组悬停背景、主题变量、选中/禁用排除及150ms过渡；检查脚本最初误要求CSS逗号后无空格，按实际合法CSS空白修正后通过，没有改产品来迎合断言。
- 组件中心静态资源、安全策略、24份源码一致性，以及真实账号菜单/bootstrap/权限和通用API烟测通过，测试会话已注销，Executor保持503未启用。
- 本轮验证了线上CSS及运行状态，未进行真实鼠标悬停的截图验收或安装客户端验收。刷新旧页面加载新Host即可。
