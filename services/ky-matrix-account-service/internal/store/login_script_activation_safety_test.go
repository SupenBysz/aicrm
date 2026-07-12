package store

import (
	"os"
	"strings"
	"testing"
)

func TestRunResultCannotPromoteCandidateVersion(t *testing.T) {
	source, err := os.ReadFile("login_script_store.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	start := strings.Index(text, "func (s *Store) RecordLoginScriptRun(")
	end := strings.Index(text, "func (s *Store) CreateGeneratedLoginScriptCandidate(")
	if start < 0 || end <= start {
		t.Fatal("RecordLoginScriptRun source section not found")
	}
	recordSection := text[start:end]
	for _, forbidden := range []string{
		"active_version_id=",
		"SET status='active'",
		"SET status='archived'",
		"UPDATE ky_matrix_account_login_script_version",
	} {
		if strings.Contains(recordSection, forbidden) {
			t.Fatalf("run-result must not promote a candidate; found %q", forbidden)
		}
	}
}

func TestStoreHasNoUnguardedActivationMethod(t *testing.T) {
	source, err := os.ReadFile("login_script_store.go")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(source), "func (s *Store) ActivateLoginScriptVersion(") {
		t.Fatal("unguarded login script activation method must not exist")
	}
}

func TestEnablingScriptCannotIgnoreMissingActiveVersion(t *testing.T) {
	source, err := os.ReadFile("login_script_store.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	start := strings.Index(text, "func (s *Store) UpdateLoginScriptStatus(")
	end := strings.Index(text, "func missingLoginScriptReason(")
	if start < 0 || end <= start {
		t.Fatal("UpdateLoginScriptStatus source section not found")
	}
	section := text[start:end]
	if !strings.Contains(section, "errors.Is(err, sql.ErrNoRows)") || !strings.Contains(section, "return LoginScript{}, ErrValidation") {
		t.Fatal("enabling a script without an active version must fail closed")
	}
	if !strings.Contains(section, `versionStatus != "active"`) {
		t.Fatal("enabling a script must require an active version status")
	}
}
