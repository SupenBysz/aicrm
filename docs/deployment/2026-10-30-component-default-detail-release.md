# 2026-10-30 组件中心默认详情布局发布

用户授权立即部署，目标console.kysion.com / kycrm-staging，仅晋级Web。

- 修复提交9f55b36，PR #21普通合并，源码16418e62aa05029e66efc5369f841df5f6f53d21。
- 集中构建41012120772，构建源bdd84fb4cb0857c87a8de7a6b691e3f41933d201。构建仓库HEAD有更新，但KyCRM工作流及源码拉取脚本仍与已审查文件逐字节一致。
- 发布前运行清单d888c01ef2a9c17dd116e01bacecfb94872c9cc1，Argo Synced/Healthy，自动同步关闭。
- 移除卡片目录，组件中心根路径直接展示分类导航和默认“设计基础与主题色板”；搜索/分类/状态筛选直接过滤左侧导航，窄屏保留滚动导航。既有深链接仍可用。
- 复用ListPageCard、现有导航和PreviewFrame。本地类型检查、8项测试、Host生产构建及根路径浏览器验收通过。
- 无数据库、权限、菜单或后端变更，不发布安装客户端；回退使用上个Web运行清单，无须数据库恢复。

## 发布结果

- 集中构建41012120772全成功；产物12958431629，归档SHA-256 `0935530fa4473e90f6e41216c5644de51a3c82ac53f54dd9cca97df5b774358c`。Web镜像manifest/config摘要、平台及固定源码标签核验通过；一次TLS EOF只读重试成功。
- 运行清单`b937dec1d2de8ebb5ea225016334f4c43998ed7f`，Argo Synced/Healthy/Succeeded，自动同步仍关闭；六个Deployment就绪，其他五个服务镜像和generation保持基线。
- 线上Host `/assets/main-B-QQFcv9.js`和详情chunk `component-center-page-CLJwIOcV.js`验证卡片入口文案已移除，分类导航存在；24份复制源码、安全响应策略和通用API烟测通过，测试会话注销，Executor仍503未启用。
- Edge从真实根入口`/w/platform/platform_root/system/components`打开，已见“组件分类导航”、默认“设计基础与主题色板”和“预览已就绪”，没有“查看效果与用法”卡片入口或正常详情“返回目录”按钮。未修改用户真实偏好或业务配置，安装客户端及全尺寸交互未做全量验收。

刷新旧页面后生效。
