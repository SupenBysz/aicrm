#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/dist/services"
mkdir -p "$OUT_DIR"

services=(
  ky-auth-service
  ky-org-service
  ky-membership-service
  ky-ai-model-service
  ky-matrix-account-service
)

for service in "${services[@]}"; do
  echo "Building $service"
  go build -o "$OUT_DIR/$service" "$ROOT_DIR/services/$service/cmd/server"
done

echo "Service binaries written to $OUT_DIR"
