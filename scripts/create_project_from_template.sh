#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROJECT_SLUG="kysion-crm"
PRODUCT_NAME="KyCRM"
PRODUCT_CN_NAME="企迅CRM"
PACKAGE_NAME=""
GIT_REMOTE="https://github.com/kysion/kysion-crm.git"
OUTPUT_DIR=""
CONFIG_FILE=""
DRY_RUN=0
INIT_GIT=0
INTERACTIVE=0

ADMIN_SOURCE_DIR="ky-admin-host"
DESKTOP_SOURCE_DIR="aicrm-desktop"
ADMIN_DIR=""
ADMIN_PACKAGE=""
ADMIN_NAME=""
ADMIN_DESCRIPTION=""
DESKTOP_DIR=""
DESKTOP_PACKAGE=""
DESKTOP_APP_NAME=""
DESKTOP_NAME=""
DESKTOP_DESCRIPTION=""

if [[ $# -eq 0 && -t 0 ]]; then
  INTERACTIVE=1
fi

usage() {
  cat <<'EOF'
从 KyCRM 基础框架模板创建新的独立项目。

用法：
  scripts/create_project_from_template.sh --output <dir> [options]
  scripts/create_project_from_template.sh --interactive
  scripts/create_project_from_template.sh --config <file.yaml>

参数：
  --config <file.yaml>       从 YAML 配置文件读取初始化参数；命令行参数会覆盖配置文件。
  --interactive              启动交互式初始化向导。
  --output <dir>             输出目录；目录必须不存在或为空。
  --project-slug <slug>      项目 / 仓库 slug，默认：kysion-crm。
  --product-name <name>      产品英文名，默认：KyCRM。
  --product-cn-name <name>   产品中文名，默认：企迅CRM。
  --package-name <name>      根 package.json 的包名，默认使用 project slug。
  --admin-dir <dir>          管理后台应用在 apps/ 下的目录名，默认：ky-admin-host。
  --admin-package <name>     管理后台应用 NPM 包名，默认：@ky/admin-host。
  --admin-name <name>        管理后台应用显示名称。
  --admin-description <text> 管理后台应用说明。
  --desktop-dir <dir>        桌面客户端在 apps/ 下的目录名，默认：aicrm-desktop。
  --desktop-package <name>   桌面客户端 NPM 包名，默认：@ky/aicrm-desktop。
  --desktop-app-name <name>  桌面客户端窗口 / 应用名称，默认：<product-name> Desktop。
  --desktop-name <name>      桌面客户端显示名称。
  --desktop-description <text>
                             桌面客户端说明。
  --git-remote <url>         使用 --init-git 时写入的 Git 远端地址，
                             默认：https://github.com/kysion/kysion-crm.git。
  --init-git                 初始化新的 Git 仓库并设置 origin。
  --dry-run                  只打印计划执行的复制操作，不写入文件。
  -h, --help                 显示帮助信息。

生成脚本采用保守模式：复制干净工程骨架，排除本地产物，更新根项目和
apps 应用的包元数据，可选重命名应用目录，并执行安全的文档 / 配置文本替换。
window.aicrm、AICRM_* 环境变量名、ky_ 数据库前缀和 Go module path 等运行时
契约默认保留，后续需要时再做显式迁移。
EOF
}

load_config_file() {
  local config_file="$1"
  local assignments

  if [[ -z "$config_file" ]]; then
    return 0
  fi

  if [[ ! -f "$config_file" ]]; then
    echo "配置文件不存在：$config_file" >&2
    exit 2
  fi

  if ! assignments="$(
    node - "$config_file" <<'NODE'
const fs = require("fs");

const filePath = process.argv[2];
const text = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
const root = {};
const stack = [{ indent: -1, value: root }];

function parseScalar(raw) {
  const value = raw.trim();
  if (value === "") {
    return "";
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (/^(true|false)$/i.test(value)) {
    return /^true$/i.test(value);
  }
  if (/^null$/i.test(value)) {
    return "";
  }
  return value;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function emit(name, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  console.log(`${name}=${shellQuote(value)}`);
}

function boolFlag(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  return /^(1|true|yes|y)$/i.test(String(value)) ? "1" : "0";
}

for (const [index, originalLine] of text.split("\n").entries()) {
  if (!originalLine.trim() || originalLine.trim().startsWith("#")) {
    continue;
  }

  const withoutComment = originalLine.replace(/\s+#.*$/, "");
  if (!withoutComment.trim()) {
    continue;
  }

  const indent = withoutComment.match(/^ */)[0].length;
  if (indent % 2 !== 0) {
    throw new Error(`YAML 只支持 2 空格缩进：${filePath}:${index + 1}`);
  }

  const line = withoutComment.trim();
  const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
  if (!match) {
    throw new Error(`不支持的 YAML 行：${filePath}:${index + 1}`);
  }

  const key = match[1];
  const rawValue = match[2] ?? "";

  while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
    stack.pop();
  }

  const parent = stack[stack.length - 1].value;
  if (rawValue === "") {
    parent[key] = {};
    stack.push({ indent, value: parent[key] });
  } else {
    parent[key] = parseScalar(rawValue);
  }
}

const project = root.project || {};
const repository = root.repository || root.git || {};
const apps = root.apps || {};
const admin = apps.adminHost || apps.admin || {};
const desktop = apps.desktop || {};
const options = root.options || {};

emit("OUTPUT_DIR", project.output || root.output);
emit("PROJECT_SLUG", project.slug || project.projectSlug);
emit("PRODUCT_NAME", project.productName || project.name);
emit("PRODUCT_CN_NAME", project.productChineseName || project.productCnName || project.chineseName);
emit("PACKAGE_NAME", project.packageName);
emit("GIT_REMOTE", repository.remote || repository.gitRemote || root.gitRemote);
emit("INIT_GIT", boolFlag(repository.initGit || root.initGit));
emit("DRY_RUN", boolFlag(options.dryRun || root.dryRun));
emit("ADMIN_DIR", admin.dir || admin.directory);
emit("ADMIN_PACKAGE", admin.packageName || admin.package);
emit("ADMIN_NAME", admin.displayName || admin.name);
emit("ADMIN_DESCRIPTION", admin.description);
emit("DESKTOP_DIR", desktop.dir || desktop.directory);
emit("DESKTOP_PACKAGE", desktop.packageName || desktop.package);
emit("DESKTOP_APP_NAME", desktop.appName || desktop.productName);
emit("DESKTOP_NAME", desktop.displayName || desktop.name);
emit("DESKTOP_DESCRIPTION", desktop.description);
NODE
  )"; then
    echo "配置文件解析失败：$config_file" >&2
    exit 2
  fi

  eval "$assignments"
}

ARGS=("$@")
for ((i = 0; i < ${#ARGS[@]}; i++)); do
  if [[ "${ARGS[$i]}" == "--config" ]]; then
    CONFIG_FILE="${ARGS[$((i + 1))]:-}"
    break
  fi
done

load_config_file "$CONFIG_FILE"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      CONFIG_FILE="${2:-}"
      shift 2
      ;;
    --interactive)
      INTERACTIVE=1
      shift
      ;;
    --output)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --project-slug)
      PROJECT_SLUG="${2:-}"
      shift 2
      ;;
    --product-name)
      PRODUCT_NAME="${2:-}"
      shift 2
      ;;
    --product-cn-name)
      PRODUCT_CN_NAME="${2:-}"
      shift 2
      ;;
    --package-name)
      PACKAGE_NAME="${2:-}"
      shift 2
      ;;
    --admin-dir)
      ADMIN_DIR="${2:-}"
      shift 2
      ;;
    --admin-package)
      ADMIN_PACKAGE="${2:-}"
      shift 2
      ;;
    --admin-name)
      ADMIN_NAME="${2:-}"
      shift 2
      ;;
    --admin-description)
      ADMIN_DESCRIPTION="${2:-}"
      shift 2
      ;;
    --desktop-dir)
      DESKTOP_DIR="${2:-}"
      shift 2
      ;;
    --desktop-package)
      DESKTOP_PACKAGE="${2:-}"
      shift 2
      ;;
    --desktop-app-name)
      DESKTOP_APP_NAME="${2:-}"
      shift 2
      ;;
    --desktop-name)
      DESKTOP_NAME="${2:-}"
      shift 2
      ;;
    --desktop-description)
      DESKTOP_DESCRIPTION="${2:-}"
      shift 2
      ;;
    --git-remote)
      GIT_REMOTE="${2:-}"
      shift 2
      ;;
    --init-git)
      INIT_GIT=1
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

prompt_value() {
  local label="$1"
  local default_value="$2"
  local value

  read -r -p "$label [$default_value]: " value
  printf '%s' "${value:-$default_value}"
}

prompt_yes_no() {
  local label="$1"
  local default_value="$2"
  local value

  read -r -p "$label [$default_value]: " value
  value="${value:-$default_value}"
  case "${value,,}" in
    y|yes|1|true)
      printf '1'
      ;;
    *)
      printf '0'
      ;;
  esac
}

apply_default_values() {
  [[ -n "$PACKAGE_NAME" ]] || PACKAGE_NAME="$PROJECT_SLUG"
  [[ -n "$ADMIN_DIR" ]] || ADMIN_DIR="$ADMIN_SOURCE_DIR"
  [[ -n "$ADMIN_PACKAGE" ]] || ADMIN_PACKAGE="@ky/admin-host"
  [[ -n "$ADMIN_NAME" ]] || ADMIN_NAME="$PRODUCT_CN_NAME 管理后台"
  [[ -n "$ADMIN_DESCRIPTION" ]] || ADMIN_DESCRIPTION="多租户 CRM 后台管理 Host，负责登录、布局、路由、插件挂载和全局能力。"
  [[ -n "$DESKTOP_DIR" ]] || DESKTOP_DIR="$DESKTOP_SOURCE_DIR"
  [[ -n "$DESKTOP_PACKAGE" ]] || DESKTOP_PACKAGE="@ky/aicrm-desktop"
  [[ -n "$DESKTOP_APP_NAME" ]] || DESKTOP_APP_NAME="$PRODUCT_NAME Desktop"
  [[ -n "$DESKTOP_NAME" ]] || DESKTOP_NAME="$PRODUCT_CN_NAME 桌面端"
  [[ -n "$DESKTOP_DESCRIPTION" ]] || DESKTOP_DESCRIPTION="基于 Electron 的桌面客户端壳，提供窗口控制、安全桥、会话、本地能力和 Web 混合承载。"
}

if [[ "$INTERACTIVE" -eq 1 ]]; then
  if [[ ! -t 0 ]]; then
    echo "--interactive 需要在交互式终端中运行。" >&2
    exit 2
  fi

  echo "KyCRM 模板初始化"
  echo
  OUTPUT_DIR="$(prompt_value "输出目录" "${OUTPUT_DIR:-/tmp/$PROJECT_SLUG}")"
  PRODUCT_NAME="$(prompt_value "产品英文名" "$PRODUCT_NAME")"
  PRODUCT_CN_NAME="$(prompt_value "产品中文名" "$PRODUCT_CN_NAME")"
  PROJECT_SLUG="$(prompt_value "项目 / 仓库 slug" "$PROJECT_SLUG")"
  [[ -n "$PACKAGE_NAME" ]] || PACKAGE_NAME="$PROJECT_SLUG"
  PACKAGE_NAME="$(prompt_value "根 package.json 包名" "$PACKAGE_NAME")"
  GIT_REMOTE="$(prompt_value "Git 远端地址" "$GIT_REMOTE")"
  echo
  echo "管理后台应用"
  ADMIN_DIR="$(prompt_value "apps/ 下的管理后台目录名" "${ADMIN_DIR:-$ADMIN_SOURCE_DIR}")"
  ADMIN_PACKAGE="$(prompt_value "管理后台 NPM 包名" "${ADMIN_PACKAGE:-@ky/admin-host}")"
  ADMIN_NAME="$(prompt_value "管理后台显示名称" "${ADMIN_NAME:-$PRODUCT_CN_NAME 管理后台}")"
  ADMIN_DESCRIPTION="$(prompt_value "管理后台说明" "${ADMIN_DESCRIPTION:-多租户 CRM 后台管理 Host，负责登录、布局、路由、插件挂载和全局能力。}")"
  echo
  echo "桌面客户端应用"
  DESKTOP_DIR="$(prompt_value "apps/ 下的桌面客户端目录名" "${DESKTOP_DIR:-$DESKTOP_SOURCE_DIR}")"
  DESKTOP_PACKAGE="$(prompt_value "桌面客户端 NPM 包名" "${DESKTOP_PACKAGE:-@ky/aicrm-desktop}")"
  DESKTOP_APP_NAME="$(prompt_value "桌面客户端窗口 / 应用名称" "${DESKTOP_APP_NAME:-$PRODUCT_NAME Desktop}")"
  DESKTOP_NAME="$(prompt_value "桌面客户端显示名称" "${DESKTOP_NAME:-$PRODUCT_CN_NAME 桌面端}")"
  DESKTOP_DESCRIPTION="$(prompt_value "桌面客户端说明" "${DESKTOP_DESCRIPTION:-基于 Electron 的桌面客户端壳，提供窗口控制、安全桥、会话、本地能力和 Web 混合承载。}")"
  echo
  INIT_GIT="$(prompt_yes_no "是否初始化 Git 仓库？y/N" "$([[ "$INIT_GIT" -eq 1 ]] && printf 'y' || printf 'N')")"
fi

apply_default_values

if [[ -z "$OUTPUT_DIR" ]]; then
  echo "必须提供 --output。" >&2
  usage >&2
  exit 2
fi

if [[ -z "$PROJECT_SLUG" || -z "$PRODUCT_NAME" || -z "$PRODUCT_CN_NAME" || -z "$PACKAGE_NAME" ]]; then
  echo "项目 slug、产品名称和根包名不能为空。" >&2
  exit 2
fi

if [[ -z "$ADMIN_DIR" || -z "$ADMIN_PACKAGE" || -z "$ADMIN_NAME" || -z "$ADMIN_DESCRIPTION" ]]; then
  echo "管理后台应用目录、包名、显示名称和说明不能为空。" >&2
  exit 2
fi

if [[ -z "$DESKTOP_DIR" || -z "$DESKTOP_PACKAGE" || -z "$DESKTOP_APP_NAME" || -z "$DESKTOP_NAME" || -z "$DESKTOP_DESCRIPTION" ]]; then
  echo "桌面客户端目录、包名、窗口 / 应用名称、显示名称和说明不能为空。" >&2
  exit 2
fi

if [[ "$ADMIN_DIR" == "$DESKTOP_DIR" ]]; then
  echo "管理后台和桌面客户端目录不能相同。" >&2
  exit 2
fi

if [[ ! "$ADMIN_DIR" =~ ^[A-Za-z0-9._-]+$ || ! "$DESKTOP_DIR" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "应用目录必须是安全的单段路径，只允许字母、数字、点、下划线或短横线。" >&2
  exit 2
fi

if [[ ! "$PACKAGE_NAME" =~ ^(@[a-z0-9._-]+/)?[a-z0-9._-]+$ || ! "$ADMIN_PACKAGE" =~ ^(@[a-z0-9._-]+/)?[a-z0-9._-]+$ || ! "$DESKTOP_PACKAGE" =~ ^(@[a-z0-9._-]+/)?[a-z0-9._-]+$ ]]; then
  echo "包名必须是合法的小写 NPM 包名。" >&2
  exit 2
fi

if [[ "$INIT_GIT" -eq 1 && -z "$GIT_REMOTE" ]]; then
  echo "使用 --init-git 时 --git-remote 不能为空。" >&2
  exit 2
fi

mkdir -p "$(dirname "$OUTPUT_DIR")"
OUTPUT_DIR="$(cd "$(dirname "$OUTPUT_DIR")" && pwd)/$(basename "$OUTPUT_DIR")"

if [[ "$OUTPUT_DIR" == "$ROOT_DIR" ]]; then
  echo "输出目录不能是当前源仓库。" >&2
  exit 2
fi

if [[ -d "$OUTPUT_DIR" && -n "$(find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "输出目录已存在且非空：$OUTPUT_DIR" >&2
  exit 2
fi

EXCLUDES_FILE="$(mktemp)"
trap 'rm -f "$EXCLUDES_FILE"' EXIT

cat >"$EXCLUDES_FILE" <<'EOF'
/.git/
node_modules/
.turbo/
dist/
out/
release/
tmp/
/.playwright-mcp/
/server
/services/*/server
*.log
*.tmp
.DS_Store
Thumbs.db
*.swp
/.claude/settings.local.json
/.env
/.env.*
**/.env
**/.env.local
**/.env.production
**/.env.development
/admin-shell-*.png
/aicrm-*.png
/dark-content-*.png
/admin-shell-style-check.json
/docs/kyai_crm_phase1_devwork_deployment_record.md
EOF

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "源目录：$ROOT_DIR"
  echo "输出目录：$OUTPUT_DIR"
  [[ -z "$CONFIG_FILE" ]] || echo "配置文件：$CONFIG_FILE"
  echo "产品名称：$PRODUCT_NAME / $PRODUCT_CN_NAME"
  echo "项目 slug：$PROJECT_SLUG"
  echo "根包名：$PACKAGE_NAME"
  echo "管理后台：apps/$ADMIN_DIR ($ADMIN_PACKAGE) - $ADMIN_NAME"
  echo "桌面客户端：apps/$DESKTOP_DIR ($DESKTOP_PACKAGE) - $DESKTOP_APP_NAME"
  echo "Git 远端：$GIT_REMOTE"
  echo "初始化 Git：$INIT_GIT"
  echo "排除规则文件：$EXCLUDES_FILE"
  rsync -an --exclude-from="$EXCLUDES_FILE" "$ROOT_DIR"/ "$OUTPUT_DIR"/
  exit 0
fi

mkdir -p "$OUTPUT_DIR"
rsync -a --exclude-from="$EXCLUDES_FILE" "$ROOT_DIR"/ "$OUTPUT_DIR"/

rename_path() {
  local source_path="$1"
  local target_path="$2"

  if [[ "$source_path" == "$target_path" ]]; then
    return 0
  fi

  if [[ -e "$target_path" ]]; then
    echo "Target path already exists while renaming: $target_path" >&2
    exit 2
  fi

  if [[ -e "$source_path" ]]; then
    mv "$source_path" "$target_path"
  fi
}

rename_path "$OUTPUT_DIR/apps/$ADMIN_SOURCE_DIR" "$OUTPUT_DIR/apps/$ADMIN_DIR"
rename_path "$OUTPUT_DIR/apps/$DESKTOP_SOURCE_DIR" "$OUTPUT_DIR/apps/$DESKTOP_DIR"
rename_path "$OUTPUT_DIR/ops/native/$ADMIN_SOURCE_DIR.nginx.conf" "$OUTPUT_DIR/ops/native/$ADMIN_DIR.nginx.conf"

node - "$OUTPUT_DIR" "$PACKAGE_NAME" "$PRODUCT_NAME" "$PRODUCT_CN_NAME" "$ADMIN_DIR" "$ADMIN_PACKAGE" "$ADMIN_NAME" "$ADMIN_DESCRIPTION" "$DESKTOP_DIR" "$DESKTOP_PACKAGE" "$DESKTOP_APP_NAME" "$DESKTOP_NAME" "$DESKTOP_DESCRIPTION" <<'NODE'
const fs = require("fs");
const path = require("path");

const [
  root,
  packageName,
  productName,
  productChineseName,
  adminDir,
  adminPackage,
  adminName,
  adminDescription,
  desktopDir,
  desktopPackage,
  desktopAppName,
  desktopName,
  desktopDescription
] = process.argv.slice(2);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function replaceScriptReferences(scripts) {
  if (!scripts) {
    return scripts;
  }

  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value !== "string") {
      continue;
    }

    scripts[key] = value
      .replaceAll("@ky/admin-host", adminPackage)
      .replaceAll("@ky/aicrm-desktop", desktopPackage)
      .replaceAll("apps/ky-admin-host", `apps/${adminDir}`)
      .replaceAll("apps/aicrm-desktop", `apps/${desktopDir}`);
  }

  return scripts;
}

function updatePackage(filePath, updates) {
  const pkg = readJson(filePath);
  Object.assign(pkg, updates);
  pkg.scripts = replaceScriptReferences(pkg.scripts);
  writeJson(filePath, pkg);
}

function setHtmlTitle(filePath, title) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const html = fs.readFileSync(filePath, "utf8");
  fs.writeFileSync(filePath, html.replace(/<title>.*?<\/title>/, `<title>${title}</title>`));
}

const packagePath = path.join(root, "package.json");
const pkg = readJson(packagePath);

pkg.name = packageName;
pkg.description = `${productChineseName} 基础框架工程`;
pkg.scripts = replaceScriptReferences(pkg.scripts);
writeJson(packagePath, pkg);

updatePackage(path.join(root, "apps", adminDir, "package.json"), {
  name: adminPackage,
  displayName: adminName,
  description: adminDescription
});

updatePackage(path.join(root, "apps", desktopDir, "package.json"), {
  name: desktopPackage,
  displayName: desktopName,
  productName: desktopAppName,
  description: desktopDescription
});

setHtmlTitle(path.join(root, "apps", adminDir, "index.html"), adminName);
setHtmlTitle(path.join(root, "apps", desktopDir, "index.html"), desktopAppName);
NODE

replace_file() {
  PRODUCT_NAME="$PRODUCT_NAME" \
  PRODUCT_CN_NAME="$PRODUCT_CN_NAME" \
  PROJECT_SLUG="$PROJECT_SLUG" \
  ADMIN_DIR="$ADMIN_DIR" \
  ADMIN_PACKAGE="$ADMIN_PACKAGE" \
  ADMIN_NAME="$ADMIN_NAME" \
  DESKTOP_DIR="$DESKTOP_DIR" \
  DESKTOP_PACKAGE="$DESKTOP_PACKAGE" \
  DESKTOP_APP_NAME="$DESKTOP_APP_NAME" \
  perl -0pi -e '
    my $legacy_app = "ky" . "aicrm";
    my $legacy_domain = join(".", $legacy_app, "ent" . "ai", "im");
    my $legacy_nginx = $legacy_app . ".nginx.conf";
    s/KyaiCRM Admin/$ENV{ADMIN_NAME}/g;
    s/AiCRM Desktop/$ENV{DESKTOP_APP_NAME}/g;
    s/KyaiCRM/$ENV{PRODUCT_NAME}/g;
    s/AiCRM/$ENV{PRODUCT_NAME}/g;
    s/apps\/ky-admin-host/apps\/$ENV{ADMIN_DIR}/g;
    s/apps\/aicrm-desktop/apps\/$ENV{DESKTOP_DIR}/g;
    s/www\/ky-admin-host/www\/$ENV{ADMIN_DIR}/g;
    s{\@ky/admin-host}{$ENV{ADMIN_PACKAGE}}g;
    s{\@ky/aicrm-desktop}{$ENV{DESKTOP_PACKAGE}}g;
    s/kyai-crm/$ENV{PROJECT_SLUG}/g;
    s/aicrm-platform/$ENV{PROJECT_SLUG}/g;
    s/\Q$legacy_domain\E/console.$ENV{PROJECT_SLUG}.example/g;
    s/\Q$legacy_nginx\E/$ENV{PROJECT_SLUG}.nginx.conf/g;
    s/console\.kyai-crm\.example/console.$ENV{PROJECT_SLUG}.example/g;
    s/www\.kyai-crm\.example/www.$ENV{PROJECT_SLUG}.example/g;
    s/asset\.kyai-crm\.example/asset.$ENV{PROJECT_SLUG}.example/g;
  ' "$1"
}

while IFS= read -r -d '' file; do
  replace_file "$file"
done < <(
  find "$OUTPUT_DIR" \
    \( -path "$OUTPUT_DIR/.git" -o -path "$OUTPUT_DIR/node_modules" -o -path "$OUTPUT_DIR/dist" -o -path "$OUTPUT_DIR/out" \) -prune \
    -o -type f \( \
      -name '*.md' -o -name '*.json' -o -name '*.yaml' -o -name '*.yml' -o \
      -name '*.conf' -o -name '*.service' -o -name '*.env.example' -o \
      -name '*.sh' -o -name '*.sql' -o -name '*.ts' -o -name '*.tsx' -o \
      -name '*.html' \
    \) -print0
)

replace_metadata_file() {
  ADMIN_DIR="$ADMIN_DIR" \
  DESKTOP_DIR="$DESKTOP_DIR" \
  perl -0pi -e '
    s/\bky-admin-host\b/$ENV{ADMIN_DIR}/g;
    s/\baicrm-desktop\b/$ENV{DESKTOP_DIR}/g;
  ' "$1"
}

while IFS= read -r -d '' file; do
  replace_metadata_file "$file"
done < <(
  find "$OUTPUT_DIR" \
    \( -path "$OUTPUT_DIR/.git" -o -path "$OUTPUT_DIR/node_modules" -o -path "$OUTPUT_DIR/dist" -o -path "$OUTPUT_DIR/out" \) -prune \
    -o -type f \( \
      -name '*.md' -o -name '*.json' -o -name '*.yaml' -o -name '*.yml' -o \
      -name '*.conf' -o -name '*.service' -o -name '*.env.example' -o \
      -name '*.sh' -o -name '*.html' \
    \) -print0
)

while IFS= read -r -d '' file; do
  perl -0pi -e '
    s/Super\.Admin/Template.Admin/g;
    s/Ky\@123123/CHANGE_ME_ADMIN_PASSWORD/g;
    s/admin123456/CHANGE_ME_ADMIN_PASSWORD/g;
  ' "$file"
done < <(
  find "$OUTPUT_DIR" \
    \( -path "$OUTPUT_DIR/.git" -o -path "$OUTPUT_DIR/node_modules" -o -path "$OUTPUT_DIR/dist" -o -path "$OUTPUT_DIR/out" \) -prune \
    -o -type f \( \
      -name '*.md' -o -name '*.json' -o -name '*.yaml' -o -name '*.yml' -o \
      -name '*.conf' -o -name '*.service' -o -name '*.env.example' -o \
      -name '*.sh' -o -name '*.sql' -o -name '*.ts' -o -name '*.tsx' -o \
      -name '*.go' -o -name 'go.mod' -o -name 'go.sum' \
    \) -print0
)

node - "$OUTPUT_DIR" "$PROJECT_SLUG" "$PRODUCT_NAME" "$PRODUCT_CN_NAME" "$GIT_REMOTE" "$ADMIN_DIR" "$ADMIN_PACKAGE" "$ADMIN_NAME" "$ADMIN_DESCRIPTION" "$DESKTOP_DIR" "$DESKTOP_PACKAGE" "$DESKTOP_APP_NAME" "$DESKTOP_NAME" "$DESKTOP_DESCRIPTION" <<'NODE'
const fs = require("fs");
const path = require("path");

const [
  root,
  projectSlug,
  productName,
  productChineseName,
  gitRemote,
  adminDir,
  adminPackage,
  adminName,
  adminDescription,
  desktopDir,
  desktopPackage,
  desktopAppName,
  desktopName,
  desktopDescription
] = process.argv.slice(2);
const metadata = {
  generatedFrom: "KyCRM foundation template",
  projectSlug,
  productName,
  productChineseName,
  gitRemote,
  apps: {
    adminHost: {
      dir: `apps/${adminDir}`,
      packageName: adminPackage,
      displayName: adminName,
      description: adminDescription
    },
    desktop: {
      dir: `apps/${desktopDir}`,
      packageName: desktopPackage,
      appName: desktopAppName,
      displayName: desktopName,
      description: desktopDescription
    }
  },
  generatedAt: new Date().toISOString(),
  mode: "conservative"
};

fs.writeFileSync(
  path.join(root, ".template-generated.json"),
  JSON.stringify(metadata, null, 2) + "\n"
);
NODE

if [[ "$INIT_GIT" -eq 1 ]]; then
  (
    cd "$OUTPUT_DIR"
    git init -b main
    git remote add origin "$GIT_REMOTE"
  )
fi

cat <<EOF
已创建项目模板：
  输出目录：$OUTPUT_DIR
  产品名称：$PRODUCT_NAME / $PRODUCT_CN_NAME
  项目 slug：$PROJECT_SLUG
  根包名：$PACKAGE_NAME
  管理后台：apps/$ADMIN_DIR ($ADMIN_PACKAGE) - $ADMIN_NAME
  桌面客户端：apps/$DESKTOP_DIR ($DESKTOP_PACKAGE) - $DESKTOP_APP_NAME
  Git 远端：$GIT_REMOTE

建议执行以下检查：
  cd "$OUTPUT_DIR"
  pnpm install
  pnpm --filter "$ADMIN_PACKAGE" typecheck
  pnpm --filter "$DESKTOP_PACKAGE" typecheck
  scripts/create_business_module.sh --help
  python3 /root/.codex/skills/.system/skill-creator/scripts/quick_validate.py template/skills/aicrm-solution
  python3 /root/.codex/skills/.system/skill-creator/scripts/quick_validate.py template/skills/kycrm-initialize-project
  python3 /root/.codex/skills/.system/skill-creator/scripts/quick_validate.py template/skills/kycrm-create-module
EOF
