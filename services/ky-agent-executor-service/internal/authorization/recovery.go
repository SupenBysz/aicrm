package authorization

import (
	"context"
	"errors"
	"os"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/appserver"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/credentialfs"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
)

func (m *Manager) Recover(ctx context.Context, items []store.AuthorizationRecoveryItem) error {
	for _, item := range items {
		if item.PreparedCredentialRevision == nil || item.BindingStatus == "quarantined" {
			continue
		}
		claimed, err := m.claimRecovery(ctx, item)
		if err != nil {
			return err
		}
		if err := m.recoverClaimedCredential(ctx, claimed); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) claimRecovery(ctx context.Context, item store.AuthorizationRecoveryItem) (store.AuthorizationRecoveryItem, error) {
	claimCtx, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		claimed, err := m.store.ClaimServerCredentialRecovery(claimCtx, item, m.ownerInstanceID)
		if err == nil {
			return claimed, nil
		}
		if !errors.Is(err, store.ErrExecutorBusy) {
			return store.AuthorizationRecoveryItem{}, err
		}
		select {
		case <-claimCtx.Done():
			return store.AuthorizationRecoveryItem{}, store.ErrExecutorBusy
		case <-ticker.C:
		}
	}
}

func (m *Manager) recoverClaimedCredential(ctx context.Context, item store.AuthorizationRecoveryItem) error {
	prep := store.CredentialPreparation{
		ExecutorID: item.ExecutorID, OwnerInstanceID: item.OwnerInstanceID,
		CredentialRevision: *item.PreparedCredentialRevision,
		SessionRevision:    item.SessionRevision, LeaseEpoch: item.LeaseEpoch,
		SourceCredentialRevision: item.SourceCredentialRevision,
		RevocationEpoch:          item.RevocationEpoch, BindingDigest: item.BindingDigest,
	}
	session := store.AuthorizationSessionProjection{ID: item.SessionID, ExecutorID: item.ExecutorID}
	leaseCtx, stopLeaseRenewal := m.startLeaseRenewal(ctx, prep, item.OperationID)
	leaseRenewalStopped := false
	defer func() {
		if !leaseRenewalStopped {
			_ = stopLeaseRenewal()
		}
	}()
	abort := func(code string) error {
		err := m.failCredentialCandidate(session, prep, item.OperationID, code, ctx)
		_ = stopLeaseRenewal()
		leaseRenewalStopped = true
		return err
	}
	executorLock, err := m.credentials.AcquireExecutorLock(leaseCtx, item.ExecutorID)
	if err != nil {
		return abort("credential_commit_failed")
	}
	defer executorLock.Close()
	operationPath, err := m.credentials.OperationPath(item.ExecutorID, item.OperationID)
	if err != nil {
		return abort("credential_commit_failed")
	}
	operationExists, err := credentialDirectoryExists(operationPath)
	if err != nil {
		return abort("credential_commit_failed")
	}
	if operationExists {
		if err := m.credentials.RemoveEphemeral(operationPath); err != nil {
			return abort("credential_commit_failed")
		}
	}
	stagingPath, err := m.credentials.StagingPath(item.ExecutorID, item.SessionID)
	if err != nil {
		return abort("credential_commit_failed")
	}
	revisionPath, err := m.credentials.RevisionPath(item.ExecutorID, prep.CredentialRevision)
	if err != nil {
		return abort("credential_commit_failed")
	}
	stagingExists, err := credentialDirectoryExists(stagingPath)
	if err != nil {
		return abort("credential_commit_failed")
	}
	revisionExists, err := credentialDirectoryExists(revisionPath)
	if err != nil {
		return abort("credential_commit_failed")
	}

	switch {
	case item.BindingStatus == "prepared" && stagingExists && !revisionExists:
		digest, err := credentialfs.DigestTree(stagingPath)
		if err != nil || digest != prep.BindingDigest {
			return abort("credential_commit_failed")
		}
		if err := m.store.MarkCredentialCommitting(leaseCtx, prep, item.OperationID); err != nil {
			return abort("credential_commit_failed")
		}
		if _, err := m.credentials.Promote(item.ExecutorID, item.SessionID, prep.CredentialRevision, prep.BindingDigest); err != nil {
			return abort("credential_commit_failed")
		}
	case item.BindingStatus == "committing" && stagingExists && !revisionExists:
		digest, err := credentialfs.DigestTree(stagingPath)
		if err != nil || digest != prep.BindingDigest {
			return abort("credential_commit_failed")
		}
		if _, err := m.credentials.Promote(item.ExecutorID, item.SessionID, prep.CredentialRevision, prep.BindingDigest); err != nil {
			return abort("credential_commit_failed")
		}
	case item.BindingStatus == "committing" && !stagingExists && revisionExists:
		if err := credentialfs.ValidateReadOnlyTree(revisionPath); err != nil {
			return abort("credential_commit_failed")
		}
		digest, err := credentialfs.DigestTree(revisionPath)
		if err != nil || digest != prep.BindingDigest {
			return abort("credential_commit_failed")
		}
	default:
		return abort("credential_commit_failed")
	}

	verificationHome, err := m.credentials.CloneRevision(item.ExecutorID, prep.CredentialRevision, item.OperationID)
	if err != nil {
		return abort("verification_failed")
	}
	verificationRemoved := false
	defer func() {
		if !verificationRemoved {
			_ = m.credentials.RemoveEphemeral(verificationHome)
		}
	}()
	process, err := m.launcher.Launch(leaseCtx, item.OperationID, verificationHome)
	if err != nil {
		return abort("app_server_start_failed")
	}
	client := appserver.NewClient(process)
	clientClosed := false
	defer func() {
		if !clientClosed {
			_ = client.Close()
		}
	}()
	if err := client.Initialize(leaseCtx, "aicrm-agent-executor-recovery"); err != nil {
		return abort("app_server_protocol_unsupported")
	}
	accountResult, err := client.ReadAccount(leaseCtx, false)
	if err != nil || accountResult.Account == nil || accountResult.RequiresOpenAIAuth {
		return abort("verification_failed")
	}
	models, err := client.ListModels(leaseCtx)
	if err != nil {
		return abort("verification_failed")
	}
	catalog, err := sanitizeModels(models)
	if err != nil {
		return abort("app_server_protocol_unsupported")
	}
	if err := client.Close(); err != nil {
		return abort("app_server_start_failed")
	}
	clientClosed = true
	if err := m.credentials.RemoveEphemeral(verificationHome); err != nil {
		return abort("credential_commit_failed")
	}
	verificationRemoved = true
	fingerprint, summary, planType := safeAccount(accountResult.Account)
	if fingerprint != item.AccountFingerprint || planType != item.PlanType {
		return abort("verification_failed")
	}
	if err := credentialfs.ValidateReadOnlyTree(revisionPath); err != nil {
		return abort("credential_commit_failed")
	}
	digest, err := credentialfs.DigestTree(revisionPath)
	if err != nil || digest != prep.BindingDigest {
		return abort("credential_commit_failed")
	}
	if err := stopLeaseRenewal(); err != nil {
		leaseRenewalStopped = true
		return m.failCredentialCandidate(session, prep, item.OperationID, "credential_commit_failed", ctx)
	}
	leaseRenewalStopped = true
	if err := m.store.RenewServerCredentialLease(ctx, prep, item.OperationID); err != nil {
		return m.failCredentialCandidate(session, prep, item.OperationID, "credential_commit_failed", ctx)
	}
	_, err = m.store.ActivateServerCredential(ctx, store.ActivateServerCredentialInput{
		SessionID: item.SessionID, OwnerInstanceID: item.OwnerInstanceID,
		OperationID: item.OperationID, Preparation: prep,
		AccountSummaryJSON: summary, AccountFingerprint: fingerprint,
		RuntimeBindingID:       item.RuntimeBindingID,
		RuntimeBindingRevision: item.RuntimeBindingRevision,
		CodexVersion:           m.codexVersion, Models: catalog,
	})
	if err != nil {
		return m.failCredentialCandidate(session, prep, item.OperationID, "credential_commit_failed", ctx)
	}
	return nil
}

func credentialDirectoryExists(path string) (bool, error) {
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
