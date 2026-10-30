# 2026-10-30 组件预览主题同步发布

目标：console.kysion.com / kycrm-staging。用户明确授权立即部署。

- 修复提交9ca63e3，经PR #17普通合并，源码992b1b3f91f3c9b1e2331a0c4bf9c01ea75e52f4。
- 复用AppearanceContext、themeVariables、appearanceAntdTheme，默认跟随当前主题及实际亮暗，独立预览覆盖仍可使用。旧链接可点“跟随当前主题”恢复两项跟随。
- 集中构建41004821785，构建源323d19144f022f6ab4a518730971864d0fd56a21，工作流及源码拉取脚本与已审查版本逐字节一致。
- 发布前Argo Synced/Healthy、自动同步关闭，运行清单b71b34f36eeec72c2d5b848ef9bb9e5e01094b28。仅晋级Web，无迁移、后端、权限、菜单、凭据或用户真实外观修改。
- 本地类型检查、8项组件测试、索引检查、Host生产构建以及模拟Host亮暗表单浏览器验收通过。上线验收另行记录。
- 回退恢复发布前部署清单中的Web摘要；本次没有数据迁移，不需要数据库恢复。

## 发布结果

- 构建全部成功，产物12955212526，归档SHA-256 `7a9dd68388f5abb9bc8ba8fc4592bfc08a102b510e10e45c032719306801d4a0`；实际晋级Web manifest/config摘要、linux/amd64及源码标签核验通过。
- Web镜像`ghcr.io/supenbysz/kycrm-web@sha256:9e02ecf2e7b28ba7b81e9e653668cb3f7ef4025a892ba5b7bb9c8a7f2288ef67`，GitOps清单`3dfb1af8a61b9e0ee828c04ee707a2512b697aa8`。
- Argo Synced/Healthy/Succeeded、自动同步仍关闭；六个Deployment均observedGeneration匹配、updated/available/总replicas为1。其他五个服务镜像和generation均与发布前一致。
- 线上Host资源`/assets/main-BYor3-CO.js`及`component-center-page-DOodwBnt.js`包含新的三项跟随文案；24份复制源码与固定提交一致，预览CSP、no-cache/nosniff和缺失资源404通过。
- 真实账号菜单/bootstrap/权限及通用API烟测通过，验收会话注销；Executor保持未启用503。滚动交接时一次静态资源探测502，完成后复验与全套烟测成功。
- Edge真实Host可见默认“跟随当前配色／模式”，预览显示“已就绪”；线上石墨青亮色的预览背景和控件与Host一致。动态亮暗回归已在本地模拟Host完成，本轮没有改用户真实外观配置；未发布安装客户端。

[在线入口](https://console.kysion.com/w/platform/platform_root/system/components)。旧页面先刷新；若URL保留了旧的显式配色，点击“跟随当前主题”即可恢复同步。
