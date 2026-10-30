# 2026-10-30 分段切换与时间轴示例发布

用户授权先部署，目标console.kysion.com / kycrm-staging，仅晋级Web。

- 提交e5bf4a5，PR #23普通合并，源码9cc270e21b65a6e21b03c98bb1b05fc7408b0676。
- 集中构建41031906964，构建源7c6a6eccc7b5251a67b45355f8eb977d20fdc24a；KyCRM工作流及拉取脚本与已审查版本一致。
- 基线fed8e3b6a2aaaa68ce4e292e1ec9d69d08a22a65，Argo Synced/Healthy、自动同步关闭。新增Segmented双样式和禁用、Timeline完成/处理中/空记录，共26条目49状态；复用现有antd与Host样式，不新增基础封装。
- 类型检查、9项组件测试（全部49状态真实渲染）、Host构建及索引检查通过。无数据库、权限或后端变更，不发布安装客户端。

## PR #11只读复查

Gitea实时读取：PR #11仍open、merged=false，贡献HEAD 4cc5a5fc2e9336ea613d129527ab51c8362bc7ca。PR #12已closed且merged=true，merge SHA 6f4df5fd09c6e36c0ef2ed4455a18cfe6382d6d3。两者均通过git merge-base --is-ancestor核验在当前main历史中。相关Web/服务发布见2026-10-30-menu-management-release.md。

因此贡献历史与修复已集成，原PR状态尚未收尾；本轮只读复查，没有擅自关闭原PR或替他人提交审查。桌面原生能力匹配安装包及Windows/Linux实机验收仍是原发布记录列出的边界，不以Web部署冒充完成。

## 发布结果

- 构建41031906964全成功，产物12966207820，归档SHA-256 `022f57a6e5b44ae604c88d2730e42e098410081228b18b3a06bb083972ec0c40`。实际Web manifest/config摘要、平台及源码标签核验通过。
- 运行清单`57a9b92ed25814eaa34a0275e6d08a0664669327`，Argo Synced/Healthy/Succeeded、自动同步仍关闭。六个Deployment就绪，其他五服务镜像和generation保持基线。
- 线上26份示例源码逐字节匹配固定提交、预览严格CSP和初始资源、缺失资源404、Host懒加载验证通过；通用真实账号API烟测通过，验收会话注销，Executor保持503未启用。
- 浏览器被用户持续切换，未完成两项新增组件的可靠现场交互验收，不将本地49状态渲染及线上资源检查冒充鼠标/安装客户端验收。

入口：管理中心→系统设置→组件中心→分段切换Segmented / 时间轴Timeline。刷新旧Host后可见。
