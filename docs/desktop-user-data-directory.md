# 客户端数据目录隔离

同时运行多个项目的 AiCRM 客户端时，可以通过环境变量 `AICRM_USER_DATA_DIR` 为每个项目指定独立的数据目录，避免共享客户端数据和单实例锁。

该变量必须是绝对路径。客户端会创建目录，并在申请单实例锁前将其设为 Electron 的 `userData` 目录；相对路径会导致启动报错。

例如在 macOS 本地开发时：

```bash
AICRM_USER_DATA_DIR="$HOME/Library/Application Support/AiCRM-Project-Test" \
  pnpm --filter @ky/aicrm-desktop preview --skipBuild
```

使用 `--skipBuild` 前须先构建客户端。首次使用独立目录时，不会自动迁移其他目录中的登录态、缓存或本地配置。需要保持同一项目的数据时，应在后续启动中继续使用同一路径。

未设置该变量时保持原有行为：优先使用已存在的历史数据目录，否则使用应用默认目录。本变更不需要数据库迁移，也不改变服务端配置；取消该环境变量即可恢复原有目录选择方式。
