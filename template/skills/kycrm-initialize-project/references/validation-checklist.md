# 初始化验证清单

## 脚本和 Skill 校验

在模板源仓库执行：

```bash
bash -n scripts/create_project_from_template.sh
bash -n scripts/validate_generated_project.sh
bash -n scripts/create_admin_plugin.sh
bash -n scripts/create_business_module.sh
scripts/create_project_from_template.sh --help
git diff --check
python3 /root/.codex/skills/.system/skill-creator/scripts/quick_validate.py template/skills/aicrm-solution
python3 /root/.codex/skills/.system/skill-creator/scripts/quick_validate.py template/skills/kycrm-initialize-project
python3 /root/.codex/skills/.system/skill-creator/scripts/quick_validate.py template/skills/kycrm-create-module
```

## 默认生成验证

```bash
rm -rf /tmp/kycrm-template-default
scripts/create_project_from_template.sh --output /tmp/kycrm-template-default
scripts/validate_generated_project.sh /tmp/kycrm-template-default
```

检查：

```bash
test -f /tmp/kycrm-template-default/package.json
test -d /tmp/kycrm-template-default/apps/ky-admin-host
test -d /tmp/kycrm-template-default/apps/aicrm-desktop
```

## 自定义参数验证

```bash
rm -rf /tmp/kycrm-template-custom
scripts/create_project_from_template.sh \
  --output /tmp/kycrm-template-custom \
  --project-slug new-crm \
  --product-name NewCRM \
  --product-cn-name 新企CRM \
  --package-name new-crm \
  --admin-dir console \
  --admin-package @new/console \
  --admin-name 新企CRM管理后台 \
  --desktop-dir desktop \
  --desktop-package @new/desktop \
  --desktop-app-name "NewCRM Desktop"
```

检查：

```bash
test -d /tmp/kycrm-template-custom/apps/console
test -d /tmp/kycrm-template-custom/apps/desktop
rg -n '"name": "@new/console"' /tmp/kycrm-template-custom/apps/console/package.json
rg -n '"name": "@new/desktop"' /tmp/kycrm-template-custom/apps/desktop/package.json
rg -n "apps/[k]y-admin-host|apps/[a]icrm-desktop|@[k]y/admin-host|@[k]y/aicrm-desktop" /tmp/kycrm-template-custom -S -g '!node_modules'
```

最后一条 `rg` 应无输出；退出码为 1 表示没有匹配，属于预期。

也可以直接执行：

```bash
scripts/validate_generated_project.sh /tmp/kycrm-template-custom
```

## 配置文件验证

```bash
rm -rf /tmp/kycrm-template-config
scripts/create_project_from_template.sh --config template/examples/full-custom-apps.yaml --output /tmp/kycrm-template-config
scripts/validate_generated_project.sh /tmp/kycrm-template-config
```

## 交互式验证

在有 TTY 的环境中执行：

```bash
scripts/create_project_from_template.sh --interactive
```

确认提示、错误信息和生成摘要为中文，并确认输出目录内 `.template-generated.json` 记录了 app 目录、包名、显示名和说明。

## 敏感信息和本地产物扫描

对生成项目执行：

```bash
find /tmp/kycrm-template-default -type d \( -name node_modules -o -name dist -o -name out -o -name release -o -name .playwright-mcp \) -print
find /tmp/kycrm-template-default -type f \( -name '*.png' -o -name server \) -print
rg -n "Super\\.Admin|[e]ntai\\.im|[k]yaicrm|[c]loudflared|[G]lobal API Key|[t]oken-file|[t]unnel|Ky@123123|admin123456" /tmp/kycrm-template-default -S -g '!pnpm-lock.yaml'
```

这些扫描应无输出。`rg` 没有匹配时退出码为 1，属于预期。

## 构建验证

用户要求完整验证时，在生成项目内执行：

```bash
pnpm install
pnpm --filter "<管理后台包名>" typecheck
pnpm --filter "<桌面客户端包名>" typecheck
```

如果依赖安装耗时或网络不可用，应明确说明未执行完整构建验证，并保留已完成的脚本与静态检查结果。
