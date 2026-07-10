# 矩阵账号 AI 登录编排契约

## 1. 目标

业务只操作“新增平台账号”用例，不直接接触浏览器 Partition、Cookie、Storage、脚本 DSL、脚本版本或快照路径。

AI 负责维护平台适配方法的可用性；账号凭证、登录空间和加密快照始终留在可信桌面运行时，不进入 AI 上下文。

## 2. 四层职责

| 层级 | 责任 | 不允许承担的责任 |
| --- | --- | --- |
| 业务用例层 | 开始登录、取码、刷新、订阅状态、确认绑定、取消、重试 | 直接执行脚本、读取凭证、管理 Partition |
| LoginAttempt 编排层 | 持久化状态机、幂等命令、事件游标、权限与绑定决策 | 保存二维码原文、Cookie、Storage |
| 平台适配层 | 执行版本化方法并返回强类型脱敏结果 | 决定账号归属、直接写业务账号 |
| 可信桌面/Vault | 隔离 WebSpace、持有登录态、封存/校验/恢复/清理快照 | 把明文凭证或快照交给业务页面、服务端或 AI |

## 3. 业务接口与运行时方法映射

| 业务动作 | 业务接口 | 平台/运行时方法 | 业务结果 |
| --- | --- | --- | --- |
| 开始新增账号 | `startAccountOnboarding` | `login.open.v1` → `login.qr.get.v1` | Attempt 与二维码版本 |
| 获取二维码 | `getLoginQrCode` | 读取当前内存二维码投影 | `revision + dataUrl + observedAt` |
| 刷新二维码 | `refreshLoginQrCode` | `login.qr.refresh.v1` → `login.qr.get.v1` | 新二维码版本，旧版本失效 |
| 订阅登录状态 | `subscribeAccountOnboarding` | `login.status.probe.v1` | 有序事件与下一步动作 |
| 获取账号信息 | 自动编排 | `account.identity.get.v1` → `account.profile.get.v1` | 稳定身份与公开资料候选 |
| 确认业务绑定 | `confirmAccountBinding` | `business.binding.confirm.v1` | 绑定决策进入快照阶段 |
| 封存登录态 | 可信运行时内部调用 | `session.snapshot.seal.v1` | 快照 ID、摘要和验签凭证 |
| 完成新增账号 | 可信运行时内部调用 | `business.onboarding.complete.v1` | 原子绑定账号、Session、快照和 WebSpace |
| 取消流程 | `cancelAccountOnboarding` | `web_space.cleanup.v1` | 物理清理成功后才标记 cancelled |
| 账号后续能力 | `executeAccountCapability` | 版本化 capability 方法 | 统一任务结果与错误模型 |

## 4. LoginAttempt 规则

- Attempt 是业务唯一真相；页面刷新和桌面重启后从 Attempt 与事件游标恢复。
- 创建、刷新、重试、取消和步骤结果必须携带幂等标识。
- 刷新二维码使用 `expectedRevision`，重试使用 `expectedSequence`，冲突时返回最新状态。
- 事件按 Attempt 内单调递增 sequence 拉取；分页返回本页最后 sequence 与 `hasMore`。
- 取消采用 `cancel requested → cleanup pending → trusted cleanup receipt → cancelled`，不能先把服务端直接改成 cancelled。
- WebSpace 一旦由 Attempt 接管，旧 detect/bind/abandon/clear 接口永久不得处理它。

## 5. 方法输出契约

- `login.qr.*` 只返回是否可读、二维码版本、摘要和过期信息；二维码原文只在桌面内存与业务展示链路短暂存在。
- `login.status.probe.v1` 只返回标准阶段：waiting scan、authenticated、verification required、risk controlled、expired 等。
- `account.identity.get.v1` 只接受稳定平台身份；`sessionid`、`uid_tt`、Token、Cookie 不能作为身份。
- `account.profile.get.v1` 只能补充昵称、头像、主页等公开资料，不能覆盖已确认 identity。
- 失败、超时和取消结果不保存局部方法输出，只保存有界机器错误码。
- URL 在服务端去除 query/fragment，并拒绝非 HTTP(S) 或带用户凭据的地址。

## 6. AI 维护闭环

目标闭环：

1. 运行时按方法契约执行当前 active 版本。
2. 缺方法、页面变化或契约失败时，Attempt 进入 `repairing_adapter`。
3. AI 仅接收脱敏 DOM 投影、页面指纹、错误码和允许的截图；默认不发送截图。
4. AI 生成 candidate 版本，禁止任意 JavaScript、Cookie、Storage、IndexedDB 和凭证读取。
5. candidate 在隔离空间做契约测试，成功后才激活。
6. 编排器以新的 `attempt_no` 重试原方法并继续原 Attempt。
7. 失败版本可回滚；版本、测试和激活过程必须可审计。

## 7. 快照和恢复

- 桌面 Vault 对完整 Session storage path 做流式 tar+gzip 和 AES-256-GCM 加密。
- 每个快照使用独立数据密钥，本机主密钥只用于包裹数据密钥，权限为 `0600`。
- manifest 绑定 Attempt、WebSpace、工作区、平台、设备、内容摘要和运行时指纹。
- 恢复必须进入新 Partition，不覆盖来源空间；校验失败不删除来源。
- 只有服务端验证过、绑定 Attempt/snapshot/device/hash、短期且单次消费的 receipt 才能完成业务绑定。

## 8. 当前启用门禁

本轮仅交付安全基础设施，自动化新链路保持关闭：

- `supportsSessionDetection = false`
- `supportsServerVerifiableSnapshotReceipts = false`
- 后端无条件拒绝 `business.onboarding.complete.v1`

页面只有在登录检测、快照 Vault、业务编排和服务端验签四项能力同时为真时才切换新链路，否则完整使用 legacy 流程，禁止半链路混用。

## 9. 上线前必须完成

1. 实现持续登录探测和 identity/profile 的可信高层输出。
2. 实现服务端可验、短期、一次性 snapshot receipt；不得增加“跳过验签”生产开关。
3. 完成 AI candidate → 隔离测试 → 激活 → 原 Attempt 续跑闭环。
4. 用公开 DOM/主页身份方法替换现网读取 `sessionid`、`uid_tt`、`localStorage all` 的抖音脚本，并完成真实登录回归。
5. 实现 Attempt 过期后的持久化状态转换和 WebSpace 清理协调。
6. 增加 PostgreSQL 幂等、权限、并发、分页、过期、验签和事务故障测试。

