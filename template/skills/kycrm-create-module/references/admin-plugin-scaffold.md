# 后台插件脚手架

## 创建命令

最小命令：

```bash
scripts/create_admin_plugin.sh \
  --slug customer-management \
  --title 客户管理
```

注册到 admin host：

```bash
scripts/create_admin_plugin.sh \
  --slug customer-management \
  --title 客户管理 \
  --nav-group CRM \
  --nav-order 70 \
  --route-path /customers \
  --icon TeamOutlined \
  --permission-prefix platform.customers \
  --register-host
```

## 参数说明

| 参数 | 含义 | 默认值 |
| --- | --- | --- |
| `--slug` | 模块 slug，小写短横线 | 必填 |
| `--title` | 菜单和页面中文标题 | 必填 |
| `--nav-group` | 左侧导航分组 | 默认等于 title |
| `--nav-order` | 导航排序 | `80` |
| `--route-path` | 页面路由 | `/<slug>` |
| `--icon` | Ant Design 图标名称 | `AppstoreOutlined` |
| `--permission-prefix` | 权限前缀 | `platform.<slug 下划线>` |
| `--package-scope` | NPM scope | `@ky` |
| `--plugin-dir-prefix` | 插件目录前缀 | `ky` |
| `--register-host` | 注册到 admin host | 默认不注册 |
| `--dry-run` | 只预览计划 | 默认写文件 |

## 生成内容

脚本生成：

```text
plugins/ky-<slug>/
├── package.json
├── tsconfig.json
└── src/
    ├── api.ts
    ├── index.tsx
    ├── permissions.ts
    ├── routes.tsx
    └── pages/
        └── <slug>-page.tsx
```

启用 `--register-host` 时还会更新：

```text
apps/ky-admin-host/package.json
apps/ky-admin-host/src/local-plugin-manifest.ts
```

## 生成后要求

- 先保留脚手架占位数据，不直接假设后端接口已经存在。
- 接入真实接口时再替换 `api.ts`、query key、表格字段和批量操作。
- 新增权限点必须同步权限矩阵、seed 或后端权限资源。
- 新增菜单必须确保 `menuKey` 与 `requiredPermission` 对齐。
