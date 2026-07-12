#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="$ROOT_DIR/ops/native/codex-appserver-protocol.lock"

fail() {
  echo "Codex App Server protocol verification failed: $1" >&2
  exit 1
}

test -f "$LOCK_FILE" || fail "protocol lock is missing"
# shellcheck disable=SC1090
source "$LOCK_FILE"
: "${CODEX_CLI_VERSION:?missing CODEX_CLI_VERSION}"
: "${CODEX_APP_SERVER_V2_SCHEMA_SHA256:?missing schema checksum}"

CODEX_BINARY="${KY_CODEX_BINARY:-codex}"
command -v "$CODEX_BINARY" >/dev/null || fail "Codex CLI is unavailable"
command -v jq >/dev/null || fail "jq is required for canonical schema verification"
actual_version="$($CODEX_BINARY --version | awk '{print $2}')"
[[ "$actual_version" == "$CODEX_CLI_VERSION" ]] || fail "expected Codex $CODEX_CLI_VERSION, got $actual_version"

output_dir="$(mktemp -d)"
cleanup() { rm -rf "$output_dir"; }
trap cleanup EXIT

"$CODEX_BINARY" app-server generate-json-schema --experimental --out "$output_dir" >/dev/null
schema="$output_dir/codex_app_server_protocol.v2.schemas.json"
client_requests="$output_dir/ClientRequest.json"
client_notifications="$output_dir/ClientNotification.json"
server_notifications="$output_dir/ServerNotification.json"
test -f "$schema" -a -f "$client_requests" -a -f "$client_notifications" -a -f "$server_notifications" \
  || fail "generated schema bundle is incomplete"

# The generator may emit JSON object members in a different order on each
# invocation.  Canonical key ordering makes the protocol lock deterministic.
actual_checksum="$(jq -S -c . "$schema" | sha256sum | awk '{print $1}')"
[[ "$actual_checksum" == "$CODEX_APP_SERVER_V2_SCHEMA_SHA256" ]] \
  || fail "v2 schema checksum changed ($actual_checksum)"

for method in initialize account/read account/login/start account/login/cancel account/logout model/list; do
  grep -q "\"$method\"" "$client_requests" || fail "missing client request $method"
done
grep -q '"initialized"' "$client_notifications" || fail "missing initialized notification"
for method in account/login/completed account/updated; do
  grep -q "\"$method\"" "$server_notifications" || fail "missing server notification $method"
done

grep -q '"chatgptDeviceCode"' "$output_dir/v2/LoginAccountParams.json" \
  || fail "device-code login input disappeared"
for field in loginId verificationUrl userCode; do
  grep -q "\"$field\"" "$output_dir/v2/LoginAccountResponse.json" \
    || fail "device-code response field $field disappeared"
done
for field in id model displayName hidden inputModalities supportedReasoningEfforts; do
  grep -q "\"$field\"" "$output_dir/v2/ModelListResponse.json" \
    || fail "model catalog field $field disappeared"
done

echo "Codex App Server protocol verified: codex-cli $actual_version / $actual_checksum"
