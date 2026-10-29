# 2026-10-29 顶部明暗快捷按钮发布

用户授权立即部署，目标 `https://console.kysion.com` / `kycrm-staging`。仅恢复公告与全屏之间的亮色/暗色按钮；跟随系统和平台继承仍在个人偏好中设置。PR #11未合并，不含其代码和迁移107。

## 来源与构建

- 运行Web源码：`da2db2852402eb201426bbbc745c4c3752a75c20`，已推送Gitea main。
- [集中构建40905577150](https://github.com/SupenBysz/kysion-build/actions/runs/40905577150) 成功。
- 固定构建仓库提交：`557dd15ea00a0c1e7c40dd075cac072d8152f2c5`；相较已核验版本仅有其他项目工作流变化，KyCRM工作流和取源码脚本无变化。
- 产物ID `12911627303`；SHA256 `9452d9a5d880e49020482e620453baa16ff354955da367669518864eda41cd9c`。产物来源及七个镜像的摘要、源码标签核验通过。
- 本次仅采用Web镜像：`ghcr.io/supenbysz/kycrm-web@sha256:f9485568e56f7363241b2bb52309f563b57fef0e0f4214dde8209ab68035c1fc`；其余新构建镜像没有晋级到运行清单。
- 新运行清单：`24d68985889fa64c126dedf549a9d01b583e9dea`，推送deploy/staging并手动Argo同步；自动同步仍关闭。

## 范围与验证

- 按钮保留当前themeId，依据当前实际明暗切换到明确light/dark，沿用本人偏好自动保存；不修改平台默认，不增加顶部system选项。
- Host类型检查与生产构建通过。Vite仍有既有主包体积提示。
- 变更前后六个Deployment均1/1可用；新Web摘要匹配产物，五个后端的镜像和Deployment generation逐项未变。
- Argo最终Synced/Healthy，运行版本与新清单一致。
- 发布前后认证API冒烟通过，测试会话注销并确认失效。
- 公网JS `/assets/index-CZN6Kv3W.js` 含亮暗操作及按钮标识；CSS `/assets/index-CshiaHky.css` 沿用既有顶部样式。
- Edge新标签直接打开线上工作台，确认按钮顺序为公告、切换暗色、全屏、锁屏。没有修改真实账号的外观或品牌配置；不将只读界面验收称为已完成真实账号切换持久化验收。
- 不涉及SQL迁移、数据库写入部署或新权限；未执行迁移107。本次前端发布没有新增数据库备份，上一主题发布备份仍按原发布记录管理。
- 未分发新客户端安装包；现有客户端加载新版Host后消费该按钮。

## 回滚

上一运行清单 `85223012ce3e2573998d0844c0e2013406c545aa`。回到该清单并手动同步Argo即可恢复此前Web版本；后端和数据库没有本次回滚动作。

按K3s工作空间规范留痕：[ops-log #76](https://gitea.jditco.ltd/kysion/ops-log/issues/76)。
