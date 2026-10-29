# 2026-10-29 可选 AI 品牌图标发布

目标：`https://console.kysion.com` / `kycrm-staging`。用户授权立即部署。

## 变更

- 机构品牌增加“显示 AI 图标”开关，旧配置默认关闭。
- 开关实时更新浅/深色预览；保存草稿并发布后生效，机构及其旗下企业继承发布配置。历史回滚恢复该版本的开关值，审计记录开关变化。
- AI 后缀独立于文字图片，不写入生成/上传素材；预览与实际导航复用组件，按可用宽度和图片原始比例计算文字、分隔点、AI 的统一高度。
- 现有 JSON 草稿/发布存储兼容，无新增数据库 DDL；平台默认品牌不自动开启，域名入口维持关闭。

## 来源与校验

- 运行镜像源码：`7b751988c1046076d5856dc01c6f40c9b9661dec`。
- 集中构建：[40832866053](https://github.com/SupenBysz/kysion-build/actions/runs/40832866053)。
- 发布前运行清单：`db714bc06f0449b004e6d5a647d8dcca2cfab957`，Argo Synced/Healthy，六应用 1/1。
- 前端全工作区类型检查 23 项成功，宿主构建成功；Go store/server/shared 品牌测试及 race 检查通过。
- 独立 PostgreSQL 品牌生命周期测试覆盖开/关、草稿重读、发布、继承、旧版本及开关版本回滚；独立贡献数据库测试及新装/升级/重复迁移校验通过。

## 备份及发布过程

- 发布前备份 `kycrm-before-ai-suffix-20261029` 因 YAML 折叠后的 shell 循环缺少分号而失败，未执行应用切换。
- 修正 CronJob 就绪等待脚本，解析后的命令经 `bash -n` 验证；源码修复提交 `5dd07f5`，该运维配置不改变镜像内容。
- 重试 Job `kycrm-before-ai-suffix-20261029-v2` Complete，备份 `kycrm-20261029T070303Z.dump`，589604 字节，SHA256 `9360e2e839c18282e42ba27d654f93a621109d96d45f7868b44f7191a1fc4ee7`。备份内容目录已验证；本地卷备份不等于异地灾备。
- 更新前认证 API 冒烟通过，测试会话已退出并验证失效。

## 发布完成验收

- 运行清单提交：`ebedf750ee1aa09623808eaee40018b444d8b5fd`，已推送 `deploy/staging` 并手动同步 Argo。
- 发布产物 ID `12880210784`，SHA256 `6383823ce88d08273dac01642c9523508ebf066dca59649d64f14a35f91b0fe1`；成功工作流、固定仓库/工作流提交、运行源码标识和产物 digest 均通过校验。
- 六个部署的镜像与发布 digest 逐一相符，均完成滚动更新、可用 1/1；Argo `Synced / Healthy`，自动同步仍关闭。
- 公网静态入口已更新为 `/assets/index-BufhP6sZ.js`，包含开关及统一尺寸适配逻辑。
- 浏览器在实际线上机构品牌抽屉确认开关默认关闭；开启后浅、深色预览同时出现 AI，关闭后两者同时移除，截图确认文字与 AI 统一缩放。未保存草稿、未发布或更改现有机构品牌数据。
- 更新后认证 API 冒烟、机构统计、品牌读取、未知素材 404、域名入口关闭验证通过；测试会话退出并验证失效。
- 持久化、发布、继承和历史回滚由隔离数据库生命周期测试验证；未在现有准生产机构上执行品牌发布或回滚。

## 回滚

运行异常时恢复上一 `deploy/staging` 的镜像清单并手动同步 Argo；不自动回退数据库。本次无新 DDL，旧程序可读取带新字段的 JSON。关闭开关后仍需保存草稿并发布。

### 七组件镜像

- ai: `ghcr.io/supenbysz/kycrm-ai@sha256:cf271f0b1cf64602bd5c82b70d272d967c9d08dcedd15766b28dc60c72654122`
- auth: `ghcr.io/supenbysz/kycrm-auth@sha256:25c30d6fc6528594f1ec8d0a0542c6008bb58440738dd1691c2aca1e4463f395`
- matrix: `ghcr.io/supenbysz/kycrm-matrix@sha256:ff91819e1046ad0674f7475e15b6133b46b52ff6c6274251b8a4ce4d4f789617`
- membership: `ghcr.io/supenbysz/kycrm-membership@sha256:7416b5e6b3850ab6f545e8989c131b10b521754614a401b6a76109dcc787c204`
- migrate: `ghcr.io/supenbysz/kycrm-migrate@sha256:d440e9b8b04f871873bc0d987f53fd08d6d600f8880ddf5ec838856e6bf272ba`
- org: `ghcr.io/supenbysz/kycrm-org@sha256:841af94a87756609f5d258e8e89e90ae88a99b7329d71149e5151ddc86217c9d`
- web: `ghcr.io/supenbysz/kycrm-web@sha256:9337d30aa0ce4bd0a88cdf3be1e20c130d531c705aec5ca6a892426aea67e744`

## 可见字形高度修正发布

- 用户再次授权立即部署，修正文字图片透明留白造成 AI 偏高的问题。运行镜像源码 `44e707f232575b28247df102ef7cd64569d20216`。
- 文字图片按非透明像素行测量可见高度、垂直中心；分隔点和 AI 按相同可见高度适配；图像测量缓存避免重复扫描。跨源不可读图片回退图片边界。
- 类型检查 23 项成功，前端构建通过。
- [集中构建 40834606707](https://github.com/SupenBysz/kysion-build/actions/runs/40834606707) 成功；产物 ID `12879943779`，SHA256 `bf12e22e536c6936d85e27c45c799b4d6d3af24033a38f3627ababbab821f6ca`。
- 运行清单 `9db65030a50c6784bafbf9300d5b504bf866b2e2`，六应用镜像逐一与产物 digest 比对一致；最终各只有一个新副本且可用，Argo `Synced / Healthy`。
- 公网新包 `/assets/index-Cl0svBhm.js` 包含可见字形测量与垂直校正逻辑。浏览器在新标签页确认浅/深背景预览，AI 与文字可见高度适配，未保存或发布真实机构配置；原窗口未保存内容保留。
- 更新前后认证 API 冒烟均通过，测试会话已退出并验证失效。
- 本次仅前端代码，不增加数据库 DDL/业务写入；沿用本报告同日已完成并校验的发布前备份。回滚目标为上一运行清单 `ebedf750ee1aa09623808eaee40018b444d8b5fd`。
