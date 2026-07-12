package store

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestP2AAuthorizationMigrationContainsLockedResourcesWithoutRawSecrets(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate migration test")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "..", "..", "..", "..", "ops", "db", "040_agent_executor_authorization_runtime.sql"))
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sql := string(body)
	for _, required := range []string{
		"max_concurrency = 1",
		"ky_ai_executor_safe_metadata",
		"ky_ai_executor_account_summary_is_safe",
		"ky_ai_executor_runtime_worker",
		"ky_ai_executor_desktop_handoff",
		"ky_ai_executor_desktop_authorization_proof",
		"ky_ai_executor_credential_activation",
		"ky_ai_executor_desktop_command_operation",
		"ky_ai_executor_credential_revocation",
		"ticket_hash text NOT NULL",
		"claim_token_hash text NOT NULL DEFAULT ''",
		"activation_token_hash text NOT NULL UNIQUE",
		"command_ticket_hash text NOT NULL UNIQUE",
		"interval '120 seconds'",
		"interval '10 minutes'",
		"platform.ai_executors.change_account",
		"platform.ai_executors.force_revoke",
		"platform.ai_executors.bind_device",
		"platform.ai_executors.rebind_device",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("migration 040 missing %q", required)
		}
	}
	for _, forbidden := range []string{
		" auth_url text", " verification_url text", " user_code text", " login_id text",
		" codex_home text", " credential_path text", " staging_path text", " raw_output text",
		"REFERENCES ky_user", "REFERENCES ky_membership", "REFERENCES ky_matrix",
	} {
		if strings.Contains(strings.ToLower(sql), strings.ToLower(forbidden)) {
			t.Fatalf("migration 040 contains forbidden raw or cross-service column %q", forbidden)
		}
	}
}
