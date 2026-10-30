#!/bin/sh
# Isolated local PostgreSQL only. Never accepts a runtime database URL.
set -eu
pgbin=${KYCRM_TEST_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
pgdir=$(mktemp -d /tmp/kycrm-documents-pg.XXXXXX)
"$pgbin/initdb" -D "$pgdir/data" -A trust -U documents_test > "$pgdir/init.log"
trap '"$pgbin/pg_ctl" -D "$pgdir/data" stop -m fast > /dev/null' EXIT
"$pgbin/pg_ctl" -D "$pgdir/data" -l "$pgdir/server.log" -o "-h '' -k $pgdir" start
"$pgbin/createdb" -h "$pgdir" -U documents_test kycrm_test_documents
KYCRM_DOCUMENTS_TEST_DATABASE_URL="postgres://documents_test@/kycrm_test_documents?host=$pgdir" go test ./services/ky-org-service/internal/store -run 'TestDocuments' -count=1

KYCRM_DOCUMENTS_TEST_DATABASE_URL="postgres://documents_test@/kycrm_test_documents?host=$pgdir" go test ./services/ky-org-service/internal/server -run TestPublicDocument -count=1
