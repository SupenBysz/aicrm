#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEDGER_FILENAME="034_migration_ledger.sql"
BASELINE_MAX_VERSION=34
MIGRATION_LOCK_KEY=4701196508681632081

shopt -s nullglob
sql_paths=("$ROOT_DIR"/ops/db/[0-9][0-9][0-9]_*.sql)
shopt -u nullglob

if ((${#sql_paths[@]} == 0)); then
  echo "No database migrations found under $ROOT_DIR/ops/db." >&2
  exit 1
fi

sql_files=()
sql_versions=()
sql_checksums=()

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
    return
  fi
  echo "sha256sum or shasum is required to verify database migrations." >&2
  return 1
}

ledger_found=0
previous_version=-1
for path in "${sql_paths[@]}"; do
  file="$(basename "$path")"
  if [[ ! "$file" =~ ^([0-9]{3})_[a-z0-9_]+\.sql$ ]]; then
    echo "Invalid migration filename: $file" >&2
    exit 1
  fi
  version=$((10#${BASH_REMATCH[1]}))
  if ((version <= previous_version)); then
    echo "Migration versions must be unique and strictly increasing: $file" >&2
    exit 1
  fi
  previous_version="$version"
  checksum="$(sha256_file "$path")"
  if [[ ! "$checksum" =~ ^[a-f0-9]{64}$ ]]; then
    echo "Invalid SHA-256 for migration: $file" >&2
    exit 1
  fi
  if ((version > BASELINE_MAX_VERSION)); then
    if grep -Eq '^[[:space:]]*(BEGIN|COMMIT|ROLLBACK)[[:space:]]*;' "$path"; then
      echo "Migration $file contains transaction control; the ledger runner owns the transaction." >&2
      exit 1
    fi
    if grep -Eqi 'CREATE[[:space:]]+(UNIQUE[[:space:]]+)?INDEX[[:space:]]+CONCURRENTLY' "$path"; then
      echo "Migration $file contains CREATE INDEX CONCURRENTLY and cannot share the ledger transaction." >&2
      exit 1
    fi
  fi
  if [[ "$file" == "$LEDGER_FILENAME" ]]; then
    ledger_found=1
  fi
  sql_files+=("$file")
  sql_versions+=("$version")
  sql_checksums+=("$checksum")
done

if ((ledger_found != 1)); then
  echo "Required migration ledger file is missing: $LEDGER_FILENAME" >&2
  exit 1
fi

emit_records() {
  local mode="$1"
  local max_version="$2"
  local index
  for index in "${!sql_files[@]}"; do
    if ((${sql_versions[$index]} > max_version)); then
      continue
    fi
    printf "INSERT INTO ky_schema_migration (version, filename, checksum_sha256, applied_mode) VALUES (%d, '%s', '%s', '%s');\n" \
      "${sql_versions[$index]}" "${sql_files[$index]}" "${sql_checksums[$index]}" "$mode"
  done
}

emit_checksum_assertion() {
  local file="$1"
  local version="$2"
  local checksum="$3"
  printf '%s\n' \
    'DO $migration_checksum$' \
    'BEGIN' \
    "  IF NOT EXISTS (SELECT 1 FROM ky_schema_migration WHERE version = $version AND filename = '$file' AND checksum_sha256 = '$checksum') THEN" \
    "    RAISE EXCEPTION 'migration checksum mismatch: $file';" \
    '  END IF;' \
    'END' \
    '$migration_checksum$;'
}

emit_missing_baseline_failure() {
  local file="$1"
  printf '%s\n' \
    'DO $migration_baseline_entry$' \
    'BEGIN' \
    "  RAISE EXCEPTION 'migration ledger is missing required baseline entry: $file';" \
    'END' \
    '$migration_baseline_entry$;'
}

emit_migration_program() {
  local index file version checksum path

  printf '%s\n' \
    '\set ON_ERROR_STOP on' \
    "SELECT pg_advisory_lock($MIGRATION_LOCK_KEY);" \
    "SELECT to_regclass('public.ky_schema_migration') IS NOT NULL AS ledger_exists \gset" \
    '\if :ledger_exists'

  for index in "${!sql_files[@]}"; do
    file="${sql_files[$index]}"
    version="${sql_versions[$index]}"
    checksum="${sql_checksums[$index]}"
    path="$ROOT_DIR/ops/db/$file"

    printf "SELECT EXISTS (SELECT 1 FROM ky_schema_migration WHERE filename = '%s') AS migration_applied \\gset\n" "$file"
    printf '%s\n' '\if :migration_applied'
    emit_checksum_assertion "$file" "$version" "$checksum"
    printf '%s\n' '\else'
    if ((version <= BASELINE_MAX_VERSION)); then
      emit_missing_baseline_failure "$file"
    else
      printf '%s\n' 'BEGIN;'
      printf '\ir %s\n' "$path"
      printf "INSERT INTO ky_schema_migration (version, filename, checksum_sha256, applied_mode) VALUES (%d, '%s', '%s', 'migrate');\n" \
        "$version" "$file" "$checksum"
      printf '%s\n' 'COMMIT;'
    fi
    printf '%s\n' '\endif'
  done

  printf '%s\n' \
    '\else' \
    "SELECT to_regclass('public.ky_user') IS NULL AS fresh_database \gset"

  for index in "${!sql_files[@]}"; do
    version="${sql_versions[$index]}"
    if ((version >= BASELINE_MAX_VERSION)); then
      continue
    fi
    file="${sql_files[$index]}"
    path="$ROOT_DIR/ops/db/$file"
    if grep -Eq '^[[:space:]]*(BEGIN|COMMIT|ROLLBACK)[[:space:]]*;' "$path"; then
      printf '\ir %s\n' "$path"
    else
      printf '%s\n' 'BEGIN;'
      printf '\ir %s\n' "$path"
      printf '%s\n' 'COMMIT;'
    fi
  done

  printf '%s\n' \
    'BEGIN;' \
    "\\ir $ROOT_DIR/ops/db/$LEDGER_FILENAME"

  printf '%s\n' '\if :fresh_database'
  emit_records "bootstrap" "$BASELINE_MAX_VERSION"
  printf '%s\n' '\else'
  emit_records "baseline" "$BASELINE_MAX_VERSION"
  printf '%s\n' '\endif'

  for index in "${!sql_files[@]}"; do
    version="${sql_versions[$index]}"
    if ((version <= BASELINE_MAX_VERSION)); then
      continue
    fi
    file="${sql_files[$index]}"
    checksum="${sql_checksums[$index]}"
    printf '\ir %s\n' "$ROOT_DIR/ops/db/$file"
    printf "INSERT INTO ky_schema_migration (version, filename, checksum_sha256, applied_mode) VALUES (%d, '%s', '%s', 'migrate');\n" \
      "$version" "$file" "$checksum"
  done

  printf '%s\n' \
    'COMMIT;' \
    '\endif' \
    "SELECT pg_advisory_unlock($MIGRATION_LOCK_KEY);"
}

if [[ "${KY_DATABASE_DEPLOY_RENDER_SQL:-}" == "1" ]]; then
  emit_migration_program
  exit 0
fi

echo "Database deploy dry run. Files are governed in order:"
for file in "${sql_files[@]}"; do
  echo "- $ROOT_DIR/ops/db/$file"
done

echo "Set KY_EXECUTE_DATABASE_DEPLOY=1 to execute with checksum ledger and advisory lock."
if [[ "${KY_EXECUTE_DATABASE_DEPLOY:-}" != "1" ]]; then
  exit 0
fi

: "${KY_TENANT_DATABASE_URL:?KY_TENANT_DATABASE_URL is required when KY_EXECUTE_DATABASE_DEPLOY=1}"
if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required to deploy database migrations." >&2
  exit 1
fi

emit_migration_program | psql "$KY_TENANT_DATABASE_URL" -X -v ON_ERROR_STOP=1
