#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR=""
RUN_BUILD=0

usage() {
  cat <<'EOF'
验证由 KyCRM 模板生成的新项目。

用法：
  scripts/validate_generated_project.sh <project-dir> [options]

参数：
  <project-dir>       已生成项目目录，目录内应包含 .template-generated.json。
  --with-build        追加执行 pnpm install 和前端 typecheck。
  -h, --help          显示帮助信息。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-build)
      RUN_BUILD=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$PROJECT_DIR" ]]; then
        PROJECT_DIR="$1"
        shift
      else
        echo "未知参数：$1" >&2
        usage >&2
        exit 2
      fi
      ;;
  esac
done

if [[ -z "$PROJECT_DIR" ]]; then
  echo "必须提供生成项目目录。" >&2
  usage >&2
  exit 2
fi

if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "项目目录不存在：$PROJECT_DIR" >&2
  exit 2
fi

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
FAILURES=0

pass() {
  echo "[OK] $1"
}

fail() {
  echo "[FAIL] $1" >&2
  FAILURES=$((FAILURES + 1))
}

require_command() {
  if command -v "$1" >/dev/null 2>&1; then
    pass "命令可用：$1"
  else
    fail "缺少命令：$1"
  fi
}

check_file() {
  if [[ -f "$1" ]]; then
    pass "文件存在：$1"
  else
    fail "文件不存在：$1"
  fi
}

check_dir() {
  if [[ -d "$1" ]]; then
    pass "目录存在：$1"
  else
    fail "目录不存在：$1"
  fi
}

check_no_output() {
  local label="$1"
  shift
  local output

  output="$("$@" 2>&1 || true)"
  if [[ -n "$output" ]]; then
    fail "$label"
    printf '%s\n' "$output" >&2
  else
    pass "$label"
  fi
}

require_command node
require_command rg

METADATA_FILE="$PROJECT_DIR/.template-generated.json"
check_file "$METADATA_FILE"
check_file "$PROJECT_DIR/package.json"

if [[ "$FAILURES" -eq 0 ]]; then
  if ! assignments="$(
    node - "$METADATA_FILE" <<'NODE'
const fs = require("fs");

const metadataPath = process.argv[2];
const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

function emit(name, value) {
  console.log(`${name}=${shellQuote(value)}`);
}

emit("META_PROJECT_SLUG", metadata.projectSlug);
emit("META_PRODUCT_NAME", metadata.productName);
emit("META_PRODUCT_CN_NAME", metadata.productChineseName);
emit("META_ADMIN_DIR", metadata.apps?.adminHost?.dir);
emit("META_ADMIN_PACKAGE", metadata.apps?.adminHost?.packageName);
emit("META_DESKTOP_DIR", metadata.apps?.desktop?.dir);
emit("META_DESKTOP_PACKAGE", metadata.apps?.desktop?.packageName);
NODE
  )"; then
    fail "无法解析 .template-generated.json"
  else
    eval "$assignments"
    pass "已读取生成元数据：$META_PROJECT_SLUG / $META_PRODUCT_CN_NAME"
  fi
fi

if [[ "$FAILURES" -eq 0 ]]; then
  check_dir "$PROJECT_DIR/$META_ADMIN_DIR"
  check_dir "$PROJECT_DIR/$META_DESKTOP_DIR"

  if node - "$PROJECT_DIR" "$META_ADMIN_DIR" "$META_ADMIN_PACKAGE" "$META_DESKTOP_DIR" "$META_DESKTOP_PACKAGE" <<'NODE'
const fs = require("fs");
const path = require("path");

const [root, adminDir, adminPackage, desktopDir, desktopPackage] = process.argv.slice(2);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const adminPkg = readJson(path.join(root, adminDir, "package.json"));
const desktopPkg = readJson(path.join(root, desktopDir, "package.json"));

if (adminPkg.name !== adminPackage) {
  throw new Error(`管理后台包名不匹配：${adminPkg.name} !== ${adminPackage}`);
}

if (desktopPkg.name !== desktopPackage) {
  throw new Error(`桌面客户端包名不匹配：${desktopPkg.name} !== ${desktopPackage}`);
}
NODE
  then
    pass "app package.json 包名与生成元数据一致"
  else
    fail "app package.json 包名与生成元数据不一致"
  fi
fi

QUICK_VALIDATE="/root/.codex/skills/.system/skill-creator/scripts/quick_validate.py"
if [[ -f "$QUICK_VALIDATE" ]]; then
  if [[ -d "$PROJECT_DIR/template/skills/aicrm-solution" ]]; then
    if python3 "$QUICK_VALIDATE" "$PROJECT_DIR/template/skills/aicrm-solution" >/dev/null; then
      pass "skill 校验通过：aicrm-solution"
    else
      fail "skill 校验失败：aicrm-solution"
    fi
  fi

  if [[ -d "$PROJECT_DIR/template/skills/kycrm-initialize-project" ]]; then
    if python3 "$QUICK_VALIDATE" "$PROJECT_DIR/template/skills/kycrm-initialize-project" >/dev/null; then
      pass "skill 校验通过：kycrm-initialize-project"
    else
      fail "skill 校验失败：kycrm-initialize-project"
    fi
  fi

  if [[ -d "$PROJECT_DIR/template/skills/kycrm-create-module" ]]; then
    if python3 "$QUICK_VALIDATE" "$PROJECT_DIR/template/skills/kycrm-create-module" >/dev/null; then
      pass "skill 校验通过：kycrm-create-module"
    else
      fail "skill 校验失败：kycrm-create-module"
    fi
  fi
else
  echo "[WARN] 未找到 quick_validate.py，跳过 skill 校验：$QUICK_VALIDATE"
fi

check_no_output "未发现依赖目录或构建产物" \
  find "$PROJECT_DIR" -type d \( -name node_modules -o -name dist -o -name out -o -name release -o -name .playwright-mcp \) -print

check_no_output "未发现本地截图或服务二进制" \
  find "$PROJECT_DIR" -type f \( -name '*.png' -o -name server \) -print

check_no_output "未发现默认密码、真实域名或隧道痕迹" \
  rg -n "[S]uper\\.Admin|[e]ntai\\.im|[k]yaicrm|[c]loudflared|[G]lobal API Key|[t]oken-file|[t]unnel|[K]y@123123|[a]dmin123456" "$PROJECT_DIR" -S -g '!pnpm-lock.yaml' -g '!.git'

if [[ "${META_ADMIN_DIR:-apps/ky-admin-host}" != "apps/ky-admin-host" ]]; then
  check_no_output "未发现旧管理后台目录或包名残留" \
    rg -n "apps/[k]y-admin-host|@[k]y/admin-host|www/[k]y-admin-host|[k]y-admin-host\\.nginx" "$PROJECT_DIR" -S -g '!pnpm-lock.yaml' -g '!.git'
fi

if [[ "${META_DESKTOP_DIR:-apps/aicrm-desktop}" != "apps/aicrm-desktop" ]]; then
  check_no_output "未发现旧桌面客户端目录或包名残留" \
    rg -n "apps/[a]icrm-desktop|@[k]y/aicrm-desktop" "$PROJECT_DIR" -S -g '!pnpm-lock.yaml' -g '!.git'
fi

if [[ "$RUN_BUILD" -eq 1 ]]; then
  require_command pnpm
  if [[ "$FAILURES" -eq 0 ]]; then
    (
      cd "$PROJECT_DIR"
      pnpm install
      pnpm --filter "$META_ADMIN_PACKAGE" typecheck
      pnpm --filter "$META_DESKTOP_PACKAGE" typecheck
    )
    pass "pnpm install 和 app typecheck 通过"
  fi
fi

if [[ "$FAILURES" -gt 0 ]]; then
  echo "生成项目验证失败：$FAILURES 项" >&2
  exit 1
fi

echo "生成项目验证通过：$PROJECT_DIR"
