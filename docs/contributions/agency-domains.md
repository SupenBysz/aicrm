# CF托管机构入口（默认关闭）

本批依赖机构品牌贡献，提供CF托管子域名、平台域名列和引导抽屉、持久任务/worker、回环网关、六服务门禁和机构登录品牌。不提供SaaS模式；IP解析是禁用占位，后续另行实现映射。仅接受Public Suffix List识别的注册根域下一层子域，拒绝根域和深层域名。

## 流程与状态

平台有view/manage/activate三个独立权限，迁移只注册，不自动授予。受控Membership API复核账号、平台身份、权限和数据范围。域名绑定不是通过客户端传机构ID决定登录身份。机构域名列位于联系人前，已启用域名在新标签打开；抽屉技术详情和检查记录默认折叠，记录分页。取消候选不要求说明，仍保留确认和审计。

托管检测查询被授权账号及精确Zone；其他CF账号不算已接入。未托管站点只有显式允许创建时才建立，显示NS变更引导；必须先核对官网、邮件及原DNS。已授权Zone自动添加验证TXT，公开验证成功后检查隧道并添加带实例/绑定标记的CNAME；不覆盖冲突记录，不修改整个Tunnel，不删除Zone。活跃入口失去公开TXT不会自动补回，持续失败会停用。

数据库唯一索引保障每机构一个正式入口、一个候选及全局域名占用。幂等命令、revision/generation、90秒租约、65秒外部调用预算和结果CAS阻止旧任务复活；取消仍保留旧租约至过期，清理等待旧写者退出。供应商写超时通过标记查询恢复；清理未确认前不释放域名。未曾被worker领取的候选可直接取消；授权范围变化导致无法确认旧资源时保持清理中，需管理员恢复原授权后重试，不能伪装成功。只清理本实例/绑定标记资源，验证TXT同样自动清理。对象与审计同Org事务。

首次自动启用同时要求manage和activate，缺activate只进入ready；替换已有入口需要显式activate。worker领取时和结果保存时重新核对权限，机构状态仍由Org检查。外部调用不持有DB事务，worker无DB凭据。

## 入口与身份隔离

专用远程管理Tunnel使用一次性配置的通用catch-all到回环网关，模板见ops/domains。普通候选、未知、停用或解绑域名全部拒绝。仅短时、按主机签名的专用well-known探测可读取当前候选证明；公开请求不携带可复用服务密钥。网关内部还需独立凭据，不能用候选探测建立业务会话。六个不同服务的门禁身份/版本必须全部确认。

网关校验原始Host与Origin，清除客户端内部凭据、覆盖入口证明；业务服务只监听回环，外部不能直达端口。Auth/Org/Membership/AI Model/Matrix Account/Agent Executor逐个校验入口；内部路由仍需自身内部鉴权，网关拒绝代理internal、health和ready。`KY_DOMAIN_ORIGIN_ISOLATED=1`只是运维声明，必须实测源站不可绕过，不能当作证明。

Auth登录仅允许旗下有效身份，错误密码和非旗下账号使用相同拒绝响应。会话与入口host、binding及generation同事务保存；bootstrap只返回所属工作区，后续每次请求核对代次及有效成员。机构登录前先解析可信入口并保持正文和HTML标题中性，失败提供重试。缺机构品牌时使用平台有效品牌。入口明确拒绝才清理会话，503不清理。

REST、上传/下载经网关，当前请求最长30秒。WebSocket及Upgrade明确拒绝；SSE连接也受30秒超时约束，重连时重新校验，不声称与平台长连接体验等价。超过30秒的传输需要后续专门设计，不可绕过网关。公开探测固定HTTPS443、拒绝跳转、逐个校验实际连接IP，屏蔽私有/保留地址，防止DNS重绑定SSRF。

## API与所有权

平台前缀 `/api/v1/platform/agencies/{id}/domains`：GET列表、POST创建；GET `{binding}`详情；POST `{binding}/{check|activate|suspend|resume|detach|cancel|renew-challenge}`。命令使用Idempotency-Key和revision，提供NS迁移确认。`/api/v1/platform/agencies/domain-summaries`支持至多100个机构。错误包含400/403/404/409/429/503；轮询受限流。

Org拥有103的绑定、任务、幂等和审计表；Auth拥有104会话入口表。Membership通过受控Org API获得机构/企业归属，Org通过Membership检查权限，Auth通过Membership检查成员；没有新增跨所有者外键或私表查询。内部API不接受浏览器Bearer替代服务身份。公开 `/api/v1/public/entry`仅返回安全品牌投影。

## 配置、部署与回退

配置样例默认全部关闭。分离gateway/business/worker配置；只有worker加载受限CF API Token文件。所需CF权限按授权账号/Zone限制：Zone读取、DNS读取/编辑、专用Tunnel配置读取；Zone创建另行授权并默认关闭。不要使用全局Key，不将真实账号、域名、NS或Token提交。

先迁移100/102/103/104及最小角色权限，再部署兼容服务。根据实际端口填写六服务URL；专用远程Tunnel catch-all必须指向机构网关且无更早匹配的拒绝/Host覆盖规则。保持Nginx与服务回环、内部路由仅私网，核对root平台Host精确白名单。先独立环境验证，再开启门禁、managed及automationReady；这些开关不替代实际路由/证书/源站隔离验收。

worker/gateway示例不自动安装用户、赋予全局权限或改动实际CF。回退保持已有入口隔离和当前代次，不可恢复到不含门禁的旧版本；保留快照、任务、素材和审计，停止新接入可关闭managed但不能关闭仍在使用的隔离门禁。

## 验证与交付边界

已在隔离PostgreSQL验证命令幂等、并发占用、租约、过期结果、停用及清理，以及真实Auth handler登录、跨域会话、工作区过滤、原子写入回滚。mock验证托管自动TXT、NS等待、活跃所有权丢失、SSRF及凭据不跟随跳转；网关测试验证候选探测和业务拒绝、内部路由阻断与Host转发；Shared测试验证错误分层、入口门禁与签名范围/时效。

真实CF账号/NS/证书及源站防绕过未验收，没有修改生产DNS。Agent Executor包含Linux专用文件系统测试，macOS完整测试不通过，须在Linux验收。浏览器交互、并发下完整六服务与网关链路、实际数据规模和独立安全评审尚待完成。本PR保持草稿，不能宣称端到端生产可用。
