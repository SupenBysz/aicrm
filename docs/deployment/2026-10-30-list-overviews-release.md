# 2026-10-30 首期七类列表概览发布

目标：`https://console.kysion.com`，唯一准生产测试环境`kycrm-staging`。用户在首期本地实现完成后明确授权“立即部署”。

## 源码与构建

- 分三批提交：后端`aea9da5`、前端`5ba0956`、方案及验证`a4f0c53`。
- [PR #14](https://gitea.jditco.ltd/kysion/kycrm/pulls/14)普通合并，源码`2a2a3ecd379586c567b11f01f15defee838448db`；未增加权限、修改分支保护或制造独立审批。
- [集中构建40996747135](https://github.com/SupenBysz/kysion-build/actions/runs/40996747135)，构建仓库固定版本`323d19144f022f6ab4a518730971864d0fd56a21`。较上轮构建仓库变化仅涉及Kysion Pay工作流，KyCRM工作流及拉取脚本一致。
- 发布Auth、Org、Membership、Matrix后再发布Web；不晋级AI，不新增数据库迁移、不改写角色、菜单和用户偏好，不发布Desktop安装包。

## 发布前基线与备份

- 旧运行清单`ce1907ea32511716ee524a0920fe94787d4c03f7`；Argo Synced/Healthy，六Deployment均可用，自动同步关闭。
- 发布前真实账号API烟测通过，测试会话已注销；浏览器机构列表已读取作为对照。
- 备份Job `kycrm-overview-backup-20261030`成功；database-backups PVC：`/backups/kycrm-20261030T031920Z.dump`，705344字节，SHA-256 `400153e36e847d8511090822f0bd586d58dee960d02facc2bfd6bcfed69e0a48`。
- 独立只读Job `kycrm-overview-backup-verify-20261030`验证校验和及`pg_restore --list`通过；本轮未实际还原，不将本地PVC归档称异地灾备。

## 兼容与回退

旧列表请求语义保留；新邀请effectiveStatus、矩阵attention、日志endBefore筛选要求filterVersion=1，避免旧后端忽略参数而显示宽结果。若需回退，先回退Web再回退后端到旧运行清单，保留数据库及用户数据；没有本轮DDL需要撤回。

## 证据边界

本地完整构建、类型检查、相关Go、四类隔离PG、八项前端测试、七类HTTP授权及拒绝路径、四主题亮暗与窄屏渲染检查见[实施与验证记录](../list-overviews/实施与验证记录.md)。线上业务GUI、API、镜像运行情况分别记录，不以构建完成代替线上验收。

运维日志：本轮fullstack与coordinator访问`kysion/ops-log`均返回404，未扩大账号权限或改用管理员身份写普通工单；发布证据保存在本文件。此限制不影响目标代码仓库的已有发布权限。

## 实际晋级与线上验收

- 七组件集中构建和发布全部成功；产物12951577904，SHA-256 `ea49337292abc18e54ad3f5e46a5f1bfabf35b66e5727fb82e4f71f365072cbc`。七镜像manifest/config摘要及OCI源码标签核验通过，应用镜像来源固定为上述2a2a3ec完整SHA。
- 后端运行清单`c8a751c7657ee35de6ae94ffc7fc280b22176820`，四后端滚动完成后才晋级Web。最终运行清单`35180bb797d1eff8453254e1e344a5ea937516f1`，Argo最终Synced/Healthy/Succeeded，六Deployment均单副本可用，AI镜像和Deployment generation保持发布前一致。
- 公网验收发现资质审核原有路径未配置代理，返回Nginx 404。补齐平台及提交资质两条前缀路由，经[PR #15](https://gitea.jditco.ltd/kysion/kycrm/pulls/15)合并：`46d125ff0b6b0b666a76bf2b4c4b1fbbffe10061`。三项代理路由测试、现网容器独立临时配置`nginx -t`通过。代理由GitOps ConfigMap挂载，配置修复与Web晋级，不改写已构建镜像；镜像源码与运行配置修订分别可追溯。
- 初次同步保留旧生成ConfigMap导致OutOfSync；确认没有现存Web Pod引用旧配置后，仅选择清理该旧ConfigMap，不对其他资源开启全量prune，最终状态收敛。回滚应使用旧GitOps清单重建对应配置，不能只做kubectl镜像回退而忽略代理版本。
- 七类summary匿名均401；真实授权账号均200，统计总数与相同基础条件明细pagination.total一致；分页参数进入summary均400；邀请effectiveStatus、矩阵attention、日志endBefore筛选均响应filterVersion=1；菜单管理导航保留，注销后测试会话401。
- 发布后通用烟测通过：健康、登录/bootstrap、角色/权限/组织/矩阵/AI/插件服务健康正常，内部URL外部404、Executor继续按设计503。未启用Executor，没有修改平台/用户偏好、角色或菜单；测试登录产生正常认证日志。
- 公网资源`/assets/index-DK_nkoTn.js`包含概览与新筛选契约。最初资源断言误将仅用于后端/类型的search_without_status当成前端运行字符串，已改为实际组件及筛选标识并重跑通过，不将测试误判称线上代码缺失。
- 浏览器现场验收：机构概览四卡显示；点击“已停用”更新URL状态、卡片选择和空明细；点“全部记录”恢复原1条明细，概览分布保持不变。资质审核概览及空列表正常，登录日志默认固定24小时/北京时间输入及概览、明细正常显示。未修改任何主题设置，沿用用户当前石墨青暗色。

| 晋级组件 | 固定镜像 |
| --- | --- |
| web | `ghcr.io/supenbysz/kycrm-web@sha256:3621278fa17eda20bd5ea62862ffec8f092822caabdad5bd029a138cf624425e` |
| auth | `ghcr.io/supenbysz/kycrm-auth@sha256:fad4ff1c7c89d45056839c08e46d1db97ee5a0f6cbeee4e578ae42731ff855a8` |
| org | `ghcr.io/supenbysz/kycrm-org@sha256:9c93cfaa1b6fd1875193fd79e20dd99113ac8a4de4dd11b8813efb5bea315676` |
| membership | `ghcr.io/supenbysz/kycrm-membership@sha256:0dd40ab6971ecf839085946415baf79d83a4371a28c70a9b6930d19051404afc` |
| matrix | `ghcr.io/supenbysz/kycrm-matrix@sha256:8e63d7127cd37a31ce979020489657aced58dbdb433b66314650a05832f0c2cc` |

## 剩余边界

本轮已验证线上API与上述浏览器交互，没有声称已安装Desktop客户端、所有七页全部物理交互、跨DPI/全屏或线上大规模并发验收。备份没有在本轮执行还原，未做破坏性数据库恢复。
