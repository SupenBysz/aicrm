# 2026-10-29 平台品牌表单统一发布

用户授权立即部署，目标 `https://console.kysion.com` / `kycrm-staging`。

## 范围与来源

- 平台品牌表单参照机构品牌，补齐品牌名称、应用显示名称、图标文字、应用图标、文字 LOGO、AI 开关、版权署名/风格及浅深色预览。图片生成、品牌尺寸适配和样式复用。
- 主体名称与ICP备案保留在主体信息；平台保存后生效，继续使用基础信息权限、revision CAS和审计。旧文字/字体字段保留兼容回退。
- 运行源码：`6d53ab6bdfa7962d9614443e557ee40a11cb4423`。
- [集中构建 40846912332](https://github.com/SupenBysz/kysion-build/actions/runs/40846912332)，成功；固定构建仓库/工作流、源码SHA、发布产物和digest均校验通过。
- 产物 ID `12884749917`；SHA256 `621951b6c2d3ae6ff73d3385218c0369db2f84722d740db73e11260ab0134cc0`。
- 运行清单 `cc01c881bbe12c2cd02b63516f5b653815f7c625`，已推送 `deploy/staging` 并手动同步Argo；自动同步仍关闭。

## 备份及迁移

- 发布前 Argo Synced/Healthy，旧运行清单 `21e2ac23edd3f670a09bea30c2c6eacada6d4534`。
- 备份 Job `kycrm-before-platform-brand-20261029` Complete；文件 `kycrm-20261029T090522Z.dump`，590716字节，SHA256 `6410eb110f67eb81a751b1160f79a5f60ebec6dbf092b2db9fef53e611a8b74f`。备份目录检查与独立哈希回读成功；本地卷备份不等于异地灾备。
- 迁移 Job `kycrm-migrate-6d53ab6bdfa7` Complete，新增105：平台品牌JSON配置和独立PNG素材表。
- 在线台账71条、最高版本105，全部迁移文件名/校验和与源码相符。
- 应用更新完成后删除旧且无Pod引用的生成式代理ConfigMap，移除残留资源差异。

## 验收

- 六个Deployment均只有一个新副本且1/1可用，镜像逐一与产物digest一致；Argo Synced/Healthy。
- 更新前后认证API冒烟通过，测试会话退出并验证失效。域名入口维持关闭，未部署Executor/Worker/Gateway。
- 线上公共平台配置与发布前逐字段对照一致，revision仍为3；新增brand配置安全默认为未启用素材、AI关闭。
- 公网包 `/assets/index-dAqxAzE1.js` 包含平台素材接口及新表单。不存在的公开平台素材由Org返回404/not_found错误体。
- 浏览器直接打开线上系统配置，确认完整表单及Kysion/Ky旧值带入、版权实时预览与浅深色LOGO预览；未在准生产上传、保存或发布客户品牌。
- 全工作区类型检查23项、前端构建、相关Go/race检查通过。独立数据库验证新字段保存重读、CAS、未引用素材404、当前引用可公开读取、移除引用404、继承回退及审计失败回滚；完整贡献数据库新装/升级/重复迁移通过（包含105）。
- 隔离HTTP接口验证PNG上传、认证预览、保存重读、当前公开素材、409、恢复后404。隔离浏览器已确认表单和AI即时预览，但浏览器点击保存的独立交互验收未完成，不将接口成功混同该GUI操作完成。

## 回滚

恢复旧运行清单 `21e2ac23edd3f670a09bea30c2c6eacada6d4534` 并手动同步Argo；保留新增兼容列、素材表和审计，不自动降级数据库。回滚旧前端将看不到新表单项，故已上传的新素材/配置不应主动删除。

## 镜像

- ai: `ghcr.io/supenbysz/kycrm-ai@sha256:7c26d4b456e0767982d2c8516b4fefee3afcd7b02bb2bafbf531a78468d94cf8`
- auth: `ghcr.io/supenbysz/kycrm-auth@sha256:6c91dde3552ee99bf5b151ba6a9b80ac6e237d2a446d34cbaee46725a6279cdb`
- matrix: `ghcr.io/supenbysz/kycrm-matrix@sha256:ccfcab05b5515562ebeb3b00cb4797b52e34b786c3570f913142769bda065822`
- membership: `ghcr.io/supenbysz/kycrm-membership@sha256:21d7864d380d60639b1b6d62a8eb47d3ced9ee43d0461e7e307ced598e08d0a6`
- migrate: `ghcr.io/supenbysz/kycrm-migrate@sha256:8c157a1ed45c03507133c0387473aa90fde930705137bafdca72288dff0d19c3`
- org: `ghcr.io/supenbysz/kycrm-org@sha256:a5fde015b5d1c68d5b98aa3693171152fb7ba2736eecbc7ac5bc04f05b9f9bff`
- web: `ghcr.io/supenbysz/kycrm-web@sha256:ef3e4137b027bc0347b97a007bedabc4e09f571624ba614ad138d7e671f9fec4`
