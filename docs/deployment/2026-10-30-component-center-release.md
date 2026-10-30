# 2026-10-30 组件中心发布

目标：`https://console.kysion.com`，唯一准生产测试环境`kycrm-staging`。用户在首期实现后明确授权“立即部署”。

## 源码与构建

- 三批提交：权限/菜单/代理`09facc9`，组件中心及示例`12d0aa4`，索引/Skill/文档`5571457`。
- [PR #16](https://gitea.jditco.ltd/kysion/kycrm/pulls/16)普通合并，源码`c3f18c2cdab8edb874554466916fa60c143ec300`；使用既有fullstack写权限，未修改分支保护、授予机器人权限或制造独立审批。
- [集中构建41002658076](https://github.com/SupenBysz/kysion-build/actions/runs/41002658076)，构建仓库固定版本`323d19144f022f6ab4a518730971864d0fd56a21`，KyCRM工作流及源码拉取脚本与已审查版本一致。
- 本次只晋级Membership和Web，其他业务服务镜像及generation保持发布前值；迁移使用本次固定摘要的migrate镜像。不发布Desktop安装包，不启用Executor，不修改用户主题或密钥存储。

## 发布前基线与备份

- 运行清单`35180bb797d1eff8453254e1e344a5ea937516f1`，Argo Synced/Healthy，自动同步关闭，六个Deployment均可用；登录/bootstrap与通用API烟测通过，测试会话注销。
- 已有76条迁移校验和与源码完全一致，只有111待执行；未改写历史迁移。
- 备份Job `kycrm-component-backup-20261030`完成：database-backups PVC中`/backups/kycrm-20261030T042329Z.dump`，705990字节，SHA-256 `4221162a4e980db1b8248756632dcf019c15c0926c8ea95ffc6d29aa2b4d2321`。
- 独立只读Job `kycrm-component-backup-verify-20261030`校验摘要及pg_restore归档目录通过；本轮未实际还原，不将本地PVC归档称异地灾备。

## 权限和晋级合同

111仅追加页面权限`platform.component_center.view`与`ky-component-center.catalog`菜单叶子，父节点为既有`group.ky-system-settings`。默认仅授予系统platform_root超级管理员；已有目录元数据冲突时不覆盖，其他角色不自动扩大授权。

先迁移，后发布Membership可信目录，最后Web及专属预览CSP。后端GitOps合并源码时保留旧nginx.conf，避免ConfigMap哈希提前触发Web滚动；Web阶段才晋级新代理配置。需要回退时用旧Web/运行配置，停用入口并保留新增权限和客户元数据，不自动恢复数据库或回写历史checksum。

运维留痕：本轮fullstack访问kysion/ops-log仍返回404；未扩大权限或改用管理员身份写普通工单，证据保存在本文件。

本地实现与验证见[实施记录](../component-center/实施与验证记录.md)；下文发布结果按实际完成后补记，不把构建成功当作线上验收。

## 实际发布结果

- 集中构建全部成功，7个镜像的manifest/config摘要、平台及源码标签均核验通过；发布归档摘要`sha256:4160fb0ca40845fb73e40c34d514bcd44b1d8d5775c03f8cabfd3598a607b68b`。
- 迁移Job `kycrm-migrate-c3f18c2cdab8`成功，现有77条迁移checksum全部匹配，111权限仅默认授予platform_owner，菜单位于现有系统设置分组。
- Membership晋级`3e3858d754500625a4dd3b78e002d6dd58192d49`并通过真实账号bootstrap、可信菜单、权限目录验收后，Web晋级`b71b34f36eeec72c2d5b848ef9bb9e5e01094b28`。Auth、Org、Matrix、AI镜像和Deployment generation均保持基线。
- 六个Deployment均observedGeneration匹配，updated/available/总replicas均为1；Argo最终Synced/Healthy/Succeeded，revision为上述Web晋级SHA，自动同步仍关闭。
- 仅对已无活动Web Pod引用的旧ConfigMap `kycrm-web-proxy-fmd2bc9b42`进行选择性Argo prune，没有全量清理资源。
- 线上预览HTML、初始资源、严格CSP、no-cache/nosniff、全部24份复制源码与固定源码逐字节匹配、缺失资源404及Host懒加载检查通过。
- 登录/bootstrap、权限/角色、组织、矩阵、AI、插件健康等通用烟测通过；Executor仍503（保持未启用），测试会话均注销。Web滚动交接期间一次登录探测502，滚动完成后重验成功，最终通用烟测通过。
- Edge真实已登录Host验收：管理中心→系统设置→组件中心入口可见，目录24项，列表概览详情显示“预览已就绪”及真实统计控件，默认示例复制反馈“已复制”。未修改用户真实外观或业务配置。
- 本次没有发布安装客户端，也未完成所有组件鼠标交互、跨DPI、原生WebView层级或业务负载验收；experimental状态保持。备份仅验证归档可读，未执行恢复演练。

在线入口：https://console.kysion.com/w/platform/platform_root/system/components 。使用旧页面的用户需刷新加载新Host；普通角色需按权限管理流程显式授权，默认不扩大授权。
