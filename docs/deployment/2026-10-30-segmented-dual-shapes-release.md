# 2026-10-30 分段切换双形态对照修复发布

用户授权立即部署，目标console.kysion.com / kycrm-staging，仅晋级Web。

- 修复提交b9fe727，PR #24普通合并，源码ce99da3641036ea841094aaaf36fb49894c777db。
- 集中构建41039457602，构建源7c6a6eccc7b5251a67b45355f8eb977d20fdc24a；KyCRM工作流及源码拉取脚本与已审查版本一致。
- 发布前运行清单57a9b92ed25814eaa34a0275e6d08a0664669327，Argo Synced/Healthy，自动同步关闭。
- 默认示例同时展示顶部胶囊与列表工具栏Segmented，两组独立选中状态，分别复用顶部app-mode-segmented及菜单管理同款antd；保留header深链接、禁用双形态及主题独立覆盖。
- 类型检查、9项测试（默认双形态实际SSR、全部49状态）、Host构建及索引校验通过。无数据库、权限或后端变更，不发布安装包。回退使用原Web运行清单。

## 发布结果

- 构建41039457602全成功，产物12970006330，归档SHA-256 `ba299808a11ff07fc6e2ddd0678937790c274af2d4c4996b46f7ad98d1ec75c5`。Web manifest/config摘要、平台及固定源码标签核验通过。
- 运行清单`1fa5683470e945f91b3ce0bba99566489f519aab`，Argo Synced/Healthy/Succeeded，自动同步仍关闭；六个Deployment就绪，其他五服务镜像和generation与基线一致。
- 全26份线上示例源码匹配固定提交（segmented含两组独立状态/实际样式），初始预览资源、安全响应策略、缺失资源404及Host懒加载检查通过；Host入口`/assets/main-COE1IRud.js`。
- 通用真实账号API烟测通过，验收会话注销，Executor保持503未启用。
- 本轮现场浏览器host不可用；未将资源一致性/49状态SSR冒充实际暗色视觉或鼠标验收。客户端已关闭后，工具选取runtime路径误启动空Electron运行壳，已立即退出，未改用户配置或留下空壳。

刷新后在组件中心→分段切换选择“双形态对照”（example=default）；旧header链接仍只展示顶部。预览若显式选择亮色，可点“跟随当前主题”。
