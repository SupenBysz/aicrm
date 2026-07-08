#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PLUGIN_SLUG=""
TITLE=""
NAV_GROUP=""
NAV_ORDER="80"
ROUTE_PATH=""
ICON="AppstoreOutlined"
PERMISSION_PREFIX=""
PACKAGE_SCOPE="@ky"
PLUGIN_DIR_PREFIX="ky"
REGISTER_HOST=0
DRY_RUN=0

usage() {
  cat <<'EOF'
创建 KyCRM 后台管理插件脚手架。

用法：
  scripts/create_admin_plugin.sh --slug <slug> --title <中文标题> [options]

参数：
  --slug <slug>              插件业务 slug，例如 customer-management。
  --title <name>             页面和菜单中文标题，例如 客户管理。
  --nav-group <name>         左侧导航分组，默认使用 title。
  --nav-order <number>       导航分组排序，默认 80。
  --route-path <path>        路由路径，默认 /<slug>。
  --icon <AntdIconName>      菜单图标名称，默认 AppstoreOutlined。
  --permission-prefix <key>  权限前缀，默认 platform.<slug 下划线形式>。
  --package-scope <scope>    NPM scope，默认 @ky。
  --plugin-dir-prefix <pre>  插件目录前缀，默认 ky。
  --register-host            同步注册到 apps/ky-admin-host。
  --dry-run                  只打印计划，不写文件。
  -h, --help                 显示帮助信息。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug)
      PLUGIN_SLUG="${2:-}"
      shift 2
      ;;
    --title)
      TITLE="${2:-}"
      shift 2
      ;;
    --nav-group)
      NAV_GROUP="${2:-}"
      shift 2
      ;;
    --nav-order)
      NAV_ORDER="${2:-}"
      shift 2
      ;;
    --route-path)
      ROUTE_PATH="${2:-}"
      shift 2
      ;;
    --icon)
      ICON="${2:-}"
      shift 2
      ;;
    --permission-prefix)
      PERMISSION_PREFIX="${2:-}"
      shift 2
      ;;
    --package-scope)
      PACKAGE_SCOPE="${2:-}"
      shift 2
      ;;
    --plugin-dir-prefix)
      PLUGIN_DIR_PREFIX="${2:-}"
      shift 2
      ;;
    --register-host)
      REGISTER_HOST=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数：$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$PLUGIN_SLUG" || -z "$TITLE" ]]; then
  echo "必须提供 --slug 和 --title。" >&2
  usage >&2
  exit 2
fi

if [[ ! "$PLUGIN_SLUG" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "--slug 必须使用小写字母、数字和短横线，例如 customer-management。" >&2
  exit 2
fi

if [[ ! "$PACKAGE_SCOPE" =~ ^@[a-z0-9._-]+$ ]]; then
  echo "--package-scope 必须是合法 NPM scope，例如 @ky。" >&2
  exit 2
fi

if [[ ! "$PLUGIN_DIR_PREFIX" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "--plugin-dir-prefix 必须使用小写字母、数字和短横线。" >&2
  exit 2
fi

if [[ ! "$NAV_ORDER" =~ ^[0-9]+$ ]]; then
  echo "--nav-order 必须是数字。" >&2
  exit 2
fi

[[ -n "$NAV_GROUP" ]] || NAV_GROUP="$TITLE"
[[ -n "$ROUTE_PATH" ]] || ROUTE_PATH="/$PLUGIN_SLUG"

if [[ ! "$ROUTE_PATH" =~ ^/[a-z0-9][a-z0-9/-]*$ ]]; then
  echo "--route-path 必须以 / 开头，并只包含小写字母、数字、短横线和斜线。" >&2
  exit 2
fi

RESOURCE_KEY="${PLUGIN_SLUG//-/_}"
[[ -n "$PERMISSION_PREFIX" ]] || PERMISSION_PREFIX="platform.$RESOURCE_KEY"

PLUGIN_DIR_NAME="$PLUGIN_DIR_PREFIX-$PLUGIN_SLUG"
PLUGIN_DIR="$ROOT_DIR/plugins/$PLUGIN_DIR_NAME"
PACKAGE_NAME="$PACKAGE_SCOPE/plugin-$PLUGIN_SLUG"
PAGE_FILE_BASENAME="$PLUGIN_SLUG-page"

if [[ -e "$PLUGIN_DIR" ]]; then
  echo "插件目录已存在：$PLUGIN_DIR" >&2
  exit 2
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  cat <<EOF
将创建后台插件：
  插件目录：plugins/$PLUGIN_DIR_NAME
  NPM 包名：$PACKAGE_NAME
  插件标题：$TITLE
  导航分组：$NAV_GROUP
  导航排序：$NAV_ORDER
  路由路径：$ROUTE_PATH
  菜单图标：$ICON
  权限前缀：$PERMISSION_PREFIX
  注册 Host：$REGISTER_HOST
EOF
  exit 0
fi

node - "$ROOT_DIR" "$PLUGIN_SLUG" "$TITLE" "$NAV_GROUP" "$NAV_ORDER" "$ROUTE_PATH" "$ICON" "$PERMISSION_PREFIX" "$PACKAGE_SCOPE" "$PLUGIN_DIR_PREFIX" "$REGISTER_HOST" <<'NODE'
const fs = require("fs");
const path = require("path");

const [
  root,
  slug,
  title,
  navGroup,
  navOrderRaw,
  routePath,
  icon,
  permissionPrefix,
  packageScope,
  pluginDirPrefix,
  registerHostRaw
] = process.argv.slice(2);

const registerHost = registerHostRaw === "1";
const navOrder = Number(navOrderRaw);
const pluginDirName = `${pluginDirPrefix}-${slug}`;
const pluginDir = path.join(root, "plugins", pluginDirName);
const packageName = `${packageScope}/plugin-${slug}`;
const parts = slug.split("-");
const pascal = parts.map((part) => part[0].toUpperCase() + part.slice(1)).join("");
const camel = pascal[0].toLowerCase() + pascal.slice(1);
const pageName = `${pascal}Page`;
const pageFile = `${slug}-page`;
const routeKey = `${pluginDirName}.main`;
const routeQueryKey = `${slug}-placeholder`;
const permissionConst = `${camel}Permissions`;
const safeTitleLiteral = JSON.stringify(title);
const safeNavGroupLiteral = JSON.stringify(navGroup);
const safeIconLiteral = JSON.stringify(icon);

function writeFile(relativePath, content) {
  const target = path.join(pluginDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content.replace(/\n+$/g, "") + "\n");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

fs.mkdirSync(pluginDir, { recursive: true });

writeJson(path.join(pluginDir, "package.json"), {
  name: packageName,
  version: "0.1.0",
  private: true,
  type: "module",
  main: "dist/index.js",
  types: "dist/index.d.ts",
  scripts: {
    build: "tsc -p tsconfig.json",
    lint: "tsc -p tsconfig.json --noEmit",
    typecheck: "tsc -p tsconfig.json --noEmit"
  },
  dependencies: {
    "@ky/admin-core": "workspace:*"
  },
  peerDependencies: {
    "@ant-design/icons": "^6.0.0",
    "@tanstack/react-query": "^5.0.0",
    antd: "^6.0.0",
    react: "^19.0.0",
    "react-router-dom": "^7.0.0"
  },
  devDependencies: {
    "@ant-design/icons": "^6.3.2",
    "@tanstack/react-query": "^5.101.2",
    "@types/react": "^19.2.17",
    antd: "^6.5.0",
    react: "^19.2.7",
    "react-router-dom": "^7.18.1",
    typescript: "^6.0.3"
  }
});

writeFile("tsconfig.json", `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "declaration": true,
    "rootDir": "src",
    "outDir": "dist",
    "skipLibCheck": true
  },
  "include": ["src"]
}
`);

writeFile("src/permissions.ts", `export const pluginName = "${pluginDirName}";

export const ${permissionConst} = {
  view: "${permissionPrefix}.view",
  create: "${permissionPrefix}.create",
  update: "${permissionPrefix}.update",
  delete: "${permissionPrefix}.delete"
} as const;

export const permissions = Object.values(${permissionConst});
`);

writeFile("src/api.ts", `import type { RequestClient } from "@ky/admin-core";

export interface ${pascal}Record {
  id: string;
  name: string;
  status: "enabled" | "disabled";
  updatedAt: string;
}

export interface ${pascal}ListResponse {
  items: ${pascal}Record[];
  total: number;
}

export interface ${pascal}ListParams {
  page: number;
  pageSize: number;
  keyword?: string;
  status?: string;
}

export function list${pascal}Records(client: RequestClient, params: ${pascal}ListParams): Promise<${pascal}ListResponse> {
  const query = new URLSearchParams();
  query.set("page", String(params.page));
  query.set("pageSize", String(params.pageSize));
  if (params.keyword) query.set("keyword", params.keyword);
  if (params.status) query.set("status", params.status);

  return client.request<${pascal}ListResponse>(\`/api/v1/${slug}?\${query.toString()}\`);
}
`);

writeFile(`src/pages/${pageFile}.tsx`, `import { useMemo, useState, type Key } from "react";
import { Button, Input, Segmented, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ListPageCard, usePermissions } from "@ky/admin-core";
import { ${permissionConst} } from "../permissions";

interface ${pascal}Row {
  id: string;
  name: string;
  status: "enabled" | "disabled";
  updatedAt: string;
}

const STATUS_OPTIONS = [
  { value: "", label: "全部" },
  { value: "enabled", label: "启用" },
  { value: "disabled", label: "停用" }
];

const PLACEHOLDER_ROWS: ${pascal}Row[] = [];

export function ${pageName}() {
  const permissions = usePermissions();
  const [keywordInput, setKeywordInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);

  const canCreate = permissions.can(${permissionConst}.create);
  const selectedRows = useMemo(
    () => PLACEHOLDER_ROWS.filter((row) => selectedRowKeys.includes(row.id)),
    [selectedRowKeys]
  );
  const rows = useMemo(
    () =>
      PLACEHOLDER_ROWS.filter((row) => {
        const keywordMatched = keyword ? row.name.includes(keyword) : true;
        const statusMatched = status ? row.status === status : true;
        return keywordMatched && statusMatched;
      }),
    [keyword, status]
  );

  function resetSelection() {
    setSelectedRowKeys([]);
  }

  const columns: ColumnsType<${pascal}Row> = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      width: 220,
      render: (value: string) => <Typography.Text strong>{value}</Typography.Text>
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 120,
      render: (value: ${pascal}Row["status"]) =>
        value === "enabled" ? <Tag color="green">启用</Tag> : <Tag color="default">停用</Tag>
    },
    {
      title: "更新时间",
      dataIndex: "updatedAt",
      key: "updatedAt",
      width: 180,
      render: (value: string) => (value ? new Date(value).toLocaleString("zh-CN") : "—")
    },
    {
      title: "操作",
      key: "actions",
      className: "table-action-column",
      fixed: "right",
      width: 180,
      render: () => (
        <Space className="table-action-grid" size={4} wrap>
          <Button size="small" type="link">
            详情
          </Button>
          <Button size="small" type="link">
            编辑
          </Button>
        </Space>
      )
    }
  ];

  return (
    <ListPageCard
      title={${safeTitleLiteral}}
      subtitle={
        selectedRowKeys.length > 0 ? (
          <Space size={8}>
            <Typography.Text type="secondary">已选择 {selectedRowKeys.length} 项</Typography.Text>
            <Button size="small" type="link" onClick={resetSelection}>
              清空选择
            </Button>
          </Space>
        ) : (
          "请在接入真实接口后替换占位数据、权限和批量操作。"
        )
      }
      toolbar={
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="输入关键词"
            style={{ width: 240 }}
            value={keywordInput}
            onChange={(event) => setKeywordInput(event.target.value)}
            onSearch={(value) => {
              resetSelection();
              setKeyword(value.trim());
            }}
          />
          <Segmented
            className="list-status-segmented"
            options={STATUS_OPTIONS}
            value={status}
            onChange={(value) => {
              resetSelection();
              setStatus(String(value));
            }}
          />
        </Space>
      }
      extra={
        <Space wrap>
          {selectedRows.length > 0 ? <Button disabled>批量操作</Button> : null}
          {canCreate ? <Button type="primary">新建</Button> : null}
        </Space>
      }
    >
      <Table<${pascal}Row>
        rowKey="id"
        columns={columns}
        dataSource={rows}
        pagination={{ pageSize: 10, showSizeChanger: true }}
        rowSelection={{
          selectedRowKeys,
          onChange: (keys) => setSelectedRowKeys(keys)
        }}
        scroll={{ x: 900 }}
      />
    </ListPageCard>
  );
}
`);

writeFile("src/routes.tsx", `import type { PluginRoute } from "@ky/admin-core";
import { ${pageName} } from "./pages/${pageFile}";
import { ${permissionConst} } from "./permissions";

export const routes: PluginRoute[] = [
  {
    path: "${routePath}",
    requiredPermission: ${permissionConst}.view,
    element: <${pageName} />
  }
];
`);

writeFile("src/index.tsx", `import type { AdminPlugin } from "@ky/admin-core";
import { routes } from "./routes";
import { ${permissionConst} } from "./permissions";

export const ${camel}Plugin: AdminPlugin = {
  name: "${pluginDirName}",
  navGroup: ${safeNavGroupLiteral},
  navOrder: ${navOrder},
  menus: [
    {
      key: "${routeKey}",
      label: ${safeTitleLiteral},
      path: "${routePath}",
      icon: ${safeIconLiteral},
      menuKey: ${permissionConst}.view,
      requiredPermission: ${permissionConst}.view
    }
  ],
  routes
};

export default ${camel}Plugin;
`);

if (registerHost) {
  const hostPackagePath = path.join(root, "apps", "ky-admin-host", "package.json");
  const hostPackage = readJson(hostPackagePath);
  hostPackage.dependencies = hostPackage.dependencies || {};
  hostPackage.dependencies[packageName] = "workspace:*";
  writeJson(hostPackagePath, hostPackage);

  const manifestPath = path.join(root, "apps", "ky-admin-host", "src", "local-plugin-manifest.ts");
  let manifest = fs.readFileSync(manifestPath, "utf8");
  const importLine = `import { ${camel}Plugin } from "${packageName}";`;
  if (!manifest.includes(importLine)) {
    const lines = manifest.split("\n");
    const lastImportIndex = lines.reduce((last, line, index) => (line.startsWith("import ") ? index : last), -1);
    lines.splice(lastImportIndex + 1, 0, importLine);
    manifest = lines.join("\n");
  }

  const localPluginsArray = manifest.match(/export const localPlugins: AdminPlugin\[] = \[([\s\S]*?)\n\];/);
  if (localPluginsArray && !localPluginsArray[1].includes(`${camel}Plugin`)) {
    manifest = manifest.replace(/\n\];/, `,\n  ${camel}Plugin\n];`);
  }

  fs.writeFileSync(manifestPath, manifest);
}

console.log(`已创建后台插件：plugins/${pluginDirName}`);
console.log(`NPM 包名：${packageName}`);
console.log(`路由路径：${routePath}`);
if (registerHost) {
  console.log("已注册到 apps/ky-admin-host。");
}
NODE

cat <<EOF
建议执行：
  pnpm --filter "$PACKAGE_NAME" typecheck
EOF

if [[ "$REGISTER_HOST" -eq 1 ]]; then
  cat <<'EOF'
  pnpm --filter @ky/admin-host typecheck
EOF
fi
