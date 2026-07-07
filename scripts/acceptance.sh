#!/usr/bin/env bash
# KyaiCRM Phase 1 end-to-end acceptance.
#
# Exercises the implemented API surface across all four services using the
# seeded platform owner. WRITES DATA (agencies/roles/announcements/AI config) —
# run only against a disposable/test database.
#
# Requirements: curl. jq is used when available, otherwise grep/sed fallback.
set -euo pipefail

AUTH_URL="${KY_ACCEPT_AUTH_URL:-http://127.0.0.1:18081}"
ORG_URL="${KY_ACCEPT_ORG_URL:-http://127.0.0.1:18082}"
MEMBERSHIP_URL="${KY_ACCEPT_MEMBERSHIP_URL:-http://127.0.0.1:18083}"
AI_URL="${KY_ACCEPT_AI_URL:-http://127.0.0.1:18086}"
ADMIN_ACCOUNT="${KY_ACCEPT_ADMIN_ACCOUNT:-Super.Admin}"
ADMIN_PASSWORD="${KY_ACCEPT_ADMIN_PASSWORD:-Ky@123123}"

PASS=0
FAIL=0
TOKEN=""

WS_HEADERS=(-H "X-KY-Workspace-Type: platform" -H "X-KY-Workspace-Id: platform_root")

note() { printf '  %s\n' "$*"; }
pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$*"; }

# json_field <json> <key> — extract a string field nested under the response
# "data" envelope (e.g. data.token, data.id). Uses jq when available, else grep.
json_field() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$1" | jq -r ".data.$2 // empty" 2>/dev/null
  else
    printf '%s' "$1" | grep -oE "\"$2\"[: ]*\"[^\"]*\"" | head -1 | sed -E 's/.*: *"([^"]*)"/\1/'
  fi
}

# req METHOD URL [data] — authenticated workspace request, prints "<code> <body>".
req() {
  local method="$1" url="$2" data="${3:-}"
  local args=(-s -w '\n%{http_code}' -X "$method" "$url"
    -H "Authorization: Bearer $TOKEN"
    -H "Content-Type: application/json"
    -H "X-KY-Request-Id: acc-$RANDOM"
    "${WS_HEADERS[@]}")
  if [[ -n "$data" ]]; then args+=(-d "$data"); fi
  curl "${args[@]}"
}

code_of() { printf '%s' "$1" | tail -1; }
body_of() { printf '%s' "$1" | sed '$d'; }

expect_code() {
  local desc="$1" want="$2" resp="$3"
  local got; got="$(code_of "$resp")"
  if [[ "$got" == "$want" ]]; then pass "$desc ($got)"; else fail "$desc (want $want got $got)"; note "$(body_of "$resp" | head -c 300)"; fi
}

echo "== KyaiCRM Phase 1 acceptance =="
echo "auth=$AUTH_URL org=$ORG_URL membership=$MEMBERSHIP_URL ai=$AI_URL account=$ADMIN_ACCOUNT"

# A. health / readyz
expect_code "A healthz" 200 "$(curl -s -w '\n%{http_code}' "$AUTH_URL/healthz")"
for u in "$AUTH_URL" "$ORG_URL" "$MEMBERSHIP_URL" "$AI_URL"; do
  r="$(curl -s -w '\n%{http_code}' "$u/readyz")"
  c="$(code_of "$r")"
  if [[ "$c" == "200" ]]; then pass "A readyz $u"; else fail "A readyz $u ($c)"; note "$(body_of "$r" | head -c 200)"; fi
done

# B. login
login_resp="$(curl -s -w '\n%{http_code}' -X POST "$AUTH_URL/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"account\":\"$ADMIN_ACCOUNT\",\"password\":\"$ADMIN_PASSWORD\"}")"
expect_code "B login" 200 "$login_resp"
TOKEN="$(json_field "$(body_of "$login_resp")" 'token')"
if [[ -n "$TOKEN" ]]; then pass "B token obtained"; else fail "B token missing"; fi

# C. bootstrap
boot="$(req GET "$AUTH_URL/api/v1/auth/bootstrap")"
expect_code "C bootstrap" 200 "$boot"
if body_of "$boot" | grep -q 'platform_root'; then pass "C bootstrap has platform_root"; else fail "C bootstrap missing platform_root"; fi
if body_of "$boot" | grep -q 'platform_owner'; then pass "C bootstrap has platform_owner role"; else fail "C bootstrap missing platform_owner role"; fi

# D. negative paths
noauth="$(curl -s -w '\n%{http_code}' "$MEMBERSHIP_URL/api/v1/roles" -H 'X-KY-Workspace-Type: platform' -H 'X-KY-Workspace-Id: platform_root')"
expect_code "D no-token -> 401" 401 "$noauth"
wrongws="$(curl -s -w '\n%{http_code}' "$AI_URL/api/v1/ai-models/providers" \
  -H "Authorization: Bearer $TOKEN" -H 'X-KY-Workspace-Type: agency' -H 'X-KY-Workspace-Id: agency_x')"
expect_code "D agency-ws on AI -> 403" 403 "$wrongws"

# E. organization
agency_code="acc-ag-$RANDOM"
expect_code "E create agency" 200 "$(req POST "$ORG_URL/api/v1/platform/agencies" "{\"name\":\"验收机构\",\"code\":\"$agency_code\"}")"
expect_code "E list agencies" 200 "$(req GET "$ORG_URL/api/v1/platform/agencies?keyword=$agency_code")"

# F. members / invitations
expect_code "F list members" 200 "$(req GET "$MEMBERSHIP_URL/api/v1/workspace/members")"
inv="$(req POST "$MEMBERSHIP_URL/api/v1/invitations" '{"invitationType":"member","inviteeEmail":"acc@example.com"}')"
expect_code "F create invitation" 200 "$inv"
inv_token="$(json_field "$(body_of "$inv")" 'token')"
if [[ -n "$inv_token" ]]; then
  expect_code "F public invitation lookup" 200 "$(curl -s -w '\n%{http_code}' "$MEMBERSHIP_URL/api/v1/public/invitations/$inv_token")"
else
  fail "F invitation token missing"
fi

# G. access center
expect_code "G list roles" 200 "$(req GET "$MEMBERSHIP_URL/api/v1/roles")"
expect_code "G list permissions" 200 "$(req GET "$MEMBERSHIP_URL/api/v1/permissions")"
expect_code "G list data-scopes" 200 "$(req GET "$MEMBERSHIP_URL/api/v1/data-scopes")"
role_resp="$(req POST "$MEMBERSHIP_URL/api/v1/roles" "{\"name\":\"验收角色\",\"code\":\"acc-role-$RANDOM\"}")"
expect_code "G create role" 200 "$role_resp"

# H. notifications / audit
ann="$(req POST "$MEMBERSHIP_URL/api/v1/announcements" '{"title":"验收公告","content":"hello","targetScope":"all"}')"
expect_code "H create announcement" 200 "$ann"
ann_id="$(json_field "$(body_of "$ann")" 'id')"
if [[ -n "$ann_id" ]]; then
  expect_code "H publish announcement" 200 "$(req PATCH "$MEMBERSHIP_URL/api/v1/announcements/$ann_id/publish")"
fi
unread="$(req GET "$MEMBERSHIP_URL/api/v1/notifications/unread-count")"
expect_code "H unread-count" 200 "$unread"
expect_code "H notifications list" 200 "$(req GET "$MEMBERSHIP_URL/api/v1/notifications?page=1&pageSize=10")"
expect_code "H audit-logs" 200 "$(req GET "$MEMBERSHIP_URL/api/v1/audit-logs")"
expect_code "H login-logs" 200 "$(req GET "$AUTH_URL/api/v1/login-logs")"

# I. AI configuration
prov="$(req POST "$AI_URL/api/v1/ai-models/providers" '{"name":"验收供应商","providerType":"anthropic","apiKey":"sk-secret-123456"}')"
expect_code "I create provider" 200 "$prov"
if body_of "$prov" | grep -q 'sk-secret-123456'; then fail "I provider leaks plaintext apiKey"; else pass "I provider apiKey not leaked"; fi
prov_id="$(json_field "$(body_of "$prov")" 'id')"
expect_code "I reject vision model" 400 "$(req POST "$AI_URL/api/v1/ai-models/models" "{\"providerId\":\"$prov_id\",\"name\":\"v\",\"modelKey\":\"v1\",\"modelType\":\"vision\"}")"
model="$(req POST "$AI_URL/api/v1/ai-models/models" "{\"providerId\":\"$prov_id\",\"name\":\"txt\",\"modelKey\":\"txt-$RANDOM\",\"modelType\":\"text_generation\"}")"
expect_code "I create text model" 200 "$model"
model_id="$(json_field "$(body_of "$model")" 'id')"
expect_code "I embedding default rejects text model" 400 "$(req PATCH "$AI_URL/api/v1/ai-models/settings" "{\"defaultEmbeddingModelId\":\"$model_id\"}")"
expect_code "I chat default accepts text model" 200 "$(req PATCH "$AI_URL/api/v1/ai-models/settings" "{\"defaultChatModelId\":\"$model_id\"}")"

# J. settings / dictionaries / workbench (platform scope)
expect_code "J platform system-settings get" 200 "$(req GET "$ORG_URL/api/v1/platform/system-settings")"
expect_code "J platform system-settings patch" 200 "$(req PATCH "$ORG_URL/api/v1/platform/system-settings" '{"settings":{"security":{"sessionHours":24}}}')"
expect_code "J dictionaries" 200 "$(req GET "$ORG_URL/api/v1/dictionaries")"
expect_code "J platform workbench summary" 200 "$(req GET "$ORG_URL/api/v1/platform/workbench/summary")"

echo
echo "== Result: $PASS passed, $FAIL failed =="
[[ "$FAIL" -eq 0 ]]
