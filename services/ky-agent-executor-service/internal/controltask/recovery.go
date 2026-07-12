package controltask

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/credentialfs"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
)

type recoveredControlTaskFailure struct {
	taskID string
	code   string
}

func (e recoveredControlTaskFailure) Error() string {
	return fmt.Sprintf("control task %s recovered as failed: %s", e.taskID, e.code)
}

// Recover performs the startup half of the control-task reconciler.  It does
// not wait for a former owner's still-valid lease; Start keeps reconciling and
// will claim it only after PostgreSQL declares it expired.
func (m *Manager) Recover(ctx context.Context) error {
	for {
		recovered, err := m.reconcileOne(ctx)
		if err != nil {
			return err
		}
		if !recovered {
			break
		}
	}
	return m.cleanupTerminalControlTasks(ctx)
}

func (m *Manager) reconcileOne(ctx context.Context) (bool, error) {
	item, found, err := m.store.ClaimExpiredControlTaskRecovery(
		ctx, m.cfg.OwnerInstanceID, m.cfg.CodexVersion,
	)
	if err != nil || !found {
		return false, err
	}
	if item.Terminalized {
		return true, m.quarantineRecoveryPaths(item)
	}
	err = m.recoverClaimedControlTask(ctx, item)
	var recoveredFailure recoveredControlTaskFailure
	if errors.As(err, &recoveredFailure) {
		m.reportError(recoveredFailure)
		return true, nil
	}
	return true, err
}

func (m *Manager) recoverClaimedControlTask(ctx context.Context, item store.ControlTaskRecoveryItem) error {
	if item.CandidateRevision == nil ||
		(item.BindingStatus != "prepared" && item.BindingStatus != "committing") ||
		item.BindingDigest == "" {
		return errors.New("claimed control task recovery is incomplete")
	}
	work := item.Work
	runCtx, stopRenewal := m.startLeaseRenewal(ctx, work)
	renewalStopped := false
	defer func() {
		if !renewalStopped {
			_ = stopRenewal()
		}
	}()
	abort := func(code string) error {
		if !renewalStopped {
			_ = stopRenewal()
			renewalStopped = true
		}
		failCtx, cancel := context.WithTimeout(context.Background(), controlTaskDatabaseTimeout)
		defer cancel()
		if err := m.store.FailControlTask(failCtx, work, "failed", code, false); err != nil {
			// An ambiguous or fenced DB result means another epoch may own the
			// candidate.  Never touch its paths in that case.
			return fmt.Errorf("fence failed recovered control task %s: %w", work.TaskID, err)
		}
		if err := m.quarantineRecoveryPaths(item); err != nil {
			return fmt.Errorf("quarantine failed recovered control task %s: %w", work.TaskID, err)
		}
		return recoveredControlTaskFailure{taskID: work.TaskID, code: code}
	}

	lock, err := m.credentials.AcquireExecutorLock(runCtx, work.ExecutorID)
	if err != nil {
		return abort("credential_commit_failed")
	}
	defer lock.Close()
	operationPath, err := m.credentials.OperationPath(work.ExecutorID, work.OperationID)
	if err != nil {
		return abort("credential_commit_failed")
	}
	revisionPath, err := m.credentials.RevisionPath(work.ExecutorID, *item.CandidateRevision)
	if err != nil {
		return abort("credential_commit_failed")
	}
	operationExists, err := safeDirectoryExists(operationPath)
	if err != nil {
		return abort("credential_commit_failed")
	}
	revisionExists, err := safeDirectoryExists(revisionPath)
	if err != nil {
		return abort("credential_commit_failed")
	}

	switch {
	case item.BindingStatus == "prepared" && operationExists && !revisionExists:
		digest, err := credentialfs.DigestTree(operationPath)
		if err != nil || digest != item.BindingDigest {
			return abort("credential_commit_failed")
		}
		if err := m.store.MarkControlTaskCredentialCommitting(
			runCtx, work, *item.CandidateRevision, item.BindingDigest,
		); err != nil {
			return abort("credential_commit_failed")
		}
		if _, err := m.credentials.PromoteOperation(
			work.ExecutorID, work.OperationID, *item.CandidateRevision, item.BindingDigest,
		); err != nil {
			return abort("credential_commit_failed")
		}
	case item.BindingStatus == "committing" && operationExists && !revisionExists:
		digest, err := credentialfs.DigestTree(operationPath)
		if err != nil || digest != item.BindingDigest {
			return abort("credential_commit_failed")
		}
		if _, err := m.credentials.PromoteOperation(
			work.ExecutorID, work.OperationID, *item.CandidateRevision, item.BindingDigest,
		); err != nil {
			return abort("credential_commit_failed")
		}
	case item.BindingStatus == "committing" && !operationExists && revisionExists:
		if err := credentialfs.ValidateReadOnlyTree(revisionPath); err != nil {
			return abort("credential_commit_failed")
		}
		digest, err := credentialfs.DigestTree(revisionPath)
		if err != nil || digest != item.BindingDigest {
			return abort("credential_commit_failed")
		}
	default:
		// prepared+revision, both paths, neither path, and every other
		// combination are ambiguous and must fail closed.
		return abort("credential_commit_failed")
	}

	catalog, err := m.verifyPromotedRevisionForRecovery(
		runCtx, work, *item.CandidateRevision, revisionPath, item.BindingDigest,
		work.TaskType != "credential_verify",
	)
	if err != nil {
		return abort("verification_failed")
	}
	if err := m.finishRenewal(work, stopRenewal); err != nil {
		renewalStopped = true
		return abort("executor_operation_fenced")
	}
	renewalStopped = true
	input := store.CompleteControlTaskInput{
		Work: work, Models: catalog, CodexVersion: m.cfg.CodexVersion,
		PromotedCredentialRevision: item.CandidateRevision,
		PromotedBindingDigest:      item.BindingDigest,
	}
	switch work.TaskType {
	case "credential_verify":
		verified := true
		input.CredentialAuthorized = &verified
	case "readiness_check":
		input.ReadinessStatus, input.ReadinessReasonCode = readiness(catalog, work.DefaultModelKey)
	}
	completeCtx, cancel := context.WithTimeout(context.Background(), controlTaskDatabaseTimeout)
	defer cancel()
	if err := m.store.CompleteControlTask(completeCtx, input); err != nil {
		// The commit result is ambiguous.  Preserve both DB and filesystem
		// state for the next lease-expiry reconciliation and surface the error.
		return fmt.Errorf("complete recovered control task %s: %w", work.TaskID, err)
	}
	return nil
}

func (m *Manager) verifyPromotedRevisionForRecovery(
	ctx context.Context,
	work store.ControlTaskWork,
	revision int64,
	promotedPath string,
	expectedDigest string,
	includeModels bool,
) ([]store.ModelCatalogEntry, error) {
	if err := m.store.RenewControlTaskLease(ctx, work); err != nil {
		return nil, err
	}
	if err := credentialfs.ValidateReadOnlyTree(promotedPath); err != nil {
		return nil, err
	}
	digest, err := credentialfs.DigestTree(promotedPath)
	if err != nil || digest != expectedDigest {
		return nil, credentialfs.ErrDigestMismatch
	}
	verificationHome, err := m.credentials.CloneRevision(work.ExecutorID, revision, work.OperationID)
	if err != nil {
		return nil, err
	}
	removed := false
	defer func() {
		if !removed {
			_ = m.credentials.RemoveEphemeral(verificationHome)
		}
	}()
	account, models, authorized, err := m.runOperation(
		ctx, work.OperationID, verificationHome, includeModels,
	)
	if err != nil || !authorized || account == nil {
		return nil, errors.New("promoted credential verification failed")
	}
	fingerprint, _ := safeAccount(account)
	if fingerprint != work.AccountFingerprint {
		return nil, errors.New("promoted credential account changed")
	}
	catalog := []store.ModelCatalogEntry(nil)
	if includeModels {
		catalog, err = sanitizeModels(models)
		if err != nil {
			return nil, err
		}
	}
	if err := m.credentials.RemoveEphemeral(verificationHome); err != nil {
		return nil, err
	}
	removed = true
	if err := m.store.RenewControlTaskLease(ctx, work); err != nil {
		return nil, err
	}
	digest, err = credentialfs.DigestTree(promotedPath)
	if err != nil || digest != expectedDigest {
		return nil, credentialfs.ErrDigestMismatch
	}
	if err := credentialfs.ValidateReadOnlyTree(promotedPath); err != nil {
		return nil, err
	}
	return catalog, nil
}

func (m *Manager) cleanupTerminalControlTasks(ctx context.Context) error {
	items, err := m.store.ListControlTaskCredentialCleanup(ctx)
	if err != nil {
		return err
	}
	for _, item := range items {
		if err := m.quarantineRecoveryPaths(item); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) quarantineRecoveryPaths(item store.ControlTaskRecoveryItem) error {
	work := item.Work
	operationPath, err := m.credentials.OperationPath(work.ExecutorID, work.OperationID)
	if err != nil {
		return err
	}
	if exists, err := safeDirectoryExists(operationPath); err != nil {
		return err
	} else if exists {
		if _, err := m.credentials.Quarantine(
			work.ExecutorID, operationPath,
			"control_recovery_operation_"+digestString(work.TaskID)[:16],
		); err != nil {
			return fmt.Errorf("quarantine operation path: %w", err)
		}
	}
	for _, revision := range item.CleanupRevisions {
		revisionPath, err := m.credentials.RevisionPath(work.ExecutorID, revision)
		if err != nil {
			return err
		}
		if exists, err := safeDirectoryExists(revisionPath); err != nil {
			return err
		} else if exists {
			if _, err := m.credentials.Quarantine(
				work.ExecutorID, revisionPath,
				fmt.Sprintf("control_recovery_revision_%d_%s", revision, digestString(work.TaskID)[:16]),
			); err != nil {
				return fmt.Errorf("quarantine revision %d: %w", revision, err)
			}
		}
	}
	return nil
}

func safeDirectoryExists(path string) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false, credentialfs.ErrInvalidPath
	}
	return true, nil
}
