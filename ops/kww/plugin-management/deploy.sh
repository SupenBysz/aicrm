#!/usr/bin/env bash
set -euo pipefail
ROOT=/data/kww.org.cn/aicrm
ORG_BIN=/data/kww.org.cn/runtime/bin/ky-org-service
NGINX=/etc/kww/nginx/nginx.conf
WEB=/data/kww.org.cn/runtime/www/ky-admin-host
NGINX_BIN=/opt/kww/toolchain/nginx/usr/sbin/nginx
STAGE=${1:-/tmp/kww-pm-staging-final/apps/ky-admin-host/dist}
export PATH=/opt/kww/toolchain/go/bin:/opt/node-v26.8.1/bin:$PATH
test -f "$STAGE/index.html"
test -d "$STAGE/assets"
test -f "$ORG_BIN"
test -f "$NGINX"
test -f "$WEB/index.html"
grep -Fq 'location = /api/v1/platform/plugin-management/service-health' "$ROOT/ops/kww/nginx.conf"
"$NGINX_BIN" -t -c "$ROOT/ops/kww/nginx.conf"
BUILD=$(mktemp -d /tmp/kww-org-plugin-build.XXXXXX)
trap 'rm -rf "$BUILD"' EXIT
(
 cd "$ROOT/services/ky-org-service"
 go build -o "$BUILD/ky-org-service" ./cmd/server
 go build -o "$BUILD/migrate_052" "$ROOT/ops/kww/plugin-management/migrate_052.go"
)
BACKUP=/data/kww.org.cn/runtime/backups/plugin-management/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BACKUP"
cp -p "$ORG_BIN" "$BACKUP/ky-org-service"
cp -p "$NGINX" "$BACKUP/nginx.conf"
cp -p "$WEB/index.html" "$BACKUP/index.html"
printf '发布备份：%s\n' "$BACKUP"
rollback() {
 trap - ERR
 set +e
 install -m 0755 "$BACKUP/ky-org-service" "$ORG_BIN.restore"
 mv -f "$ORG_BIN.restore" "$ORG_BIN"
 cp -p "$BACKUP/nginx.conf" "$NGINX.restore"
 mv -f "$NGINX.restore" "$NGINX"
 cp -p "$BACKUP/index.html" "$WEB/index.html.restore"
 mv -f "$WEB/index.html.restore" "$WEB/index.html"
 systemctl restart kww-org
 "$NGINX_BIN" -t -c "$NGINX" && systemctl reload kww-web
 printf '发布失败，已执行服务和页面回退；新增的只读权限保留。备份：%s\n' "$BACKUP" >&2
 exit 1
}
trap rollback ERR
# 配置只在迁移器子进程使用，不输出凭据，也不复制到客户端。
(
 set -a
 source /etc/kww/database.env
 source /etc/kww/runtime.env
 set +a
 "$BUILD/migrate_052" --apply
)
install -m 0755 "$BUILD/ky-org-service" "$ORG_BIN.new"
mv -f "$ORG_BIN.new" "$ORG_BIN"
systemctl restart kww-org
for ((attempt=0; attempt<60; attempt++)); do
 if curl --noproxy '*' --max-time 2 -fsS http://127.0.0.1:18082/readyz > "$BUILD/ready.json"; then break; fi
 sleep 1
done
if ! curl --noproxy '*' --max-time 2 -fsS http://127.0.0.1:18082/readyz > "$BUILD/ready.json"; then journalctl -u kww-org -n 20 --no-pager -o cat >&2; exit 1; fi
cp -p "$ROOT/ops/kww/nginx.conf" "$NGINX.new"
mv -f "$NGINX.new" "$NGINX"
"$NGINX_BIN" -t -c "$NGINX"
systemctl reload kww-web
LOG=/var/log/kww/plugin-management-deploy.log
install -m 0600 /dev/null "$LOG"
printf 'readyz=ok\n' >>"$LOG"
code=000
for ((attempt=0; attempt<15; attempt++)); do
 if code=$(curl --noproxy '*' --max-time 2 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18180/api/v1/platform/plugin-management/service-health); then :; else code=000; fi
 printf 'nginx_reload_attempt=%d http_code=%s\n' "$attempt" "$code" >>"$LOG"
 if [[ "$code" == 401 ]]; then break; fi
 sleep 1
done
test "$code" = 401
# 哈希资源先复制，旧资源与独立插件发布目录全部保留。
mkdir -p "$WEB/assets"
cp -a "$STAGE/assets/." "$WEB/assets/"
install -m 0644 "$STAGE/index.html" "$WEB/index.html.new"
mv -f "$WEB/index.html.new" "$WEB/index.html"
systemctl is-active --quiet kww-org
systemctl is-active --quiet kww-web
curl --noproxy '*' -fsS http://127.0.0.1:18180/ > "$BUILD/live-index.html"
cmp "$STAGE/index.html" "$BUILD/live-index.html"
trap - ERR
printf '开发环境发布完成；权限幂等及未登录 401 已验证，授权页面继续由客户端验收。\n'
