package controltask

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/credentialfs"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
)

func TestControlTaskRecoveryCrashPointMatrix(t *testing.T) {
	for _, test := range []struct {
		name          string
		bindingStatus string
		layout        string
	}{
		{name: "after_prepare_before_committing", bindingStatus: "prepared", layout: "operation"},
		{name: "after_committing_before_rename", bindingStatus: "committing", layout: "operation"},
		{name: "after_rename_before_complete", bindingStatus: "committing", layout: "revision"},
	} {
		t.Run(test.name, func(t *testing.T) {
			manager, runtimeStore, credentials, item := newRecoveryFixture(t, test.bindingStatus, test.layout)
			if err := manager.Recover(context.Background()); err != nil {
				t.Fatal(err)
			}
			select {
			case completed := <-runtimeStore.completed:
				if completed.PromotedCredentialRevision == nil ||
					*completed.PromotedCredentialRevision != *item.CandidateRevision ||
					completed.PromotedBindingDigest != item.BindingDigest || len(completed.Models) != 1 {
					t.Fatalf("completion=%#v", completed)
				}
			default:
				t.Fatal("recovered task did not complete")
			}
			if test.bindingStatus == "prepared" && runtimeStore.committingCalls != 1 {
				t.Fatalf("prepared candidate committing calls=%d", runtimeStore.committingCalls)
			}
			revisionPath, _ := credentials.RevisionPath(item.Work.ExecutorID, *item.CandidateRevision)
			if err := credentialfs.ValidateReadOnlyTree(revisionPath); err != nil {
				t.Fatalf("recovered revision is not immutable: %v", err)
			}
			operationPath, _ := credentials.OperationPath(item.Work.ExecutorID, item.Work.OperationID)
			if _, err := os.Stat(operationPath); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("recovery operation survived: %v", err)
			}
		})
	}
}

func TestControlTaskRecoveryAmbiguousFilesystemMatricesFailClosed(t *testing.T) {
	for _, layout := range []string{"both", "neither", "prepared_revision"} {
		t.Run(layout, func(t *testing.T) {
			status := "committing"
			if layout == "prepared_revision" {
				status = "prepared"
			}
			manager, runtimeStore, credentials, item := newRecoveryFixture(t, status, layout)
			reported := make(chan error, 1)
			manager.reportError = func(err error) { reported <- err }
			if err := manager.Recover(context.Background()); err != nil {
				t.Fatalf("safely terminalized recovery blocked startup: %v", err)
			}
			select {
			case failure := <-runtimeStore.failed:
				if failure.code != "credential_commit_failed" {
					t.Fatalf("failure=%#v", failure)
				}
			default:
				t.Fatal("ambiguous matrix was not fenced in DB")
			}
			select {
			case <-reported:
			default:
				t.Fatal("ambiguous matrix did not raise an operational alert")
			}
			operationPath, _ := credentials.OperationPath(item.Work.ExecutorID, item.Work.OperationID)
			revisionPath, _ := credentials.RevisionPath(item.Work.ExecutorID, *item.CandidateRevision)
			if _, err := os.Stat(operationPath); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("ambiguous operation path survived: %v", err)
			}
			if _, err := os.Stat(revisionPath); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("ambiguous revision path survived: %v", err)
			}
		})
	}
}

func TestControlTaskRecoveryDigestMismatchQuarantinesAfterDatabaseFailure(t *testing.T) {
	manager, runtimeStore, credentials, item := newRecoveryFixture(t, "committing", "operation")
	item.BindingDigest = digestString("wrong digest")
	runtimeStore.recoveryItems[0] = item
	manager.reportError = func(error) {}
	if err := manager.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case failure := <-runtimeStore.failed:
		if failure.code != "credential_commit_failed" {
			t.Fatalf("failure=%#v", failure)
		}
	default:
		t.Fatal("digest mismatch did not fail task")
	}
	operationPath, _ := credentials.OperationPath(item.Work.ExecutorID, item.Work.OperationID)
	if _, err := os.Stat(operationPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("mismatched operation was not quarantined: %v", err)
	}
}

func TestControlTaskRecoveryPreservesCandidateOnAmbiguousComplete(t *testing.T) {
	manager, runtimeStore, credentials, item := newRecoveryFixture(t, "committing", "revision")
	runtimeStore.completeErr = context.DeadlineExceeded
	err := manager.Recover(context.Background())
	if err == nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Recover error=%v", err)
	}
	revisionPath, _ := credentials.RevisionPath(item.Work.ExecutorID, *item.CandidateRevision)
	if err := credentialfs.ValidateReadOnlyTree(revisionPath); err != nil {
		t.Fatalf("ambiguous completion destroyed candidate: %v", err)
	}
}

func newRecoveryFixture(
	t *testing.T,
	bindingStatus string,
	layout string,
) (*Manager, *fakeRuntimeStore, *credentialfs.Manager, store.ControlTaskRecoveryItem) {
	t.Helper()
	credentials, err := credentialfs.New(filepath.Join(t.TempDir(), "executors"))
	if err != nil {
		t.Fatal(err)
	}
	staging, _ := credentials.CreateStaging("aiexec_recovery", "auth_1")
	_ = os.WriteFile(filepath.Join(staging, "auth.json"), []byte("original"), 0o600)
	sourceDigest, _ := credentialfs.DigestTree(staging)
	_, _ = credentials.Promote("aiexec_recovery", "auth_1", 1, sourceDigest)
	operationID := "control_recovery_1"
	operationPath, err := credentials.CloneRevision("aiexec_recovery", 1, operationID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(operationPath, "auth.json"), []byte("rotated"), 0o600); err != nil {
		t.Fatal(err)
	}
	candidateDigest, _ := credentialfs.DigestTree(operationPath)
	if layout == "revision" || layout == "both" || layout == "prepared_revision" {
		if _, err := credentials.PromoteOperation("aiexec_recovery", operationID, 2, candidateDigest); err != nil {
			t.Fatal(err)
		}
	}
	if layout == "both" {
		if _, err := credentials.CloneRevision("aiexec_recovery", 1, operationID); err != nil {
			t.Fatal(err)
		}
	}
	if layout == "neither" {
		if err := credentials.RemoveEphemeral(operationPath); err != nil {
			t.Fatal(err)
		}
	}
	email := "owner@example.com"
	revision := int64(2)
	work := store.ControlTaskWork{
		TaskID: "task_recovery_1", WorkspaceType: "platform", WorkspaceID: "platform_root",
		ExecutorID: "aiexec_recovery", TaskType: "model_catalog_refresh",
		OperationID: operationID, OwnerInstanceID: "owner_after_restart", LeaseEpoch: 8,
		ExecutorConfigRevision: 7, CredentialRevision: 1, CatalogRevision: 2,
		RuntimeBindingID: "server_1", RuntimeBindingRevision: 1, RevocationEpoch: 4,
		DefaultModelKey: "gpt-5.6", AccountFingerprint: digestString("chatgpt\n" + email),
		PlanType: "plus", AuthMode: "device_code", BindingDigest: sourceDigest,
		TaskTimeoutSeconds: 30,
	}
	item := store.ControlTaskRecoveryItem{
		Work: work, CandidateRevision: &revision, BindingStatus: bindingStatus,
		BindingDigest: candidateDigest, CleanupRevisions: []int64{revision},
	}
	runtimeStore := newFakeRuntimeStore(work)
	runtimeStore.recoveryItems = []store.ControlTaskRecoveryItem{item}
	manager, err := New(runtimeStore, &scriptedLauncher{email: email}, credentials, Config{
		OwnerInstanceID: "owner_after_restart", CodexVersion: "0.144.1",
		ReportError: func(error) {},
	})
	if err != nil {
		t.Fatal(err)
	}
	return manager, runtimeStore, credentials, item
}
