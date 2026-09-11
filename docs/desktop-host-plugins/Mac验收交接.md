# Mac 客户端宿主插件最终运行手册

本手册是当前唯一运行状态；早期交接记录见 [历史文档](Mac验收交接-历史-20260911.md)。本轮交付范围为阶段 1–3 的指定 macOS 开发环境，不扩展为正式发行支持。

## 最终证据与当前状态

- 同 PID 演示：`evidence/mac-final-same-pid-demo.json`
- 冻结清单：`evidence/final-freeze-v1.json`、`evidence/final-freeze-v2.json`、`evidence/final-freeze-rollback.json`
- 隔离扩展：`evidence/mac-isolation-extended-final.json`（28/28，全 true，退出 0）
- 生命周期与 React/footer：`evidence/mac-react-lifecycle-final.json`（生命周期 14 项、React 6 项及三种 footer 全 true，退出 0）

当前客户端 PID `22106`，启动时间在 v1→v2→回滚期间不变；宿主版本 `0.1.0`，当前插件 `1.0.0 stable`，`activeRevision=12`，`highWater=2`。v2 `1.1.0` 已完成两次 60 秒 stable 与真实按钮展开/收起，随后已原生回滚到 v1；登录工作台持续可见。三份冻结清单均为 1120 条目、三次差异 0，规范化摘要为 `e7bf62a69062dbae6692d637cf0e54a41c2781771863679b104160e6f6ce26fd`。

服务器当前托管 v1/v2 公共包，索引 `releaseSequence=2`；源固定为 `http://127.0.0.1:18180/desktop-plugin-releases/dev/`。Web 入口为 `http://127.0.0.1:18180/`，资源已冻结，不在本手册中重新构建或部署。

## 构建与启动

在本地仓库根目录执行：

```bash
pnpm --filter @ky/aicrm-desktop install --frozen-lockfile
pnpm --filter @ky/aicrm-desktop typecheck
KWW_DESKTOP_PLUGIN_BUILD=dev pnpm --filter @ky/aicrm-desktop build
AICRM_WEB_URL=http://127.0.0.1:18180 AICRM_API_BASE_URL=http://127.0.0.1:18180 pnpm --filter @ky/aicrm-desktop preview --skipBuild
```

`--skipBuild` 必须保留，避免 Electron-Vite 重建并覆盖已冻结 preload。开发信任仅在构建标记、`!app.isPackaged` 与 macOS 同时满足时启用；运行时 debug/defaultApp 不得放宽正式构建边界。

客户端仅通过 SSH 回环访问 Web/API：

```bash
ssh -N -L 18180:127.0.0.1:18180 code-work
```

不向本地分发数据库配置、服务器密钥或会话数据。

## 签名与公共源

开发公钥指纹：`sha256:3fed2a12f086954745aa222e84d74d5da2561252823f3db8e9872ffe64f5d288`。服务器只托管签名公共文件；私钥仅保存在本机专用目录，目录 `0700`、文件 `0600`，禁止复制到服务器、仓库、日志或报告。

签名工具示例（读取本地私钥但不输出秘密）：

```bash
node scripts/desktop-plugins/sign.mjs release \
  --private-key "$HOME/.local/share/kww-desktop-plugin-signing/dev/ed25519-private.pem" \
  --public-key /tmp/kww-desktop-plugin-dev-public-key.json \
  --source desktop-plugins/kww-status-bar/v2 \
  --output /tmp/kww-plugin-public --sequence 2
```

当前索引同时保留 v1 与 v2 包；不得替换已签源码或降低 `releaseSequence`。

## 故障复现与安全边界

原生菜单提供检查更新、回滚、状态快照、故障暂停点和候选 renderer 终止。状态输出只允许宿主/插件版本、digest、PID、phase、revision、高水位和安全错误码。

强杀验收只针对当前开发客户端且确认无账号/授权操作：在 `verified`、`activating`、`probation`、`stable` 四个持久化点分别记录状态后，对显示的测试 PID 执行：

```bash
kill -9 <测试客户端PID>
```

候选 renderer 使用原生菜单终止；重启后核对 `active`、`rollbackTarget`、`highWater` 与失败账本。不得删除状态文件、绕过 sender gate、禁用 sandbox、绕过钥匙串或把模拟故障当作物理断电实测。

隔离脚本：

```bash
node scripts/desktop-plugins/build-isolation.mjs
node scripts/desktop-plugins/run-isolation.mjs
```

独立脚本使用临时 userData 和合成会话，不读取真实账号。只有最终布尔结果全部为 true 且退出码为 0 才算该脚本通过。

## 覆盖限制

正式发行/公证与安装包升级、非 macOS、物理断电、阶段 4–5 不属于本轮。仍未完成的回归覆盖包括：全部业务 handler 的逐一实机负向矩阵、完整旧版二进制与旧 Web 组合、普通浏览器 HMR/长时压力、完整 OS 权限组合及正式多用户发布治理。当前证据不对这些范围作通过声明。

未提交、未推送；完整摘要见 [服务器交接-SHA256SUMS.txt](服务器交接-SHA256SUMS.txt)，增量摘要见 [本轮增量-SHA256SUMS.txt](本轮增量-SHA256SUMS.txt)。
