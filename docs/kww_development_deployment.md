# kww 开发环境部署

服务器工作区为 `/data/kww.org.cn/aicrm`，运行目录为 `/data/kww.org.cn/runtime`。部署由现有 `kww` 会话中的服务器 Codex 执行。Web 和 API 共用 `http://127.0.0.1:18180`，不配置公网域名或 TLS。

Mac 通过 `ssh -N -L 18180:127.0.0.1:18180 code-work` 访问该入口。客户端仅需要此 Web/API 地址，不得复制服务器数据库配置或密钥。

## 服务与状态

| systemd 单元 | 回环端口 | 部署状态 |
| --- | --- | --- |
| `kww-web.service` | 18180 | Web 静态文件与同源 API、SSE 转发 |
| `kww-auth.service` | 18081 | 认证和 bootstrap |
| `kww-org.service` | 18082 | 组织、设置和工作台 |
| `kww-membership.service` | 18083 | 成员、权限、通知和审计 |
| `kww-matrix-account.service` | 18085 | 矩阵账号 |
| `kww-ai-model.service` | 18086 | 模型配置及迁移期旧执行器路由 |
| `kww-agent-executor.service` | 18087 | `shadow_read_only`；缺专用只读数据库凭据，readyz 为 503 |
| `kww-runtime-broker.service`、`.socket` | `/run/kww-agent-runtime.sock` | 运行代理，未启动 AI 执行任务 |

`kww-dev.target` 管理整组服务并已设置开机启动。五个业务服务 readyz 为 200；执行器写入和脚本维护能力保持关闭，不复用 `kwwcrm` 业务账号，也不将控制面公开路由切换到 18087。

## 配置与凭据

以下文件均为 `root:root 0600`，内容不进入 Git、构建输出或客户端：

- `/etc/kww/database.env`：已初始化数据库的连接配置。
- `/etc/kww/runtime.env`：随机认证、AI/设置加密、内部服务密钥，以及业务服务回环地址。
- `/etc/kww/executor.env`：执行器独立运行配置，写入开关为 false。
- `/etc/kww/bootstrap-admin.env`：`Super.Admin` 初始随机密码，仅用于管理员占位的一次性初始化；已有有效密码不能覆盖。
- 仓库 `.env`：保留数据库配置，`KY_RUNTIME_ENV_FILE` 指向 `/etc/kww/runtime.env`，无自引用。

systemd 由管理器读取 `EnvironmentFile` 后注入非 root 服务进程；应用不需要直接读取 root 配置文件。`/etc/profile.d/kww-database.sh` 仅为 root 登录 shell 加载数据库环境。不要通过 `env`、`systemctl show -p Environment` 或输出完整 HTTP 登录响应查看凭据。

## 构建与更新

隔离工具链位于 `/opt/kww/toolchain`；不修复系统已有的无关 Node 包依赖。构建命令：

```bash
export PATH=/opt/kww/toolchain/go/bin:/opt/kww/toolchain/npm/node_modules/.bin:/usr/local/bin:/usr/bin:/bin
export GOMODCACHE=/opt/kww/toolchain/gomod
export KY_CODEX_BINARY=/opt/kww/toolchain/npm/node_modules/.bin/codex
bash scripts/build_services.sh
bash scripts/build_frontend.sh
python3 scripts/test_kww_nginx.py
```

服务构建必须通过原协议锁校验：Codex CLI `0.144.1`。仅运行 schema 生成器，不创建 AI 会话。Web 构建使用冻结锁文件，先生成 Core 类型声明，再执行类型检查、现有测试和 Vite 构建。

`ops/kww/` 保存本环境的 systemd 和 Nginx 配置；安装到 `/etc/systemd/system/` 和 `/etc/kww/nginx/nginx.conf`。二进制位于运行目录的 `bin/`，静态资源位于 `www/ky-admin-host/`。更新时保留上一版产物、核验 Nginx 配置后再重启本项目服务，不能直接运行面向 `/data/kyai_crm` 的原部署模板。

## 验证与运维

```bash
python3 scripts/verify_kww_dev.py
systemctl status 'kww-*.service' --no-pager
journalctl -u kww-auth.service -n 50 --no-pager
systemctl stop kww-dev.target
systemctl start kww-dev.target
```

如需取消开机启动：`systemctl disable kww-dev.target`。停止目标会连同各服务和 broker socket 一并停止。

Nginx 日志：`/var/log/kww/nginx-access.log`、`/var/log/kww/nginx-error.log`；访问日志不记录请求路径、查询串或认证头。构建记录保存在 `/var/log/kww/build/`。

本次通过全部 Go 包现有测试、Web 类型检查、52 项 Web 相关测试、190 条源码路由配置核验及真实登录/bootstrap/API/鉴权冒烟。需要独立测试数据库或真实 AI 授权的集成测试未启用；未调用外部 AI、存储、短信或邮件服务。SSE 已检查代理配置和鉴权路由，真实任务事件流尚未验证。Web 主 JS 包较大，Vite 给出体积提醒，不影响本次开发部署。
