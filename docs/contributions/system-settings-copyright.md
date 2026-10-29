# 平台版权风格与条件编辑

平台主体仍允许空值；主体为空时登录页沿用现有平台名称回退。三种版权风格为 standard、full、chinese；年份按浏览器当地时间计算，纯格式化函数也支持指定时区。没有引入机构品牌、发布客户端或安装包能力。

## API 与兼容

GET `/api/v1/platform/platform-profile` 返回 copyrightStyle 和字符串 revision。新 PATCH `/api/v1/platform/platform-profile/edit` 使用同一 `platform.basic_info.update` 权限，输入 `{expectedRevision, fields}`。省略字段保留，文本空串清空，null、未知字段及非法枚举拒绝400；无版本428；并发版本冲突409。冲突保留表单，确认加载最新配置才覆盖输入。读权限沿用原有读取路由。

原 PATCH 保留原语义并递增 revision，保留版权风格。它仍是兼容写入口，没有条件写保障；旧写者仍可覆盖旧字段。新编辑页不会借用后台刷新取得的新版本提交旧表单。

## 迁移与最小权限

由迁移身份执行 `100_platform_copyright_revision.sql`。Org 仍是平台资料唯一写者；`ky_platform_profile_change` 在条件更新事务内写入，审计失败则回滚。审计仅存字段名、可信操作人和请求引用，不存配置内容。部署角色示例见 `ops/db/roles/platform_profile_revision.sql.example`，先替换 psql 参数为实际 Org 角色，不向其他服务授予写权限。

先迁移，再部署 Org 和页面；回退保留新增字段、版本及变更表，不能以旧二进制继续保证条件写。无需修改旧迁移校验和。不删除已有平台主体。

## 验证

Core formatter 测试覆盖三种风格、空值及时区跨年；Org 单元测试覆盖字段存在性和HTTP解析；独立 PostgreSQL 集成测试覆盖竞争更新、兼容写使版本失效、事务审计失败回滚。前端类型检查与构建单独执行；不将构建结果视为浏览器交互验收。
