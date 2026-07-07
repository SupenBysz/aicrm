# KyaiCRM 贡献规范

本仓库采用主平台 monorepo 方式管理。仓库规划、分支策略、提交规范、标签策略和拆仓原则以以下文档为准：

```text
docs/kyai_crm_git_repository_governance.md
```

基础规则：

1. 主分支固定为 `main`。
2. 功能分支使用 `feature/*`，修复分支使用 `fix/*`，紧急修复使用 `hotfix/*`。
3. 提交信息推荐使用 Conventional Commits，例如 `feat: add member creation flow`。
4. 数据库、接口、权限、路由和部署脚本变更必须同步更新相关文档或说明。
5. 不提交真实密钥、客户数据、本地缓存、构建产物和临时日志。

合入前按变更范围执行必要验证。常用命令：

```bash
pnpm typecheck
pnpm build
go test ./...
```
