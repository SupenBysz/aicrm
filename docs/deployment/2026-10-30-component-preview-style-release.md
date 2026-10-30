# 2026-10-30 组件目录样式与初始化防闪色发布

用户授权立即部署，目标console.kysion.com / kycrm-staging，仅晋级Web。

- 修复提交cb8362c，PR #18普通合并，源码97d5e35f49a4551087487a9d091d610253eba097。
- 集中构建41005797989，构建源323d19144f022f6ab4a518730971864d0fd56a21；工作流及源码拉取脚本与既有审查版本一致。
- 初始运行清单3dfb1af8a61b9e0ee828c04ee707a2512b697aa8，Argo Synced/Healthy，自动同步关闭。
- 目录使用aria-current和text按钮，选中背景/文字复用主导航admin-accent-soft/admin-accent，500字重、无按钮阴影。
- 预览初始化采用目标主题背景占位；iframe保持挂载，renderer在layout effect应用主题变量后发送applied，接到确认再展示文档。
- 本地类型检查、8项组件测试、索引检查、Host构建通过；浏览器验证浅色选中和预览就绪。没有数据库迁移、权限或菜单变更。
- 回退恢复上个运行清单的Web镜像摘要，不涉及数据库还原；本轮不发布安装客户端。

## 发布与验收结果

- 集中构建全成功；归档12955582144，SHA-256 `6c89c7d766f41c8cb911d2e27a1f0548da97ad08272acaf4313c344e0ee3eaf9`。Web镜像manifest/config摘要、平台与固定源码标签核验通过。
- 运行清单`1a5e325aa84d823ce730f41fbbf559a91b72f7ce`，Argo Synced/Healthy/Succeeded、自动同步仍关闭。六个Deployment就绪，其他五个服务镜像与generation不变。
- 线上`/assets/main-Dq8bRJN6.js`、`component-center-page-CfvysYpX.js`及对应CSS确认包含目标主题占位、预览展示闸口、浅色导航选中样式；24份源码、安全响应策略及缺失资源404通过。
- 真实账号菜单/bootstrap/权限及通用API烟测通过，测试会话已注销；Executor保持503未启用。
- Edge线上Select页面预览已就绪，截图可见目录选中改为浅色背景与主题文字，预览配色正常。未进行逐帧录像或跨浏览器慢网闪屏测试；初始化前后展示闸口由组件测试及线上产物检查覆盖，不把稳定态截图称作逐帧证明。
- 验收时发现浏览器仍停在已关闭的本地模拟服务页面，已切换到console.kysion.com真实线上页面，避免将本地超时报错当线上故障。

刷新旧页面后生效，本轮未发布安装客户端。
