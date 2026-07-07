#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/apps/ky-admin-host/dist"
TARGET_DIR="${KY_DEPLOY_ROOT:-/data/kyai_crm}/www/ky-admin-host"
HEALTHZ_URL="${KY_VERIFY_CONSOLE_URL:-http://127.0.0.1}/healthz"

test -f "$SRC_DIR/index.html"

echo "Frontend deploy dry run."
echo "- clean old frontend directory: $TARGET_DIR"
echo "- copy $SRC_DIR -> $TARGET_DIR"
echo "- nginx -t"
echo "- systemctl reload nginx"
echo "- check $HEALTHZ_URL"
echo "Set KY_EXECUTE_FRONTEND_DEPLOY=1 to execute these actions."
if [[ "${KY_EXECUTE_FRONTEND_DEPLOY:-}" == "1" ]]; then
  rm -rf "$TARGET_DIR"
  install -d "$TARGET_DIR"
  cp -R "$SRC_DIR"/. "$TARGET_DIR"/
  find "$TARGET_DIR" -type d -exec chmod 0755 {} +
  find "$TARGET_DIR" -type f -exec chmod 0644 {} +
  nginx -t
  systemctl reload nginx
  curl -fsS "$HEALTHZ_URL" >/dev/null
fi
