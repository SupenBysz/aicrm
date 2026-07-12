package store

import (
	"os"
	"strings"
	"testing"
)

func TestLegacyExecutorCleanupMigrationIsOneShotAndFailClosed(t *testing.T) {
	body, err := os.ReadFile("../../../../ops/db/035_executor_legacy_output_cleanup.sql")
	if err != nil {
		t.Fatalf("read migration 035: %v", err)
	}
	sql := string(body)

	for _, forbidden := range []string{
		"CREATE TABLE",
		"ALTER TABLE",
		"DROP TABLE",
		"BEGIN;",
		"COMMIT;",
		"CODEX_HOME",
		"/root/",
		"/data/kyai_crm/codex-executors",
	} {
		if strings.Contains(sql, forbidden) {
			t.Fatalf("migration 035 contains forbidden schema/runtime material %q", forbidden)
		}
	}

	for _, required := range []string{
		"jsonb_typeof(config.capabilities) = 'object'",
		"auth_status = 'not_authorized'",
		"auth_method = ''",
		"auth_account_label = ''",
		"bound_device_id = ''",
		"last_auth_checked_at = NULL",
		"last_heartbeat_at = NULL",
		"auto_repair_enabled = false",
		"allow_page_actions = false",
		"allow_storage_read = false",
		"allow_cdp_runtime = false",
		"allow_script_save = false",
		"allow_auto_activate = false",
		"app_server_listen = 'stdio://'",
		"legacy_executor_runtime_disabled",
		"legacy_executor_output_redacted",
		"legacy_executor_error_redacted",
		"legacy_executor_result_redacted",
		"codex_thread_id = ''",
		"status IN ('pending', 'waiting_executor', 'running', 'waiting_user_scan')",
		"event.event_type LIKE 'codex.%'",
		"raw.raw_json <> jsonb_build_object('failureCode', 'legacy_executor_output_redacted')",
		"config.capabilities IS DISTINCT FROM sanitized.safe_capabilities",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("migration 035 is missing safety guard %q", required)
		}
	}
}
