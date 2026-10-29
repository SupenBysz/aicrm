# 机构与企业动态统计

POST `/api/v1/platform/agencies/statistics` 或 `/api/v1/platform/enterprises/statistics`，body `{ids:[...]}`，1至100个唯一ID。结果按ID返回旗下企业数量、用户online/employed/left/total，及 `terminalsSupported:false`，没有终端数值。

机构汇总要求机构查看和企业查看权限；企业汇总要求企业查看权限。Org通过Membership受控access-decisions核对actor、session、workspace、membership、已授予权限及all数据范围。目前只开放平台完整数据范围；受限范围返回403，不外推可见机构的旗下企业范围。未来部分企业授权投影需另行扩展，不能绕过此限制。权限依赖故障返回503，不伪装为零；不存在或删除的ID返回404。

Membership拥有成员事实，按账号去重，active/disabled在职优先于left，invited排除；仅active身份可在线。Auth拥有账号和会话事实，在线要求账号normal、未删除、会话active且未过期及90秒内心跳。Host只在可见且有会话时每30秒报告；该值是近期活动指标，不表示当前连接数。

内部统计端点仅接受内部凭据及请求引用，拒绝浏览器Bearer。Org不查询成员或终端私表。批量成员映射最多5000，超限整个统计不可用，不能截断冒充精确总量；Auth在线查询每块1000，整批有5秒预算。5000预算是保守保护值，尚未进行生产规模延迟验收。

列表主体先呈现，统计异步请求；悬浮、聚焦或点击加载最新用户详情；失败可重试。缓存按用户、工作区、成员身份及ID隔离。终端明确未接入。

## 迁移和部署

先执行101（Auth拥有session心跳），再部署Auth、Membership、Org与Host/插件。Auth启用 `KY_INTERNAL_SERVICE_TOKEN`，Org使用既有Membership URL及 `KY_AUTH_SERVICE_URL`；这些都是服务配置，不能由浏览器覆盖。服务间应使用隔离网络/TLS，内部路由不公开。

迁移不会为历史会话伪造心跳。角色沿用各服务现有所有权，列级权限部署需为Auth追加last_seen_at读写（示例见roles）。回退保留该列与索引，停止新心跳即可；不要删除旧会话。

## 验证与限制

全仓构建和类型检查、三个服务Go测试通过；独立PostgreSQL验证成员去重、在职优先、邀请排除、其他企业隔离、预算超限、账号状态及过期心跳，Shared验证批量上限。浏览器交互、独立评审、真实规模性能验收待完成。没有引入终端底座或生产部署。
