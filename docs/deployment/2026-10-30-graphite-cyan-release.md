# 2026-10-30 石墨青亮暗主题发布

用户确认方案后明确授权立即部署。目标 https://console.kysion.com / kycrm-staging；新增主题可选，不自动切换平台或个人的既有选择。

## 来源与构建

- [PR #13](https://gitea.jditco.ltd/kysion/kycrm/pulls/13)已普通合并，源码`dc4eda3ce27516b28d8244c08abce180e654489e`。提交分后端约束、主题及原生适配、方案文档三批。沿用已有fullstack仓库写权限，无管理员、强制绕过、分支保护或机器人权限变更；未制造独立审核批准。
- [集中构建40939246683](https://github.com/SupenBysz/kysion-build/actions/runs/40939246683)七组件构建及镜像发布成功，构建仓库审核版本`6477c4fc8ac3d0597c75a2a1609fba23225767ed`。
- 产物12927210343，SHA-256 `3874a16cb882d437cb945c649a98048ea196db319adaebd7bcd4cf6c97586fa4`，七镜像摘要及源码标签核验通过。
- 运行清单`ce1907ea32511716ee524a0920fe94787d4c03f7`已推送deploy/staging，手动Argo同步。只晋级Web/Auth/Org；membership/matrix/ai的镜像及Deployment generation均与发布前一致。

| 晋级组件 | 固定镜像 |
| --- | --- |
| web | `ghcr.io/supenbysz/kycrm-web@sha256:8a3e1dfb55e05e8e777d91de9525c36dc3683001dc6087f8929e26d22d61f442` |
| auth | `ghcr.io/supenbysz/kycrm-auth@sha256:91b6b90db3b750cfd6ab5b6f22774931aae02f1aa04606d9f5cea2b577433e88` |
| org | `ghcr.io/supenbysz/kycrm-org@sha256:c331ef7ed3e1cc916c792e542249001454ffd99d7a3349c918115493f58482bf` |
| migrate | `ghcr.io/supenbysz/kycrm-migrate@sha256:8a39a4c496d77da257b72eb208ac87f9a6a521ebe76c96e1a345767d37da1f6a` |

## 数据库

- 备份Job `kycrm-graphite-backup-20261030`完成。database-backups PVC中`/backups/kycrm-20261029T192050Z.dump`，704995字节，SHA-256 `63392431cbd0586683a11457271b96c1ae473a2c60d785bd17013a1afe031f37`。
- 独立只读Job验证摘要、归档目录通过；此次未实际还原。
- 迁移Job `kycrm-migrate-dc4eda3ce275`成功；110台账校验和`e93110b2fce38788f08f594ccbbdf843c6cdf2a326c21100eb2949db0b4c3fb4`。现场确认两张外观表CHECK允许graphite-cyan并保留个人/平台继承组合限制。
- 未改写106或任何已保存的主题值，未自动收紧约束。

## 线上验证

- 最终Argo Synced/Healthy/Succeeded，六Deployment均1/1可用；新三个摘要匹配、其余三个镜像和generation未变。healthz正常。
- 真实账号登录后，Auth个人与Org平台接口均识别graphite-cyan的light/dark/system；使用故意过期revision请求确认409且没有写入。这里验证的是线上识别和CAS拒绝，不宣称已用真实账号完成新主题保存。
- 个人、平台、公共默认外观与发布前快照相同；会话注销后401，未修改真实偏好、角色和菜单。
- 菜单管理导航保留；公网JS `/assets/index-BrJjRUtG.js`包含“石墨青”和graphite-cyan。
- 本地已完成5项主题测试、类型检查、12任务构建、Auth/Org及共享Go测试、两个隔离数据库集成和Electron43原生探针；亮暗浮层截图检查通过。
- 本轮没有完成线上物理GUI、跨DPI/全屏交互或已安装客户端接真实API验收。没有分发新Desktop安装包；原生窗口背景、浮层/版本弹窗新增配色需匹配新版客户端，不能把Web上线等同客户端升级。

## 使用与回滚

入口：个人偏好→配色主题→石墨青，或系统配置→外观主题设置平台默认；支持亮色、暗色、跟随系统。

上一运行清单`8737cde2030918abcfefe69f5c4cb921e751cee3`。若新主题已经保存，旧Auth/Org可能拒绝新themeId，不能直接回退服务并忽略存量。回滚前备份并评估个人/平台偏好，不能自动重置用户选择、删除数据库/PVC或收紧约束。破坏性数据库恢复需单独授权。

运维记录：[ops-log #78](https://gitea.jditco.ltd/kysion/ops-log/issues/78)。
