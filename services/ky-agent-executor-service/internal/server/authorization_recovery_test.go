package server

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/credentialfs"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
)

func TestRecoverAuthorizationCredentialTreesCleansUnpreparedSession(t *testing.T) {
	manager, err := credentialfs.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	staging, err := manager.CreateStaging("aiexec_1", "session_1")
	if err != nil {
		t.Fatal(err)
	}
	operation, err := manager.OperationPath("aiexec_1", "auth_session_1")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(operation, 0o700); err != nil {
		t.Fatal(err)
	}

	items := []store.AuthorizationRecoveryItem{{
		SessionID: "session_1", ExecutorID: "aiexec_1", OperationID: "auth_session_1",
	}}
	if err := recoverAuthorizationCredentialTrees(manager, items); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{staging, operation} {
		if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("ephemeral path survived recovery: %s err=%v", path, err)
		}
	}
}

func TestRecoverAuthorizationCredentialTreesQuarantinesPreparedCandidatesIdempotently(t *testing.T) {
	manager, err := credentialfs.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	staging, err := manager.CreateStaging("aiexec_1", "session_1")
	if err != nil {
		t.Fatal(err)
	}
	revisionNumber := int64(2)
	revision, err := manager.RevisionPath("aiexec_1", revisionNumber)
	if err != nil {
		t.Fatal(err)
	}
	operation, err := manager.OperationPath("aiexec_1", "auth_session_1")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{revision, operation} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	items := []store.AuthorizationRecoveryItem{{
		SessionID: "session_1", ExecutorID: "aiexec_1",
		PreparedCredentialRevision: &revisionNumber, OperationID: "auth_session_1",
		BindingStatus: "quarantined",
	}}
	if err := recoverAuthorizationCredentialTrees(manager, items); err != nil {
		t.Fatal(err)
	}
	if err := recoverAuthorizationCredentialTrees(manager, items); err != nil {
		t.Fatalf("repeated recovery was not idempotent: %v", err)
	}
	for _, name := range []string{
		"recovery_staging_session_1", "recovery_revision_session_1", "recovery_operation_session_1",
	} {
		path, err := manager.QuarantinePath("aiexec_1", name)
		if err != nil {
			t.Fatal(err)
		}
		if info, err := os.Lstat(path); err != nil || !info.IsDir() {
			t.Fatalf("candidate was not quarantined: %s err=%v", path, err)
		}
	}
	if _, err := os.Lstat(staging); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staging source survived quarantine: %v", err)
	}
}

func TestRecoverAuthorizationCredentialTreesRejectsSymlink(t *testing.T) {
	root := t.TempDir()
	manager, err := credentialfs.New(root)
	if err != nil {
		t.Fatal(err)
	}
	staging, err := manager.StagingPath("aiexec_1", "session_1")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(staging), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), staging); err != nil {
		t.Fatal(err)
	}
	err = recoverAuthorizationCredentialTrees(manager, []store.AuthorizationRecoveryItem{{
		SessionID: "session_1", ExecutorID: "aiexec_1",
	}})
	if !errors.Is(err, credentialfs.ErrInvalidPath) {
		t.Fatalf("symlink recovery err=%v", err)
	}
}
