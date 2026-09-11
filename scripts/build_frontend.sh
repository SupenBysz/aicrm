#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

pnpm --filter @ky/admin-host... install --frozen-lockfile
# 插件类型入口引用 Core 的 dist 声明，先生成声明再执行全链路类型检查。
pnpm --filter @ky/admin-core build
pnpm --filter @ky/admin-host... typecheck
node --test \
  apps/ky-admin-host/src/desktop-client.test.mjs \
  packages/ky-admin-core/src/ai-executor-desktop.test.mjs \
  plugins/ky-ai-configuration/src/executor-auth-safety.test.mjs \
  plugins/ky-ai-configuration/src/executor-desktop-authorization-flow.test.mjs \
  plugins/ky-matrix-account/src/account-onboarding/legacy-flow-policy.test.mjs \
  plugins/ky-matrix-account/src/account-onboarding/renderer-trust-boundary.test.mjs
pnpm --filter @ky/admin-host build

echo "Web 后台构建完成：apps/ky-admin-host/dist"
