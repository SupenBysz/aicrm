# 2026-10-30 工具栏分段滑槽修复发布

用户授权立即部署，目标console.kysion.com / kycrm-staging，仅晋级Web。

- 提交87aafbf，PR #25普通合并，源码498a0f639195228ec68f3b63eb0a44e8a1d9ae94。
- 集中构建41041530765，构建源7c6a6eccc7b5251a67b45355f8eb977d20fdc24a，KyCRM工作流及源码拉取脚本与已审查版本一致。
- 基线1fa5683470e945f91b3ce0bba99566489f519aab，Argo Synced/Healthy、自动同步关闭。
- 实际菜单工具栏和组件示例共用list-toolbar-segmented：完整圆角滑槽、边框、3px内边距，选中项/动画thumb统一层次。暗色32%黑槽、12%白选中块；亮色复用surface-soft/surface。
- 插件类型检查、9项测试及49状态SSR、Host构建/索引校验通过。无数据库、权限或后端变更；不发布安装客户端，回退使用旧Web运行清单。

## 发布结果

- 构建全部成功，归档12970144133，SHA256 `50bc2e92a51305f314b83733e0e25fd74fb49beb2a515fb67a0e5f33942d95b1`；Web的linux/amd64、来源标签及清单摘要核验通过。
- GitOps晋级 `00c707549c5916baddc7fa7b645db993507be74b`，Argo精确同步后Synced / Healthy / Succeeded，六个部署就绪；仅Web镜像更新，其他五个服务镜像及generation不变。
- 线上CSS包含共享滑槽、暗色轨道、3px内边距和动画thumb规则；26份示例源码与固定源码SHA一致，独立预览CSP与懒加载通过。通用认证API回归通过，Executor保持预期503禁用状态；验收会话已注销。
- Edge刷新线上组件中心后，暗色双形态预览就绪，实际截图可见工具栏完整圆角滑槽及内嵌选中块。此次完成浏览器视觉核验，未进行安装客户端验收或全主题鼠标交互遍历。
