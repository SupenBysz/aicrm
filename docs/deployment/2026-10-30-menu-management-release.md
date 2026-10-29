# 2026-10-30 菜单管理与 PR11 集成发布

用户授权立即上线，目标 https://console.kysion.com / kycrm-staging。本次解决权限中心缺少菜单管理；未修改其他项目、机器人仓库授权或分支保护。

## 来源与发布

- [PR #12](https://gitea.jditco.ltd/kysion/kycrm/pulls/12)服务端普通合并成功，源码`6f4df5fd09c6e36c0ef2ed4455a18cfe6382d6d3`，保留PR #11原贡献历史。由已有写权限fullstack身份按用户直接发布指令执行；未使用管理员/强制绕过参数，未制造独立批准事件。
- [集中构建40935148157](https://github.com/SupenBysz/kysion-build/actions/runs/40935148157)成功。构建仓库`6477c4fc8ac3d0597c75a2a1609fba23225767ed`，相较此前审核版本KyCRM工作流和取源码脚本无变化。
- 发布产物12925735092，SHA-256 `2d6573509390d21f2fbc4965ec210d64ffc83ede765a68f03ffb4584071b2a69`；七个镜像来源、摘要和源码标签逐一验证。
- 新运行清单`8737cde2030918abcfefe69f5c4cb921e751cee3`，deploy/staging已推送；手动Argo同步及清理旧生成代理ConfigMap，自动同步仍未启用。最终Synced/Healthy/Succeeded。

| 组件 | 固定镜像 |
| --- | --- |
| web | `ghcr.io/supenbysz/kycrm-web@sha256:748f8ff1978d409b143d7f733d9a067b454c46aed1d11363d9d5769295f427fa` |
| auth | `ghcr.io/supenbysz/kycrm-auth@sha256:295be795c2c46f4145c323229f957318c8ade5080418ce94081fab312db81804` |
| org | `ghcr.io/supenbysz/kycrm-org@sha256:3c2539a5c45eb876147c30eddd075e6103997a73b88e9fb76764a9fa3678c501` |
| membership | `ghcr.io/supenbysz/kycrm-membership@sha256:5bebc49a8e1cd84f6deabcbb268061f29dd11b3e155e9d9446c8db7407d816c5` |
| matrix | `ghcr.io/supenbysz/kycrm-matrix@sha256:7d88c8bba45e7e64627145d574b9a5853920307c7eef165fd2d7c80ddd66977c` |
| ai | `ghcr.io/supenbysz/kycrm-ai@sha256:9eede7dd42401f2eec4ebb83d1fbc76efa0d3059057ac0d4ed165b165a1de549` |
| migrate | `ghcr.io/supenbysz/kycrm-migrate@sha256:ca041d982744b6200e0fa6b26051a4e282aa6d85bf983e58de43651364991c04` |

## 备份及迁移

备份Job `kycrm-menu-backup-20261030`成功。database-backups PVC中`/backups/kycrm-20261029T185436Z.dump`，686567字节，SHA-256 `2ffe39d53aa146f036186f95ab01455d1d5fdad7dba78dede85a7c718cd2237e`。独立只读检查Job核验摘要及pg_restore目录通过；此次未实际还原。

迁移Job `kycrm-migrate-6f4df5fd09c6`成功，台账106升级至109。107原始校验和不变，执行器按既有精确规则处理外层事务；108初始化40节点；109记录作用域修订。保护平台owner角色已具备菜单目录view/manage两项权限。运行角色按既有默认权限获得新表DML和序列权限，不拥有迁移台账DDL。

## 验收

- 六Deployment均新摘要匹配且1/1可用。多服务同时滚动期间短暂受命名空间CPU limit配额限制；先完成服务释放旧副本后自动继续，无扩容配额或删除业务实例。
- 真实Super.Admin登录/bootstrap包含菜单管理权限；管理中心visible目录返回“菜单管理”，catalogReady=true。
- 菜单管理列表、40节点可信注册目录、工作台目录、角色已有权限及permissionRevision、WebView脚本资源候选接口均通过公网实际请求验证。
- 测试会话注销后bootstrap返回401，未修改真实菜单、角色、品牌或个人偏好。
- 既有外观公共/个人/平台读取和权限冒烟通过；healthz正常。
- 公网JS `/assets/index-CSH4_qCB.js`包含菜单管理及路由注册。入口为管理中心→权限中心→菜单管理，路径`/w/platform/platform_root/menu-directory`。
- 浏览器自动化运行库加载失败，未把API及资源检查写成物理GUI验收。用户刷新后可验收真实界面。
- 本次为Web/服务部署，没有分发新版Desktop安装包；原生WebView v2及浮层能力需匹配的新客户端。Windows/Linux物理交互及历史菜单引用全量清理仍未完成。

## 回滚

上一运行清单`24d68985889fa64c126dedf549a9d01b583e9dea`，按原清单固定镜像及代理配置手动同步。107–109属于追加DDL，不随镜像回滚自动删除；禁止清空数据库或删除PVC。若需要破坏性备份恢复，必须另行批准并处理发布后的新增数据。

运维记录：[ops-log #77](https://gitea.jditco.ltd/kysion/ops-log/issues/77)。
