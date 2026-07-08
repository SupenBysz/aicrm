# 模块创建验证清单

## 脚本校验

```bash
bash -n scripts/create_admin_plugin.sh
bash -n scripts/create_business_module.sh
git diff --check
python3 /root/.codex/skills/.system/skill-creator/scripts/quick_validate.py template/skills/kycrm-create-module
```

## Dry-run

```bash
scripts/create_admin_plugin.sh \
  --slug customer-management \
  --title 客户管理 \
  --dry-run

scripts/create_business_module.sh \
  --slug customer-management \
  --title 客户管理 \
  --fields "customerNo:string:客户编号,level:string:客户等级,amount:number:成交金额" \
  --workspace-types enterprise \
  --nav-group CRM \
  --route-path /customers \
  --api-base /api/v1/customers \
  --http-port 18101 \
  --dry-run
```

## 临时项目验证

建议在临时生成项目中验证脚手架，避免污染当前仓库：

```bash
rm -rf /tmp/kycrm-plugin-smoke
scripts/create_project_from_template.sh --output /tmp/kycrm-plugin-smoke
/tmp/kycrm-plugin-smoke/scripts/create_admin_plugin.sh \
  --slug customer-management \
  --title 客户管理 \
  --nav-group CRM \
  --nav-order 70 \
  --route-path /customers \
  --icon TeamOutlined \
  --permission-prefix platform.customers \
  --register-host
```

## Typecheck 验证

全新模板项目需要先安装依赖并构建 admin core：

```bash
pnpm --dir /tmp/kycrm-plugin-smoke install
pnpm --dir /tmp/kycrm-plugin-smoke --filter @ky/admin-core build
pnpm --dir /tmp/kycrm-plugin-smoke --filter @ky/plugin-customer-management typecheck
pnpm --dir /tmp/kycrm-plugin-smoke --filter @ky/plugin-customer-management build
pnpm --dir /tmp/kycrm-plugin-smoke --filter @ky/admin-host typecheck
```

如果未注册 host，可以跳过插件 build 和 admin host typecheck。

## 完整业务模块验证

```bash
rm -rf /tmp/kycrm-business-smoke
scripts/create_project_from_template.sh --output /tmp/kycrm-business-smoke
/tmp/kycrm-business-smoke/scripts/create_business_module.sh \
  --slug customer-management \
  --title 客户管理 \
  --fields "customerNo:string:客户编号,level:string:客户等级,amount:number:成交金额,isVip:bool:VIP客户" \
  --workspace-types enterprise \
  --nav-group CRM \
  --route-path /customers \
  --api-base /api/v1/customers \
  --http-port 18101
```

执行：

```bash
go test ./services/ky-customer-management-service/...
go build -o /tmp/ky-customer-management-service /tmp/kycrm-business-smoke/services/ky-customer-management-service/cmd/server
scripts/build_services.sh
pnpm install
pnpm --filter @ky/admin-core build
pnpm --filter @ky/plugin-customer-management typecheck
pnpm --filter @ky/plugin-customer-management build
pnpm --filter @ky/admin-host typecheck
pnpm --filter @ky/admin-host build
```

注意：`scripts/validate_generated_project.sh` 用于检查干净生成目录。执行 `pnpm install` 或 build 后会出现 `node_modules`、`dist`、`out`，此时再运行该脚本会按预期失败。

## 人工检查

- 插件目录名、包名、导出变量符合命名规范。
- `routes.tsx` 路由和菜单 path 一致。
- `permissions.ts` 中 view/create/update/delete 权限前缀符合模块语义。
- 完整业务模块的 SQL 权限、前端权限和后端权限校验一致。
- 新服务已进入 `go.work`、`scripts/build_services.sh` 和 `scripts/deploy_services.sh`。
- Nginx location 已转发 Authorization 和 `X-KY-*` 请求头。
- 列表页标题在卡片外，筛选在 toolbar，状态筛选使用 `Segmented`。
- 操作列冻结在右侧，并使用 `table-action-grid`。
- 前端插件脚手架未接入真实接口前，不要提交伪造业务数据；完整业务模块脚手架可以保留空数据表和真实 API client。
