package store

import (
	"os"
	"strings"
	"testing"
)

func TestMatrixP1ContractMigrationIsAdditiveAndFailClosed(t *testing.T) {
	sql := readMatrixMigration(t, "036_matrix_login_script_contract_expand.sql")

	for _, forbidden := range []string{
		"BEGIN;", "COMMIT;", "DROP TABLE", "DROP COLUMN", "CREATE EXTENSION",
		"REFERENCES ky_ai_executor", "REFERENCES ky_user", "REFERENCES ky_membership", "REFERENCES ky_org",
	} {
		if strings.Contains(sql, forbidden) {
			t.Fatalf("migration 036 contains forbidden coupling or contraction %q", forbidden)
		}
	}

	for _, required := range []string{
		"ADD COLUMN IF NOT EXISTS executor_id text",
		"ADD COLUMN IF NOT EXISTS model_key_override text",
		"generation_engine text NOT NULL DEFAULT 'legacy_provider'",
		"config_revision bigint NOT NULL DEFAULT 1",
		"effective_executor_id text",
		"effective_model_key text",
		"executor_source text",
		"model_source text",
		"credential_binding_revision bigint",
		"runtime_binding_revision bigint",
		"model_catalog_revision bigint",
		"ADD COLUMN IF NOT EXISTS dsl_hash text",
		"ky_matrix_account_set_login_script_dsl_hash",
		"ky_matrix_account_guard_login_script_version_update",
		"ky_matrix_account_login_script_version_frozen_guard_trg",
		"ky_matrix_account_login_script_version_one_active_uidx",
		"CREATE TABLE IF NOT EXISTS ky_matrix_account_login_script_contract (",
		"current_revision bigint NOT NULL",
		"status text NOT NULL DEFAULT 'disabled'",
		"CREATE TABLE IF NOT EXISTS ky_matrix_account_login_script_contract_revision (",
		"method_schema_json <> '{}'::jsonb",
		"acceptance_schema_json <> '{}'::jsonb",
		"schema_hash text NOT NULL",
		"ky_matrix_account_login_script_contract_revision_immutable_trg",
		"DEFERRABLE INITIALLY DEFERRED",
		"matrix_account_login_scripts.assign_executor",
		"matrix_account_login_scripts.assign_model",
		"role_platform_owner",
		"role_platform_admin",
		"role_agency_owner_template",
		"role_enterprise_owner_template",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("migration 036 is missing locked contract %q", required)
		}
	}

	headStart := strings.Index(sql, "CREATE TABLE IF NOT EXISTS ky_matrix_account_login_script_contract (")
	if headStart < 0 {
		t.Fatal("contract head definition not found")
	}
	headEnd := strings.Index(sql[headStart:], ");")
	if headEnd < 0 {
		t.Fatal("contract head definition is not terminated")
	}
	head := sql[headStart : headStart+headEnd]
	for _, forbiddenHeadField := range []string{"method_schema_json", "acceptance_schema_json", "schema_hash", "config_revision"} {
		if strings.Contains(head, forbiddenHeadField) {
			t.Fatalf("contract head must not duplicate immutable revision field %q", forbiddenHeadField)
		}
	}
}

func TestMatrixP1GenerationMigrationLocksSafeSnapshotAndRunIdentity(t *testing.T) {
	sql := readMatrixMigration(t, "037_matrix_login_script_generation_expand.sql")

	for _, forbidden := range []string{
		"BEGIN;", "COMMIT;", "DROP TABLE", "DROP COLUMN", "CREATE EXTENSION",
		"REFERENCES ky_ai_executor", "REFERENCES ky_user", "REFERENCES ky_membership", "REFERENCES ky_org",
		"executor_task_id",
	} {
		if strings.Contains(sql, forbidden) {
			t.Fatalf("migration 037 contains forbidden coupling or second run identity %q", forbidden)
		}
	}

	for _, required := range []string{
		"ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1",
		"CREATE TABLE IF NOT EXISTS ky_matrix_account_login_script_context_snapshot (",
		"num_nonnulls(web_space_id, script_id) = 1",
		"expires_at = created_at + interval '30 minutes'",
		"payload - ARRAY['title', 'visibleText', 'landmarks', 'elements']",
		"item - ARRAY[",
		"'elementKey', 'keySource', 'stability', 'role', 'accessibleName'",
		"jsonb_array_length(payload->'elements') > 200",
		"octet_length(payload::text) > 262144",
		"ky_matrix_account_context_payload_is_safe",
		"ky_matrix_account_login_script_context_update_guard_trg",
		"CREATE TABLE IF NOT EXISTS ky_matrix_account_login_script_generation_run (",
		"id text PRIMARY KEY",
		"context_snapshot_id text REFERENCES ky_matrix_account_login_script_context_snapshot",
		"idempotency_key_hash text NOT NULL",
		"request_hash text NOT NULL",
		"dispatch_lease_expires_at timestamptz",
		"current_sequence bigint NOT NULL DEFAULT 0",
		"revision bigint NOT NULL DEFAULT 1",
		"CREATE TABLE IF NOT EXISTS ky_matrix_account_login_script_generation_run_event (",
		"UNIQUE (generation_run_id, sequence)",
		"CREATE TABLE IF NOT EXISTS ky_matrix_account_login_script_contract_test_result (",
		"generation_run_id text NOT NULL UNIQUE",
		"generation.status NOT IN ('materializing', 'succeeded')",
		"version_status <> 'candidate'",
		"CREATE TABLE IF NOT EXISTS ky_matrix_account_outbox (",
		"dedupe_key text NOT NULL UNIQUE",
		"ADD COLUMN IF NOT EXISTS generation_run_id text",
		"ky_matrix_account_login_script_version_generation_run_fk",
		"ky_matrix_account_login_script_version_generation_run_guard_trg",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("migration 037 is missing locked generation contract %q", required)
		}
	}

	for _, sensitiveKey := range []string{
		"cookie", "storage", "indexeddb", "token", "password", "credential", "proof", "receipt",
		"screenshot", "dataurl", "rawdom", "rawoutput", "javascript", "xpath", "filepath",
	} {
		if !strings.Contains(sql, sensitiveKey) {
			t.Fatalf("migration 037 safe payload guard is missing %q", sensitiveKey)
		}
	}
}

func readMatrixMigration(t *testing.T, name string) string {
	t.Helper()
	body, err := os.ReadFile("../../../../ops/db/" + name)
	if err != nil {
		t.Fatalf("read migration %s: %v", name, err)
	}
	return string(body)
}
