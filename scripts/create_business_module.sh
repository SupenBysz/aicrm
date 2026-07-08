#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SLUG=""
TITLE=""
FIELDS="remark:text:备注"
WORKSPACE_TYPES="platform"
NAV_GROUP=""
NAV_ORDER="80"
ROUTE_PATH=""
ICON="AppstoreOutlined"
API_BASE=""
SERVICE_NAME=""
HTTP_PORT="18100"
TABLE_NAME=""
PERMISSION_RESOURCE=""
PACKAGE_SCOPE="@ky"
PLUGIN_DIR_PREFIX="ky"
REGISTER_HOST=1
REGISTER_SERVICE=1
REGISTER_NGINX=1
DRY_RUN=0

usage() {
  cat <<'EOF'
创建 KyCRM 业务模块全链路脚手架。

用法：
  scripts/create_business_module.sh --slug <slug> --title <中文标题> [options]

参数：
  --slug <slug>                 业务模块 slug，例如 customer-management。
  --title <name>                页面、菜单和服务中文标题，例如 客户管理。
  --fields <spec>               字段规格，逗号分隔：field:type:label。
                                支持类型：string,text,int,number,bool。
                                默认：remark:text:备注。
  --workspace-types <list>      工作区类型，逗号分隔：platform,agency,enterprise。默认 platform。
  --nav-group <name>            前端导航分组，默认使用 title。
  --nav-order <number>          前端导航排序，默认 80。
  --route-path <path>           前端路由路径，默认 /<slug>。
  --icon <AntdIconName>         菜单图标名称，默认 AppstoreOutlined。
  --api-base <path>             API 基础路径，默认 /api/v1/<slug>。
  --service-name <name>         Go 服务名，默认 ky-<slug>-service。
  --http-port <port>            本地 HTTP 端口，默认 18100。
  --table-name <name>           数据表名，默认 ky_<slug 下划线>。
  --permission-resource <key>   权限资源名，默认 <slug 下划线>。
  --package-scope <scope>       NPM scope，默认 @ky。
  --plugin-dir-prefix <pre>     插件目录前缀，默认 ky。
  --skip-register-host          不注册到 apps/ky-admin-host。
  --skip-register-service       不写入 go.work、服务构建/部署脚本和 systemd unit。
  --skip-register-nginx         不写入 ops/native/ky-admin-host.nginx.conf。
  --dry-run                     只打印计划，不写文件。
  -h, --help                    显示帮助信息。

示例：
  scripts/create_business_module.sh \
    --slug customer-management \
    --title 客户管理 \
    --fields "customerNo:string:客户编号,level:string:客户等级,amount:number:成交金额" \
    --workspace-types enterprise \
    --nav-group CRM \
    --route-path /customers \
    --api-base /api/v1/customers \
    --http-port 18101
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug)
      SLUG="${2:-}"
      shift 2
      ;;
    --title)
      TITLE="${2:-}"
      shift 2
      ;;
    --fields)
      FIELDS="${2:-}"
      shift 2
      ;;
    --workspace-types)
      WORKSPACE_TYPES="${2:-}"
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
    --api-base)
      API_BASE="${2:-}"
      shift 2
      ;;
    --service-name)
      SERVICE_NAME="${2:-}"
      shift 2
      ;;
    --http-port)
      HTTP_PORT="${2:-}"
      shift 2
      ;;
    --table-name)
      TABLE_NAME="${2:-}"
      shift 2
      ;;
    --permission-resource)
      PERMISSION_RESOURCE="${2:-}"
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
    --skip-register-host)
      REGISTER_HOST=0
      shift
      ;;
    --skip-register-service)
      REGISTER_SERVICE=0
      shift
      ;;
    --skip-register-nginx)
      REGISTER_NGINX=0
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

if [[ -z "$SLUG" || -z "$TITLE" ]]; then
  echo "必须提供 --slug 和 --title。" >&2
  usage >&2
  exit 2
fi

if [[ ! "$SLUG" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "--slug 必须使用小写字母、数字和短横线，例如 customer-management。" >&2
  exit 2
fi

if [[ ! "$NAV_ORDER" =~ ^[0-9]+$ ]]; then
  echo "--nav-order 必须是数字。" >&2
  exit 2
fi

if [[ ! "$HTTP_PORT" =~ ^[0-9]+$ ]]; then
  echo "--http-port 必须是数字端口。" >&2
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

RESOURCE_KEY="${SLUG//-/_}"
[[ -n "$NAV_GROUP" ]] || NAV_GROUP="$TITLE"
[[ -n "$ROUTE_PATH" ]] || ROUTE_PATH="/$SLUG"
[[ -n "$API_BASE" ]] || API_BASE="/api/v1/$SLUG"
[[ -n "$SERVICE_NAME" ]] || SERVICE_NAME="ky-$SLUG-service"
[[ -n "$TABLE_NAME" ]] || TABLE_NAME="ky_$RESOURCE_KEY"
[[ -n "$PERMISSION_RESOURCE" ]] || PERMISSION_RESOURCE="$RESOURCE_KEY"

if [[ ! "$ROUTE_PATH" =~ ^/[a-z0-9][a-z0-9/-]*$ ]]; then
  echo "--route-path 必须以 / 开头，并只包含小写字母、数字、短横线和斜线。" >&2
  exit 2
fi

if [[ ! "$API_BASE" =~ ^/api/v1/[a-z0-9][a-z0-9/-]*$ ]]; then
  echo "--api-base 必须以 /api/v1/ 开头，并只包含小写字母、数字、短横线和斜线。" >&2
  exit 2
fi

if [[ ! "$SERVICE_NAME" =~ ^ky-[a-z0-9]+(-[a-z0-9]+)*-service$ ]]; then
  echo "--service-name 必须形如 ky-<slug>-service。" >&2
  exit 2
fi

if [[ ! "$TABLE_NAME" =~ ^ky_[a-z0-9_]+$ ]]; then
  echo "--table-name 必须以 ky_ 开头，并只包含小写字母、数字和下划线。" >&2
  exit 2
fi

if [[ ! "$PERMISSION_RESOURCE" =~ ^[a-z0-9_]+$ ]]; then
  echo "--permission-resource 只能包含小写字母、数字和下划线。" >&2
  exit 2
fi

node - "$FIELDS" "$WORKSPACE_TYPES" <<'NODE'
const [fieldsSpec, workspaceTypesRaw] = process.argv.slice(2);
const allowedTypes = new Set(["string", "text", "int", "number", "bool"]);
const reserved = new Set([
  "id",
  "name",
  "status",
  "workspaceType",
  "workspaceId",
  "createdBy",
  "updatedBy",
  "createdAt",
  "updatedAt",
  "deletedAt"
]);
const fields = fieldsSpec
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
for (const item of fields) {
  const [name, type, label] = item.split(":");
  if (!name || !type || !label) {
    throw new Error(`字段规格错误：${item}，应为 field:type:label`);
  }
  if (!/^[a-z][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`字段名不合法：${name}`);
  }
  if (reserved.has(name)) {
    throw new Error(`字段名是保留字段：${name}`);
  }
  if (!allowedTypes.has(type)) {
    throw new Error(`字段类型不支持：${type}`);
  }
}
const workspaceTypes = workspaceTypesRaw
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
if (!workspaceTypes.length) {
  throw new Error("至少提供一个工作区类型。");
}
for (const type of workspaceTypes) {
  if (!["platform", "agency", "enterprise"].includes(type)) {
    throw new Error(`工作区类型不支持：${type}`);
  }
}
NODE

PLUGIN_DIR_NAME="$PLUGIN_DIR_PREFIX-$SLUG"
PLUGIN_DIR="$ROOT_DIR/plugins/$PLUGIN_DIR_NAME"
SERVICE_DIR="$ROOT_DIR/services/$SERVICE_NAME"
PACKAGE_NAME="$PACKAGE_SCOPE/plugin-$SLUG"
FIRST_WORKSPACE_TYPE="${WORKSPACE_TYPES%%,*}"
FIRST_PERMISSION_PREFIX="$FIRST_WORKSPACE_TYPE.$PERMISSION_RESOURCE"

if [[ -e "$PLUGIN_DIR" ]]; then
  echo "插件目录已存在：$PLUGIN_DIR" >&2
  exit 2
fi

if [[ -e "$SERVICE_DIR" ]]; then
  echo "服务目录已存在：$SERVICE_DIR" >&2
  exit 2
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  cat <<EOF
将创建业务模块：
  模块 slug：$SLUG
  中文标题：$TITLE
  字段规格：$FIELDS
  工作区类型：$WORKSPACE_TYPES
  前端插件：plugins/$PLUGIN_DIR_NAME ($PACKAGE_NAME)
  前端路由：$ROUTE_PATH
  API 路径：$API_BASE
  Go 服务：services/$SERVICE_NAME
  服务端口：$HTTP_PORT
  数据表：$TABLE_NAME
  权限资源：$PERMISSION_RESOURCE
  注册 Host：$REGISTER_HOST
  注册服务：$REGISTER_SERVICE
  注册 Nginx：$REGISTER_NGINX
EOF
  exit 0
fi

plugin_args=(
  "$ROOT_DIR/scripts/create_admin_plugin.sh"
  --slug "$SLUG"
  --title "$TITLE"
  --nav-group "$NAV_GROUP"
  --nav-order "$NAV_ORDER"
  --route-path "$ROUTE_PATH"
  --icon "$ICON"
  --permission-prefix "$FIRST_PERMISSION_PREFIX"
  --package-scope "$PACKAGE_SCOPE"
  --plugin-dir-prefix "$PLUGIN_DIR_PREFIX"
)

if [[ "$REGISTER_HOST" -eq 1 ]]; then
  plugin_args+=(--register-host)
fi

"${plugin_args[@]}"

node - \
  "$ROOT_DIR" \
  "$SLUG" \
  "$TITLE" \
  "$FIELDS" \
  "$WORKSPACE_TYPES" \
  "$NAV_GROUP" \
  "$NAV_ORDER" \
  "$ROUTE_PATH" \
  "$ICON" \
  "$API_BASE" \
  "$SERVICE_NAME" \
  "$HTTP_PORT" \
  "$TABLE_NAME" \
  "$PERMISSION_RESOURCE" \
  "$PACKAGE_SCOPE" \
  "$PLUGIN_DIR_PREFIX" \
  "$REGISTER_SERVICE" \
  "$REGISTER_NGINX" <<'NODE'
const fs = require("fs");
const path = require("path");

const [
  root,
  slug,
  title,
  fieldsSpec,
  workspaceTypesRaw,
  navGroup,
  navOrderRaw,
  routePath,
  icon,
  apiBase,
  serviceName,
  httpPortRaw,
  tableName,
  permissionResource,
  packageScope,
  pluginDirPrefix,
  registerServiceRaw,
  registerNginxRaw
] = process.argv.slice(2);

const registerService = registerServiceRaw === "1";
const registerNginx = registerNginxRaw === "1";
const navOrder = Number(navOrderRaw);
const httpPort = Number(httpPortRaw);
const resourceKey = slug.replace(/-/g, "_");
const pluginDirName = `${pluginDirPrefix}-${slug}`;
const pluginDir = path.join(root, "plugins", pluginDirName);
const serviceDir = path.join(root, "services", serviceName);
const packageName = `${packageScope}/plugin-${slug}`;
const sharedModulePath = readGoModulePath(path.join(root, "shared", "go.mod"));
const rootGoModule = sharedModulePath.replace(/\/shared$/, "");
const parts = slug.split("-");
const pascal = parts.map((part) => part[0].toUpperCase() + part.slice(1)).join("");
const camel = pascal[0].toLowerCase() + pascal.slice(1);
const pageName = `${pascal}Page`;
const pageFile = `${slug}-page`;
const permissionConst = `${camel}Permissions`;
const modulePermissionConst = `${camel}ModulePermissions`;
const envVar = `KY_${slug.replace(/-/g, "_").toUpperCase()}_SERVICE_HTTP_ADDR`;
const allowedWorkspaceTypes = workspaceTypesRaw.split(",").map((item) => item.trim()).filter(Boolean);

function json(value) {
  return JSON.stringify(value);
}

function pascalCase(value) {
  return value
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function camelCase(value) {
  const p = pascalCase(value);
  return p[0].toLowerCase() + p.slice(1);
}

function snakeCase(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.replace(/\n+$/g, "") + "\n");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function readGoModulePath(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const match = content.match(/^module\s+(\S+)/m);
  if (!match) {
    throw new Error(`无法读取 Go module：${filePath}`);
  }
  return match[1];
}

function parseFields(spec) {
  return spec
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [rawName, type, label] = item.split(":");
      const name = camelCase(rawName);
      const column = snakeCase(rawName);
      return {
        rawName,
        name,
        column,
        type,
        label,
        goName: pascalCase(rawName),
        jsonName: name,
        sqlType: sqlType(type),
        goType: goType(type),
        tsType: tsType(type),
        formKind: formKind(type)
      };
    });
}

function sqlType(type) {
  switch (type) {
    case "int":
      return "integer NOT NULL DEFAULT 0";
    case "number":
      return "numeric(18,6) NOT NULL DEFAULT 0";
    case "bool":
      return "boolean NOT NULL DEFAULT false";
    case "text":
      return "text NOT NULL DEFAULT ''";
    default:
      return "text NOT NULL DEFAULT ''";
  }
}

function goType(type) {
  switch (type) {
    case "int":
      return "int";
    case "number":
      return "float64";
    case "bool":
      return "bool";
    default:
      return "string";
  }
}

function tsType(type) {
  switch (type) {
    case "int":
    case "number":
      return "number";
    case "bool":
      return "boolean";
    default:
      return "string";
  }
}

function formKind(type) {
  if (type === "bool") return "switch";
  if (type === "int" || type === "number") return "number";
  if (type === "text") return "textarea";
  return "input";
}

const fields = parseFields(fieldsSpec);
const permissionByWorkspace = Object.fromEntries(
  allowedWorkspaceTypes.map((workspaceType) => [
    workspaceType,
    {
      view: `${workspaceType}.${permissionResource}.view`,
      create: `${workspaceType}.${permissionResource}.create`,
      update: `${workspaceType}.${permissionResource}.update`,
      updateStatus: `${workspaceType}.${permissionResource}.update_status`,
      delete: `${workspaceType}.${permissionResource}.delete`
    }
  ])
);
const permissionCodes = Object.values(permissionByWorkspace).flatMap((group) => Object.values(group));
const viewPermissions = allowedWorkspaceTypes.map((workspaceType) => permissionByWorkspace[workspaceType].view);
const createPermissions = allowedWorkspaceTypes.map((workspaceType) => permissionByWorkspace[workspaceType].create);
const updatePermissions = allowedWorkspaceTypes.map((workspaceType) => permissionByWorkspace[workspaceType].update);
const updateStatusPermissions = allowedWorkspaceTypes.map((workspaceType) => permissionByWorkspace[workspaceType].updateStatus);
const deletePermissions = allowedWorkspaceTypes.map((workspaceType) => permissionByWorkspace[workspaceType].delete);
const firstViewPermission = viewPermissions[0];

function generatePermissionsTs() {
  return `export const pluginName = "${pluginDirName}";

export const ${permissionConst} = ${JSON.stringify(permissionByWorkspace, null, 2)} as const;

export const ${modulePermissionConst} = {
  view: ${JSON.stringify(viewPermissions)},
  create: ${JSON.stringify(createPermissions)},
  update: ${JSON.stringify(updatePermissions)},
  updateStatus: ${JSON.stringify(updateStatusPermissions)},
  delete: ${JSON.stringify(deletePermissions)}
};

export const permissions = ${JSON.stringify(permissionCodes)};
`;
}

function generateApiTs() {
  const extraFields = fields.map((field) => `  ${field.name}: ${field.tsType};`).join("\n");
  const extraInputFields = fields.map((field) => `  ${field.name}?: ${field.tsType};`).join("\n");
  return `import type { RequestClient } from "@ky/admin-core";

export interface ListResult<T> {
  items: T[];
  pagination: { page: number; pageSize: number; total: number };
}

export interface ${pascal}Record {
  id: string;
  workspaceType: string;
  workspaceId: string;
  name: string;
${extraFields ? `${extraFields}\n` : ""}  status: "normal" | "disabled";
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ${pascal}Input {
  name: string;
${extraInputFields ? `${extraInputFields}\n` : ""}  status?: "normal" | "disabled";
}

export interface ${pascal}ListParams {
  page: number;
  pageSize: number;
  keyword?: string;
  status?: string;
}

function queryString(params: ${pascal}ListParams): string {
  const query = new URLSearchParams();
  query.set("page", String(params.page));
  query.set("pageSize", String(params.pageSize));
  if (params.keyword) query.set("keyword", params.keyword);
  if (params.status) query.set("status", params.status);
  return query.toString();
}

export function list${pascal}Records(client: RequestClient, params: ${pascal}ListParams): Promise<ListResult<${pascal}Record>> {
  return client.request<ListResult<${pascal}Record>>(\`${apiBase}?\${queryString(params)}\`);
}

export function create${pascal}Record(client: RequestClient, input: ${pascal}Input): Promise<${pascal}Record> {
  return client.request<${pascal}Record>(${json(apiBase)}, { method: "POST", body: input });
}

export function update${pascal}Record(client: RequestClient, id: string, input: ${pascal}Input): Promise<${pascal}Record> {
  return client.request<${pascal}Record>(\`${apiBase}/\${id}\`, { method: "PATCH", body: input });
}

export function update${pascal}RecordStatus(client: RequestClient, id: string, status: "normal" | "disabled"): Promise<${pascal}Record> {
  return client.request<${pascal}Record>(\`${apiBase}/\${id}/status\`, { method: "PATCH", body: { status } });
}

export function delete${pascal}Record(client: RequestClient, id: string): Promise<{ id: string; deleted: boolean }> {
  return client.request<{ id: string; deleted: boolean }>(\`${apiBase}/\${id}\`, { method: "DELETE" });
}
`;
}

function generateFormItems() {
  const lines = fields.map((field) => {
    if (field.formKind === "switch") {
      return `          <Form.Item label="${field.label}" name="${field.name}" valuePropName="checked" initialValue={false}>
            <Switch />
          </Form.Item>`;
    }
    if (field.formKind === "number") {
      return `          <Form.Item label="${field.label}" name="${field.name}">
            <InputNumber style={{ width: "100%" }} />
          </Form.Item>`;
    }
    if (field.formKind === "textarea") {
      return `          <Form.Item label="${field.label}" name="${field.name}">
            <Input.TextArea rows={3} />
          </Form.Item>`;
    }
    return `          <Form.Item label="${field.label}" name="${field.name}">
            <Input />
          </Form.Item>`;
  });
  return lines.join("\n");
}

function generateFieldColumns() {
  return fields
    .map(
      (field) => `    {
      title: ${json(field.label)},
      dataIndex: "${field.name}",
      key: "${field.name}",
      width: 160,
      render: (value: ${pascal}Record["${field.name}"]) => renderValue(value)
    },`
    )
    .join("\n");
}

function generatePageTsx() {
  const fieldColumns = generateFieldColumns();
  const formItems = generateFormItems();
  const scrollX = 900 + fields.length * 160;
  return `import { useEffect, useMemo, useState, type Key } from "react";
import {
  Button,
  Drawer,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Segmented,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  ListPageCard,
  drawerWidths,
  readListQueryState,
  runBatchRequests,
  usePermissions,
  useRequestClient,
  writeListQueryState,
  type ListQueryState
} from "@ky/admin-core";
import {
  create${pascal}Record,
  delete${pascal}Record,
  list${pascal}Records,
  update${pascal}Record,
  update${pascal}RecordStatus,
  type ${pascal}Input,
  type ${pascal}Record
} from "../api";
import { ${modulePermissionConst} } from "../permissions";

const STATUS_META: Record<${pascal}Record["status"], { label: string; color: string }> = {
  normal: { label: "正常", color: "green" },
  disabled: { label: "已停用", color: "red" }
};

const STATUS_OPTIONS = [
  { value: "", label: "全部" },
  { value: "normal", label: "正常" },
  { value: "disabled", label: "已停用" }
];

interface FilterValues {
  keyword: string;
  status?: string;
}

function renderValue(value: unknown) {
  if (typeof value === "boolean") {
    return value ? <Tag color="green">是</Tag> : <Tag>否</Tag>;
  }
  if (value === null || value === undefined || value === "") {
    return <Typography.Text type="secondary">—</Typography.Text>;
  }
  return String(value);
}

export function ${pageName}() {
  const client = useRequestClient();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = readListQueryState(searchParams);
  const [filterValues, setFilterValues] = useState<FilterValues>({
    keyword: queryState.keyword ?? "",
    status: queryState.status
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<${pascal}Record | null>(null);
  const [form] = Form.useForm<${pascal}Input>();
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);

  const canCreate = permissions.canAny(${modulePermissionConst}.create);
  const canUpdate = permissions.canAny(${modulePermissionConst}.update);
  const canUpdateStatus = permissions.canAny(${modulePermissionConst}.updateStatus);
  const canDelete = permissions.canAny(${modulePermissionConst}.delete);

  useEffect(() => {
    setFilterValues({ keyword: queryState.keyword ?? "", status: queryState.status });
  }, [queryState.keyword, queryState.status]);

  const queryKey = [${json(slug)}, queryState.page, queryState.pageSize, queryState.keyword, queryState.status];
  const { data, isFetching } = useQuery({
    queryKey,
    queryFn: () =>
      list${pascal}Records(client, {
        page: queryState.page,
        pageSize: queryState.pageSize,
        keyword: queryState.keyword,
        status: queryState.status
      })
  });

  function applyState(next: Partial<ListQueryState>) {
    setSelectedRowKeys([]);
    setSearchParams(writeListQueryState({ ...queryState, ...next }));
  }

  function submitFilters() {
    const keyword = filterValues.keyword.trim();
    applyState({ keyword: keyword || undefined, status: filterValues.status || undefined, page: 1 });
  }

  function resetFilters() {
    setFilterValues({ keyword: "", status: undefined });
    applyState({ keyword: undefined, status: undefined, page: 1 });
  }

  const invalidate = () => queryClient.invalidateQueries({ queryKey: [${json(slug)}] });
  const selectedRows = useMemo(
    () => (data?.items ?? []).filter((row) => selectedRowKeys.includes(row.id)),
    [data?.items, selectedRowKeys]
  );
  const selectedNormalRows = selectedRows.filter((row) => row.status === "normal");
  const selectedDisabledRows = selectedRows.filter((row) => row.status === "disabled");

  const saveMutation = useMutation({
    mutationFn: (values: ${pascal}Input) =>
      editing ? update${pascal}Record(client, editing.id, values) : create${pascal}Record(client, values),
    onSuccess: () => {
      void message.success(editing ? "记录已更新。" : "记录已创建。");
      setDrawerOpen(false);
      setEditing(null);
      setSelectedRowKeys([]);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "normal" | "disabled" }) =>
      update${pascal}RecordStatus(client, id, status),
    onSuccess: () => {
      void message.success("状态已更新。");
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const bulkStatusMutation = useMutation({
    mutationFn: (status: "normal" | "disabled") => {
      const targets = status === "disabled" ? selectedNormalRows : selectedDisabledRows;
      return runBatchRequests(
        targets,
        (row) => update${pascal}RecordStatus(client, row.id, status),
        "批量更新状态失败"
      );
    },
    onSuccess: () => {
      void message.success("状态已批量更新。");
      setSelectedRowKeys([]);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => delete${pascal}Record(client, id),
    onSuccess: () => {
      void message.success("记录已删除。");
      setSelectedRowKeys([]);
      invalidate();
    },
    onError: (error: Error) => message.error(error.message)
  });

  function openCreate() {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ status: "normal" } as ${pascal}Input);
    setDrawerOpen(true);
  }

  function openEdit(record: ${pascal}Record) {
    setEditing(record);
    form.setFieldsValue(record);
    setDrawerOpen(true);
  }

  const columns: ColumnsType<${pascal}Record> = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      width: 220,
      render: (value: string) => <Typography.Text strong>{value}</Typography.Text>
    },
${fieldColumns ? `${fieldColumns}\n` : ""}    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (value: ${pascal}Record["status"]) => {
        const meta = STATUS_META[value] ?? { label: value, color: "default" };
        return <Tag color={meta.color}>{meta.label}</Tag>;
      }
    },
    {
      title: "更新时间",
      dataIndex: "updatedAt",
      key: "updatedAt",
      width: 180,
      render: (value: string) => new Date(value).toLocaleString("zh-CN")
    },
    {
      title: "操作",
      key: "actions",
      className: "table-action-column",
      fixed: "right",
      width: 220,
      render: (_, record) => (
        <Space className="table-action-grid" size={4} wrap>
          {canUpdate ? (
            <Button size="small" type="link" onClick={() => openEdit(record)}>
              编辑
            </Button>
          ) : null}
          {canUpdateStatus ? (
            <Button
              size="small"
              type="link"
              onClick={() =>
                statusMutation.mutate({ id: record.id, status: record.status === "normal" ? "disabled" : "normal" })
              }
            >
              {record.status === "normal" ? "停用" : "启用"}
            </Button>
          ) : null}
          {canDelete ? (
            <Popconfirm title="确认删除该记录？" okText="删除" cancelText="取消" onConfirm={() => deleteMutation.mutate(record.id)}>
              <Button size="small" type="link" danger>
                删除
              </Button>
            </Popconfirm>
          ) : null}
        </Space>
      )
    }
  ];

  return (
    <>
      <ListPageCard
        title=${json(title)}
        subtitle={
          selectedRowKeys.length > 0 ? (
            <Space size={8}>
              <Typography.Text type="secondary">已选择 {selectedRowKeys.length} 项</Typography.Text>
              <Button size="small" type="link" onClick={() => setSelectedRowKeys([])}>
                清空选择
              </Button>
            </Space>
          ) : (
            "管理业务记录，支持查询、新建、编辑、启停和删除。"
          )
        }
        toolbar={
          <Space wrap>
            <Input.Search
              allowClear
              placeholder="输入关键词"
              style={{ width: 240 }}
              value={filterValues.keyword}
              onChange={(event) => setFilterValues((current) => ({ ...current, keyword: event.target.value }))}
              onSearch={submitFilters}
            />
            <Segmented
              className="list-status-segmented"
              options={STATUS_OPTIONS}
              value={filterValues.status ?? ""}
              onChange={(value) => {
                const status = String(value);
                setFilterValues((current) => ({ ...current, status: status || undefined }));
                applyState({ status: status || undefined, page: 1 });
              }}
            />
            <Button onClick={submitFilters}>查询</Button>
            <Button onClick={resetFilters}>重置</Button>
          </Space>
        }
        extra={
          <Space wrap>
            {canUpdateStatus && selectedNormalRows.length > 0 ? (
              <Button onClick={() => bulkStatusMutation.mutate("disabled")}>批量停用</Button>
            ) : null}
            {canUpdateStatus && selectedDisabledRows.length > 0 ? (
              <Button onClick={() => bulkStatusMutation.mutate("normal")}>批量启用</Button>
            ) : null}
            {canCreate ? (
              <Button type="primary" onClick={openCreate}>
                新建
              </Button>
            ) : null}
          </Space>
        }
      >
        <Table<${pascal}Record>
          rowKey="id"
          columns={columns}
          dataSource={data?.items ?? []}
          loading={isFetching}
          rowSelection={{ selectedRowKeys, onChange: (keys) => setSelectedRowKeys(keys) }}
          pagination={{
            current: queryState.page,
            pageSize: queryState.pageSize,
            total: data?.pagination.total ?? 0,
            showSizeChanger: true,
            onChange: (page, pageSize) => applyState({ page, pageSize })
          }}
          scroll={{ x: ${scrollX} }}
        />
      </ListPageCard>

      <Drawer
        title={editing ? "编辑记录" : "新建记录"}
        width={drawerWidths.standardForm}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)}>取消</Button>
            <Button type="primary" loading={saveMutation.isPending} onClick={() => form.submit()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form<${pascal}Input> form={form} layout="vertical" onFinish={(values) => saveMutation.mutate(values)}>
          <Form.Item label="名称" name="name" rules={[{ required: true, message: "请输入名称" }]}>
            <Input />
          </Form.Item>
${formItems ? `${formItems}\n` : ""}          <Form.Item label="状态" name="status" initialValue="normal">
            <Segmented
              className="list-status-segmented"
              options={[
                { value: "normal", label: "正常" },
                { value: "disabled", label: "已停用" }
              ]}
            />
          </Form.Item>
        </Form>
      </Drawer>
    </>
  );
}
`;
}

function generateRoutesTsx() {
  return `import type { PluginRoute } from "@ky/admin-core";
import { ${pageName} } from "./pages/${pageFile}";
import { ${modulePermissionConst} } from "./permissions";

export const routes: PluginRoute[] = [
  {
    path: "${routePath}",
    requiredAnyPermissions: ${modulePermissionConst}.view,
    element: <${pageName} />
  }
];
`;
}

function generateIndexTsx() {
  return `import type { AdminPlugin } from "@ky/admin-core";
import { routes } from "./routes";
import { ${modulePermissionConst} } from "./permissions";

export const ${camel}Plugin: AdminPlugin = {
  name: "${pluginDirName}",
  navGroup: ${json(navGroup)},
  navOrder: ${navOrder},
  menus: [
    {
      key: "${pluginDirName}.main",
      label: ${json(title)},
      path: "${routePath}",
      icon: ${json(icon)},
      menuKey: ${json(firstViewPermission)},
      requiredAnyPermissions: ${modulePermissionConst}.view
    }
  ],
  routes
};

export default ${camel}Plugin;
`;
}

function generateService() {
  fs.mkdirSync(serviceDir, { recursive: true });
  writeFile(path.join(serviceDir, "go.mod"), `module ${rootGoModule}/services/${serviceName}

go 1.25.0

require github.com/jackc/pgx/v5 v5.7.2
`);
  writeFile(path.join(serviceDir, "cmd/server/main.go"), `package main

import (
	"context"
	"log"

	"${rootGoModule}/services/${serviceName}/internal/config"
	"${rootGoModule}/services/${serviceName}/internal/server"
)

func main() {
	ctx := context.Background()
	cfg := config.Load("${serviceName}", ":${httpPort}", "${envVar}")
	app := server.New(cfg)
	if err := app.Run(ctx); err != nil {
		log.Fatalf("%s stopped with error: %v", cfg.ServiceName, err)
	}
}
`);
  writeFile(path.join(serviceDir, "internal/config/config.go"), `package config

import (
	"bufio"
	"os"
	"strings"
)

type Config struct {
	ServiceName     string
	HTTPAddr        string
	RuntimeEnvFile  string
	DatabaseURL     string
	RedisURL         string
	NATSURL          string
	AuthTokenSecret string
}

func Load(serviceName, defaultHTTPAddr, httpAddrEnv string) Config {
	runtimeEnvFile := os.Getenv("KY_RUNTIME_ENV_FILE")
	if runtimeEnvFile != "" {
		_ = loadEnvFile(runtimeEnvFile)
	}

	addr := os.Getenv(httpAddrEnv)
	if addr == "" {
		addr = defaultHTTPAddr
	}

	return Config{
		ServiceName:     serviceName,
		HTTPAddr:        addr,
		RuntimeEnvFile:  runtimeEnvFile,
		DatabaseURL:     os.Getenv("KY_TENANT_DATABASE_URL"),
		RedisURL:        os.Getenv("KY_REDIS_URL"),
		NATSURL:         os.Getenv("KY_NATS_URL"),
		AuthTokenSecret: os.Getenv("KY_AUTH_TOKEN_SECRET"),
	}
}

func loadEnvFile(filePath string) error {
	file, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.Trim(strings.TrimSpace(value), "\\"'")
		if key == "" {
			continue
		}
		if os.Getenv(key) == "" {
			_ = os.Setenv(key, value)
		}
	}
	return scanner.Err()
}
`);
  writeFile(path.join(serviceDir, "internal/store/db.go"), generateStoreDbGo());
  writeFile(path.join(serviceDir, `internal/store/${resourceKey}_store.go`), generateStoreGo());
  writeFile(path.join(serviceDir, "internal/server/http.go"), generateServerHttpGo());
  writeFile(path.join(serviceDir, "internal/server/server.go"), generateServerGo());
  writeFile(path.join(serviceDir, `internal/server/${resourceKey}_handlers.go`), generateHandlersGo());
}

function generateStoreDbGo() {
  return `package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"

	"${rootGoModule}/shared/session"
	_ "github.com/jackc/pgx/v5/stdlib"
)

var (
	ErrNotFound   = errors.New("not found")
	ErrConflict   = errors.New("conflict")
	ErrValidation = errors.New("validation")
)

type Store struct {
	db *sql.DB
}

type Page struct {
	Page     int   \`json:"page"\`
	PageSize int   \`json:"pageSize"\`
	Total    int64 \`json:"total"\`
}

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return nil, err
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) Ping(ctx context.Context) error {
	return s.db.PingContext(ctx)
}

func (s *Store) SessionActive(ctx context.Context, sessionID string, now time.Time) (bool, error) {
	return session.Active(ctx, s.db, sessionID, now)
}

func (s *Store) ActiveMembershipID(ctx context.Context, userID, workspaceType, workspaceID string) (string, error) {
	var membershipID string
	err := s.db.QueryRowContext(ctx, \`
		SELECT id FROM ky_membership
		WHERE user_id = $1 AND workspace_type = $2 AND workspace_id = $3
		  AND status = 'active' AND deleted_at IS NULL
		LIMIT 1
	\`, userID, workspaceType, workspaceID).Scan(&membershipID)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return membershipID, nil
}

func (s *Store) HasAny(ctx context.Context, membershipID string, wanted []string) (bool, error) {
	if len(wanted) == 0 {
		return true, nil
	}
	placeholders := make([]string, len(wanted))
	args := make([]any, 0, len(wanted)+1)
	args = append(args, membershipID)
	for i, code := range wanted {
		placeholders[i] = "$" + itoa(i+2)
		args = append(args, code)
	}
	var x int
	err := s.db.QueryRowContext(ctx, \`
		SELECT 1
		FROM ky_membership_role mr
		JOIN ky_role r ON r.id = mr.role_id
		JOIN ky_role_permission rp ON rp.role_id = r.id
		JOIN ky_permission p ON p.id = rp.permission_id
		WHERE mr.membership_id = $1
		  AND r.status = 'normal' AND r.deleted_at IS NULL
		  AND p.status = 'normal'
		  AND p.code IN (\`+strings.Join(placeholders, ",")+\`)
		LIMIT 1
	\`, args...).Scan(&x)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func itoa(i int) string { return strconv.Itoa(i) }

func randomSuffix() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func affectedOrNotFound(res sql.Result) error {
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func classifyWriteErr(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if strings.Contains(msg, "23505") || strings.Contains(msg, "duplicate key") ||
		strings.Contains(msg, "23503") || strings.Contains(msg, "violates foreign key") {
		return ErrConflict
	}
	return err
}

func nullStr(s string) sql.NullString {
	s = strings.TrimSpace(s)
	if s == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: s, Valid: true}
}
`;
}

function generateStoreGo() {
  const structFields = fields.map((field) => `	${field.goName} ${field.goType} \`json:"${field.jsonName}"\``).join("\n");
  const inputFields = fields.map((field) => `	${field.goName} ${field.goType} \`json:"${field.jsonName}"\``).join("\n");
  const extraColumns = fields.map((field) => field.column);
  const selectColumns = [
    "id",
    "workspace_type",
    "workspace_id",
    "name",
    ...extraColumns,
    "status",
    "created_by",
    "updated_by",
    "created_at",
    "updated_at"
  ].join(", ");
  const scanTargets = fields.map((field) => `&item.${field.goName}`).join(", ");
  const insertColumns = ["id", "workspace_type", "workspace_id", "name", ...extraColumns, "status", "created_by", "updated_by"];
  const insertValues = insertColumns.map((_, index) => `$${index + 1}`).join(",");
  const insertArgs = [
    "id",
    "workspaceType",
    "workspaceID",
    "in.Name",
    ...fields.map((field) => `in.${field.goName}`),
    "status",
    "nullStr(userID)",
    "nullStr(userID)"
  ].join(", ");
  const updateAssignments = ["name=$4", ...fields.map((field, index) => `${field.column}=$${index + 5}`), `status=$${fields.length + 5}`, `updated_by=$${fields.length + 6}`, "updated_at=now()"].join(", ");
  const updateArgs = [
    "id",
    "workspaceType",
    "workspaceID",
    "in.Name",
    ...fields.map((field) => `in.${field.goName}`),
    "status",
    "nullStr(userID)"
  ].join(", ");
  return `package store

import (
	"context"
	"database/sql"
	"strings"
	"time"
)

type ${pascal} struct {
	ID            string    \`json:"id"\`
	WorkspaceType string    \`json:"workspaceType"\`
	WorkspaceID   string    \`json:"workspaceId"\`
	Name          string    \`json:"name"\`
${structFields ? `${structFields}\n` : ""}	Status        string    \`json:"status"\`
	CreatedBy     string    \`json:"createdBy"\`
	UpdatedBy     string    \`json:"updatedBy"\`
	CreatedAt     time.Time \`json:"createdAt"\`
	UpdatedAt     time.Time \`json:"updatedAt"\`
}

type ${pascal}Input struct {
	Name   string \`json:"name"\`
${inputFields ? `${inputFields}\n` : ""}	Status string \`json:"status"\`
}

const ${camel}Columns = \`${selectColumns}\`

func scan${pascal}(row interface{ Scan(...any) error }) (${pascal}, error) {
	var item ${pascal}
	var createdBy, updatedBy sql.NullString
	err := row.Scan(&item.ID, &item.WorkspaceType, &item.WorkspaceID, &item.Name${scanTargets ? `, ${scanTargets}` : ""}, &item.Status, &createdBy, &updatedBy, &item.CreatedAt, &item.UpdatedAt)
	if createdBy.Valid {
		item.CreatedBy = createdBy.String
	}
	if updatedBy.Valid {
		item.UpdatedBy = updatedBy.String
	}
	return item, err
}

func (s *Store) List${pascal}(ctx context.Context, workspaceType, workspaceID, keyword, status string, page, pageSize int) ([]${pascal}, Page, error) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	offset := (page - 1) * pageSize
	keyword = strings.TrimSpace(keyword)
	status = strings.TrimSpace(status)

	var total int64
	if err := s.db.QueryRowContext(ctx, \`
		SELECT count(*)
		FROM ${tableName}
		WHERE workspace_type=$1 AND workspace_id=$2 AND deleted_at IS NULL
		  AND ($3='' OR name ILIKE '%' || $3 || '%')
		  AND ($4='' OR status=$4)
	\`, workspaceType, workspaceID, keyword, status).Scan(&total); err != nil {
		return nil, Page{}, err
	}

	rows, err := s.db.QueryContext(ctx, \`
		SELECT \`+${camel}Columns+\`
		FROM ${tableName}
		WHERE workspace_type=$1 AND workspace_id=$2 AND deleted_at IS NULL
		  AND ($3='' OR name ILIKE '%' || $3 || '%')
		  AND ($4='' OR status=$4)
		ORDER BY updated_at DESC, created_at DESC
		LIMIT $5 OFFSET $6
	\`, workspaceType, workspaceID, keyword, status, pageSize, offset)
	if err != nil {
		return nil, Page{}, err
	}
	defer rows.Close()

	items := []${pascal}{}
	for rows.Next() {
		item, err := scan${pascal}(rows)
		if err != nil {
			return nil, Page{}, err
		}
		items = append(items, item)
	}
	return items, Page{Page: page, PageSize: pageSize, Total: total}, rows.Err()
}

func (s *Store) Get${pascal}(ctx context.Context, workspaceType, workspaceID, id string) (${pascal}, error) {
	item, err := scan${pascal}(s.db.QueryRowContext(ctx, \`
		SELECT \`+${camel}Columns+\`
		FROM ${tableName}
		WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND deleted_at IS NULL
	\`, id, workspaceType, workspaceID))
	if err == sql.ErrNoRows {
		return ${pascal}{}, ErrNotFound
	}
	return item, err
}

func (s *Store) Create${pascal}(ctx context.Context, workspaceType, workspaceID string, in ${pascal}Input, userID string) (string, error) {
	id := "${resourceKey}_" + randomSuffix()
	status := normalize${pascal}Status(in.Status)
	_, err := s.db.ExecContext(ctx, \`
		INSERT INTO ${tableName} (${insertColumns.join(", ")})
		VALUES (${insertValues})
	\`, ${insertArgs})
	if err != nil {
		return "", classifyWriteErr(err)
	}
	return id, nil
}

func (s *Store) Update${pascal}(ctx context.Context, workspaceType, workspaceID, id string, in ${pascal}Input, userID string) error {
	status := normalize${pascal}Status(in.Status)
	res, err := s.db.ExecContext(ctx, \`
		UPDATE ${tableName}
		SET ${updateAssignments}
		WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND deleted_at IS NULL
	\`, ${updateArgs})
	if err != nil {
		return classifyWriteErr(err)
	}
	return affectedOrNotFound(res)
}

func (s *Store) Update${pascal}Status(ctx context.Context, workspaceType, workspaceID, id, status, userID string) error {
	status = normalize${pascal}Status(status)
	res, err := s.db.ExecContext(ctx, \`
		UPDATE ${tableName}
		SET status=$4, updated_by=$5, updated_at=now()
		WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND deleted_at IS NULL
	\`, id, workspaceType, workspaceID, status, nullStr(userID))
	if err != nil {
		return classifyWriteErr(err)
	}
	return affectedOrNotFound(res)
}

func (s *Store) Delete${pascal}(ctx context.Context, workspaceType, workspaceID, id string) error {
	res, err := s.db.ExecContext(ctx, \`
		UPDATE ${tableName}
		SET deleted_at=now()
		WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND deleted_at IS NULL
	\`, id, workspaceType, workspaceID)
	if err != nil {
		return err
	}
	return affectedOrNotFound(res)
}

func normalize${pascal}Status(status string) string {
	status = strings.TrimSpace(status)
	if status == "" {
		return "normal"
	}
	if status != "normal" && status != "disabled" {
		return "normal"
	}
	return status
}
`;
}

function generateServerHttpGo() {
  return `package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"${rootGoModule}/services/${serviceName}/internal/store"
)

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func writeData(w http.ResponseWriter, r *http.Request, data any) {
	writeJSON(w, map[string]any{"data": data, "requestId": requestID(r)})
}

func writeList(w http.ResponseWriter, r *http.Request, items any, page store.Page) {
	writeJSON(w, map[string]any{
		"data":      map[string]any{"items": items, "pagination": page},
		"requestId": requestID(r),
	})
}

func writeError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	w.WriteHeader(status)
	writeJSON(w, map[string]any{
		"error":     map[string]any{"code": code, "message": message, "details": map[string]any{}},
		"requestId": requestID(r),
	})
}

func writeStoreError(w http.ResponseWriter, r *http.Request, err error) {
	switch err {
	case store.ErrNotFound:
		writeError(w, r, http.StatusNotFound, "not_found", "资源不存在")
	case store.ErrConflict:
		writeError(w, r, http.StatusConflict, "conflict", "数据冲突")
	case store.ErrValidation:
		writeError(w, r, http.StatusBadRequest, "validation_error", "参数不合法")
	default:
		writeError(w, r, http.StatusInternalServerError, "internal_error", "服务内部错误")
	}
}

func decodeJSON(w http.ResponseWriter, r *http.Request, value any) bool {
	if err := json.NewDecoder(r.Body).Decode(value); err != nil {
		writeError(w, r, http.StatusBadRequest, "validation_error", "请求 JSON 格式错误")
		return false
	}
	return true
}

func requestID(r *http.Request) string {
	if id := r.Header.Get("X-KY-Request-Id"); id != "" {
		return id
	}
	return newID("req")
}

func newID(prefix string) string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return prefix + "_" + hex.EncodeToString(b[:])
}

func parsePage(r *http.Request) (page, pageSize int) {
	page = atoiDefault(r.URL.Query().Get("page"), 1)
	if page < 1 {
		page = 1
	}
	pageSize = atoiDefault(r.URL.Query().Get("pageSize"), 20)
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	return page, pageSize
}

func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return v
}

func splitComma(s string) []string {
	out := []string{}
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}
`;
}

function generateServerGo() {
  const permissionList = (action) => allowedWorkspaceTypes.map((workspaceType) => `${workspaceType}.${permissionResource}.${action}`);
  return `package server

import (
	"context"
	"net/http"
	"time"

	"${rootGoModule}/services/${serviceName}/internal/config"
	"${rootGoModule}/services/${serviceName}/internal/store"
	"${rootGoModule}/shared/auth"
)

type Server struct {
	cfg   config.Config
	store *store.Store
}

func New(cfg config.Config) *Server {
	return &Server{cfg: cfg}
}

type wsContext struct {
	UserID        string
	WorkspaceType string
	WorkspaceID   string
	MembershipID  string
}

type wsHandler func(w http.ResponseWriter, r *http.Request, wc wsContext)

func (s *Server) Run(ctx context.Context) error {
	if s.cfg.DatabaseURL != "" {
		if opened, err := store.Open(ctx, s.cfg.DatabaseURL); err == nil {
			s.store = opened
			defer opened.Close()
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /readyz", s.readyz)
	mux.HandleFunc("GET /healthz", s.healthz)

	perms := func(codes ...string) []string { return codes }
	const allowedWorkspaces = "${allowedWorkspaceTypes.join(",")}"

	mux.HandleFunc("GET ${apiBase}", s.ws(allowedWorkspaces, perms(${permissionList("view").map(json).join(", ")}), s.list${pascal}))
	mux.HandleFunc("POST ${apiBase}", s.ws(allowedWorkspaces, perms(${permissionList("create").map(json).join(", ")}), s.create${pascal}))
	mux.HandleFunc("GET ${apiBase}/{id}", s.ws(allowedWorkspaces, perms(${permissionList("view").map(json).join(", ")}), s.get${pascal}))
	mux.HandleFunc("PATCH ${apiBase}/{id}", s.ws(allowedWorkspaces, perms(${permissionList("update").map(json).join(", ")}), s.update${pascal}))
	mux.HandleFunc("PATCH ${apiBase}/{id}/status", s.ws(allowedWorkspaces, perms(${permissionList("update_status").map(json).join(", ")}), s.update${pascal}Status))
	mux.HandleFunc("DELETE ${apiBase}/{id}", s.ws(allowedWorkspaces, perms(${permissionList("delete").map(json).join(", ")}), s.delete${pascal}))

	server := &http.Server{Addr: s.cfg.HTTPAddr, Handler: mux}
	errCh := make(chan error, 1)
	go func() { errCh <- server.ListenAndServe() }()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithCancel(context.Background())
		defer cancel()
		return server.Shutdown(shutdownCtx)
	case err := <-errCh:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	}
}

func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	databaseReady := s.store != nil && s.store.Ping(r.Context()) == nil
	tokenSecretConfigured := s.cfg.AuthTokenSecret != ""
	status := "ok"
	if !databaseReady || !tokenSecretConfigured {
		status = "degraded"
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	writeJSON(w, map[string]any{
		"status":                status,
		"service":               s.cfg.ServiceName,
		"databaseReady":         databaseReady,
		"tokenSecretConfigured": tokenSecretConfigured,
	})
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	_, _ = w.Write([]byte("ok\\n"))
}

func (s *Server) ws(allowedTypes string, requiredPerms []string, next wsHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.store == nil {
			writeError(w, r, http.StatusServiceUnavailable, "service_unavailable", "数据库未连接")
			return
		}
		if s.cfg.AuthTokenSecret == "" {
			writeError(w, r, http.StatusServiceUnavailable, "service_unavailable", "Token Secret 未配置")
			return
		}
		header := r.Header.Get("Authorization")
		if len(header) < 8 || header[:7] != "Bearer " {
			writeError(w, r, http.StatusUnauthorized, "unauthorized", "未登录或 token 无效")
			return
		}
		payload, err := auth.VerifyToken(s.cfg.AuthTokenSecret, header[7:])
		if err != nil {
			writeError(w, r, http.StatusUnauthorized, "unauthorized", "未登录或 token 无效")
			return
		}
		active, err := s.store.SessionActive(r.Context(), payload.SessionID, time.Now())
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "internal_error", "会话校验失败")
			return
		}
		if !active {
			writeError(w, r, http.StatusUnauthorized, "unauthorized", "会话已失效")
			return
		}
		wsType := r.Header.Get("X-KY-Workspace-Type")
		wsID := r.Header.Get("X-KY-Workspace-Id")
		if wsType == "" || wsID == "" {
			writeError(w, r, http.StatusBadRequest, "workspace_required", "缺少工作区 Header")
			return
		}
		if !typeAllowed(allowedTypes, wsType) {
			writeError(w, r, http.StatusForbidden, "workspace_forbidden", "当前工作区不允许访问该接口")
			return
		}
		membershipID, err := s.store.ActiveMembershipID(r.Context(), payload.UserID, wsType, wsID)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "internal_error", "工作区身份校验失败")
			return
		}
		if membershipID == "" {
			writeError(w, r, http.StatusForbidden, "workspace_forbidden", "用户无当前工作区身份")
			return
		}
		if len(requiredPerms) > 0 {
			ok, err := s.store.HasAny(r.Context(), membershipID, requiredPerms)
			if err != nil {
				writeError(w, r, http.StatusInternalServerError, "internal_error", "权限校验失败")
				return
			}
			if !ok {
				writeError(w, r, http.StatusForbidden, "permission_denied", "当前后台身份无权执行该操作")
				return
			}
		}
		next(w, r, wsContext{UserID: payload.UserID, WorkspaceType: wsType, WorkspaceID: wsID, MembershipID: membershipID})
	}
}

func typeAllowed(allowed, wsType string) bool {
	for _, t := range splitComma(allowed) {
		if t == wsType {
			return true
		}
	}
	return false
}
`;
}

function generateHandlersGo() {
  return `package server

import (
	"net/http"
	"strings"

	"${rootGoModule}/services/${serviceName}/internal/store"
)

func (s *Server) list${pascal}(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, pageSize := parsePage(r)
	items, pagination, err := s.store.List${pascal}(
		r.Context(),
		wc.WorkspaceType,
		wc.WorkspaceID,
		r.URL.Query().Get("keyword"),
		r.URL.Query().Get("status"),
		page,
		pageSize,
	)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeList(w, r, items, pagination)
}

func (s *Server) get${pascal}(w http.ResponseWriter, r *http.Request, wc wsContext) {
	item, err := s.store.Get${pascal}(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, item)
}

func (s *Server) create${pascal}(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in store.${pascal}Input
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "名称不能为空")
		return
	}
	id, err := s.store.Create${pascal}(r.Context(), wc.WorkspaceType, wc.WorkspaceID, in, wc.UserID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	item, err := s.store.Get${pascal}(r.Context(), wc.WorkspaceType, wc.WorkspaceID, id)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, item)
}

func (s *Server) update${pascal}(w http.ResponseWriter, r *http.Request, wc wsContext) {
	id := r.PathValue("id")
	var in store.${pascal}Input
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "名称不能为空")
		return
	}
	if err := s.store.Update${pascal}(r.Context(), wc.WorkspaceType, wc.WorkspaceID, id, in, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	item, err := s.store.Get${pascal}(r.Context(), wc.WorkspaceType, wc.WorkspaceID, id)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, item)
}

func (s *Server) update${pascal}Status(w http.ResponseWriter, r *http.Request, wc wsContext) {
	id := r.PathValue("id")
	var in struct {
		Status string \`json:"status"\`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if err := s.store.Update${pascal}Status(r.Context(), wc.WorkspaceType, wc.WorkspaceID, id, in.Status, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	item, err := s.store.Get${pascal}(r.Context(), wc.WorkspaceType, wc.WorkspaceID, id)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, item)
}

func (s *Server) delete${pascal}(w http.ResponseWriter, r *http.Request, wc wsContext) {
	id := r.PathValue("id")
	if err := s.store.Delete${pascal}(r.Context(), wc.WorkspaceType, wc.WorkspaceID, id); err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{"id": id, "deleted": true})
}
`;
}

function generateSql() {
  const nextNumber = nextDbNumber();
  const fileName = `${String(nextNumber).padStart(3, "0")}_${resourceKey}_business_module.sql`;
  const target = path.join(root, "ops", "db", fileName);
  const fieldColumns = fields.map((field) => `  ${field.column} ${field.sqlType},`).join("\n");
  const permissionRows = [];
  for (const workspaceType of allowedWorkspaceTypes) {
    const roleLabel = workspaceType === "platform" ? "平台" : workspaceType === "agency" ? "机构" : "企业";
    permissionRows.push(
      `  ('perm_menu_${workspaceType}_${permissionResource}', 'menu.${workspaceType}.${permissionResource}', '${roleLabel}${title}菜单', 'menu', '${permissionResource}', 'view', '["${workspaceType}"]'::jsonb, 'Business module menu permission', 'normal')`,
      `  ('perm_${workspaceType}_${permissionResource}_view', '${workspaceType}.${permissionResource}.view', '${roleLabel}${title}查看', 'page', '${permissionResource}', 'view', '["${workspaceType}"]'::jsonb, 'Business module page permission', 'normal')`,
      `  ('perm_${workspaceType}_${permissionResource}_create', '${workspaceType}.${permissionResource}.create', '${roleLabel}${title}创建', 'action', '${permissionResource}', 'create', '["${workspaceType}"]'::jsonb, 'Business module action permission', 'normal')`,
      `  ('perm_${workspaceType}_${permissionResource}_update', '${workspaceType}.${permissionResource}.update', '${roleLabel}${title}编辑', 'action', '${permissionResource}', 'update', '["${workspaceType}"]'::jsonb, 'Business module action permission', 'normal')`,
      `  ('perm_${workspaceType}_${permissionResource}_update_status', '${workspaceType}.${permissionResource}.update_status', '${roleLabel}${title}启停', 'action', '${permissionResource}', 'update_status', '["${workspaceType}"]'::jsonb, 'Business module action permission', 'normal')`,
      `  ('perm_${workspaceType}_${permissionResource}_delete', '${workspaceType}.${permissionResource}.delete', '${roleLabel}${title}删除', 'action', '${permissionResource}', 'delete', '["${workspaceType}"]'::jsonb, 'Business module action permission', 'normal')`
    );
  }
  const roleAssignments = allowedWorkspaceTypes
    .flatMap((workspaceType) => {
      const roles =
        workspaceType === "platform"
          ? ["role_platform_owner", "role_platform_admin"]
          : workspaceType === "agency"
            ? ["role_agency_owner_template", "role_agency_admin_template"]
            : ["role_enterprise_owner_template", "role_enterprise_admin_template"];
      return roles.map(
        (roleID) => `INSERT INTO ky_role_permission (id, role_id, permission_id)
SELECT 'rp_${roleID.replace(/^role_/, "")}_' || replace(p.code, '.', '_'), '${roleID}', p.id
FROM ky_permission p
WHERE p.code LIKE '${workspaceType}.${permissionResource}.%' OR p.code = 'menu.${workspaceType}.${permissionResource}'
ON CONFLICT (role_id, permission_id) DO NOTHING;`
      );
    })
    .join("\n\n");
  writeFile(target, `-- ${title} business module schema and permissions.
-- Generated by scripts/create_business_module.sh. Idempotent.

CREATE TABLE IF NOT EXISTS ${tableName} (
  id text PRIMARY KEY,
  workspace_type text NOT NULL,
  workspace_id text NOT NULL,
  name text NOT NULL,
${fieldColumns ? `${fieldColumns}\n` : ""}  status text NOT NULL DEFAULT 'normal',
  created_by text NULL REFERENCES ky_user(id),
  updated_by text NULL REFERENCES ky_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_${tableName}_workspace_status
  ON ${tableName} (workspace_type, workspace_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_${tableName}_updated_at
  ON ${tableName} (updated_at DESC)
  WHERE deleted_at IS NULL;

INSERT INTO ky_permission (id, code, name, category, resource, action, workspace_types, description, status) VALUES
${permissionRows.join(",\n")}
ON CONFLICT (code) DO NOTHING;

${roleAssignments}
`);
  return fileName;
}

function nextDbNumber() {
  const dbDir = path.join(root, "ops", "db");
  const files = fs.readdirSync(dbDir).filter((file) => /^[0-9]{3}_.+\.sql$/.test(file));
  const max = files.reduce((current, file) => Math.max(current, Number(file.slice(0, 3))), 0);
  return max + 1;
}

function addLineToUseBlock(filePath, line) {
  let content = fs.readFileSync(filePath, "utf8");
  if (content.includes(line)) return;
  content = content.replace(/use \(([\s\S]*?)\n\)/, (match, body) => {
    const lines = body.split("\n").filter((item) => item.trim() !== "");
    lines.push(`\t${line}`);
    lines.sort((a, b) => a.trim().localeCompare(b.trim()));
    return `use (\n${lines.join("\n")}\n)`;
  });
  fs.writeFileSync(filePath, content);
}

function addServiceToArrayScript(filePath, service) {
  let content = fs.readFileSync(filePath, "utf8");
  if (content.includes(`  ${service}\n`) || content.includes(`  ${service}\r\n`)) return;
  content = content.replace(/services=\(\n([\s\S]*?)\n\)/, (match, body) => {
    const lines = body.split("\n").filter((item) => item.trim() !== "");
    lines.push(`  ${service}`);
    lines.sort((a, b) => a.trim().localeCompare(b.trim()));
    return `services=(\n${lines.join("\n")}\n)`;
  });
  fs.writeFileSync(filePath, content);
}

function addNginxLocation() {
  const filePath = path.join(root, "ops", "native", "ky-admin-host.nginx.conf");
  let content = fs.readFileSync(filePath, "utf8");
  if (content.includes(`location ${apiBase} `) || content.includes(`location ${apiBase} {`)) return;
  const block = `  location ${apiBase} {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-KY-Workspace-Id $http_x_ky_workspace_id;
    proxy_set_header X-KY-Workspace-Type $http_x_ky_workspace_type;
    proxy_set_header X-KY-Request-Id $http_x_ky_request_id;
    proxy_pass http://127.0.0.1:${httpPort};
  }

`;
  content = content.replace("  location = /index.html {", block + "  location = /index.html {");
  fs.writeFileSync(filePath, content);
}

function registerGeneratedService() {
  addLineToUseBlock(path.join(root, "go.work"), `./services/${serviceName}`);
  addServiceToArrayScript(path.join(root, "scripts", "build_services.sh"), serviceName);
  addServiceToArrayScript(path.join(root, "scripts", "deploy_services.sh"), serviceName);
  const unitPath = path.join(root, "ops", "native", `${serviceName}.service`);
  writeFile(unitPath, `[Unit]
Description=KyaiCRM ${serviceName} Service
After=network.target

[Service]
Type=simple
WorkingDirectory=/data/kyai_crm
Environment=KY_RUNTIME_ENV_FILE=/data/kyai_crm/config/external-dependencies.env
ExecStart=/data/kyai_crm/bin/${serviceName}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`);
  const envPath = path.join(root, "ops", "native", "external-dependencies.env.example");
  let envContent = fs.readFileSync(envPath, "utf8");
  if (!envContent.includes(`${envVar}=`)) {
    envContent = envContent.replace(/\s*$/, `\n${envVar}=:${httpPort}\n`);
    fs.writeFileSync(envPath, envContent);
  }
}

writeFile(path.join(pluginDir, "src", "permissions.ts"), generatePermissionsTs());
writeFile(path.join(pluginDir, "src", "api.ts"), generateApiTs());
writeFile(path.join(pluginDir, "src", "routes.tsx"), generateRoutesTsx());
writeFile(path.join(pluginDir, "src", "index.tsx"), generateIndexTsx());
writeFile(path.join(pluginDir, "src", "pages", `${pageFile}.tsx`), generatePageTsx());
generateService();
const sqlFile = generateSql();

if (registerService) {
  registerGeneratedService();
}
if (registerNginx) {
  addNginxLocation();
}

console.log(`已创建业务模块：${title}`);
console.log(`前端插件：plugins/${pluginDirName}`);
console.log(`后端服务：services/${serviceName}`);
console.log(`数据库脚本：ops/db/${sqlFile}`);
console.log(`API 路径：${apiBase}`);
if (registerService) {
  console.log("已注册 go.work、服务构建/部署脚本和 systemd unit。");
}
if (registerNginx) {
  console.log("已注册 Nginx API 反向代理。");
}
NODE

if command -v gofmt >/dev/null 2>&1 && [[ -d "$SERVICE_DIR" ]]; then
  gofmt -w "$SERVICE_DIR"
fi

cat <<EOF
建议执行：
  pnpm --filter "$PACKAGE_NAME" typecheck
  pnpm --filter "$PACKAGE_NAME" build
  go test ./services/$SERVICE_NAME/...
  go build -o /tmp/$SERVICE_NAME "$ROOT_DIR/services/$SERVICE_NAME/cmd/server"
EOF

if [[ "$REGISTER_HOST" -eq 1 ]]; then
  cat <<'EOF'
  pnpm --filter @ky/admin-host typecheck
EOF
fi
