package controltask

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/appserver"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/credentialfs"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
)

var safeCatalogValue = regexp.MustCompile(`^[A-Za-z0-9._:/+-]{1,160}$`)

var controlTaskLeaseRenewalInterval = 10 * time.Second

const controlTaskDatabaseTimeout = 10 * time.Second

type RuntimeStore interface {
	ClaimControlTask(context.Context, string, string) (store.ControlTaskWork, bool, error)
	ClaimExpiredControlTaskRecovery(context.Context, string, string) (store.ControlTaskRecoveryItem, bool, error)
	ListControlTaskCredentialCleanup(context.Context) ([]store.ControlTaskRecoveryItem, error)
	ReconcileTerminalControlTaskCredential(context.Context, store.ControlTaskWork) (store.ControlTaskRecoveryItem, bool, error)
	StartControlTask(context.Context, store.ControlTaskWork) error
	RenewControlTaskLease(context.Context, store.ControlTaskWork) error
	PrepareControlTaskCredentialRotation(context.Context, store.ControlTaskWork, string) (int64, error)
	MarkControlTaskCredentialCommitting(context.Context, store.ControlTaskWork, int64, string) error
	CompleteControlTask(context.Context, store.CompleteControlTaskInput) error
	FailControlTask(context.Context, store.ControlTaskWork, string, string, bool) error
}

type Launcher interface {
	Launch(context.Context, string, string) (appserver.Process, error)
}

type CredentialManager interface {
	AcquireExecutorLock(context.Context, string) (*credentialfs.ExecutorLock, error)
	CloneRevision(string, int64, string) (string, error)
	RevisionPath(string, int64) (string, error)
	OperationPath(string, string) (string, error)
	PromoteOperation(string, string, int64, string) (string, error)
	Quarantine(string, string, string) (string, error)
	RemoveEphemeral(string) error
}

type Config struct {
	OwnerInstanceID string
	CodexVersion    string
	ReportError     func(error)
}

type Manager struct {
	store       RuntimeStore
	launcher    Launcher
	credentials CredentialManager
	cfg         Config

	wake        chan struct{}
	rootCtx     context.Context
	stop        context.CancelFunc
	done        chan struct{}
	startOnce   sync.Once
	mu          sync.Mutex
	running     map[string]context.CancelFunc
	reportError func(error)
}

func New(runtimeStore RuntimeStore, launcher Launcher, credentials CredentialManager, cfg Config) (*Manager, error) {
	if runtimeStore == nil || launcher == nil || credentials == nil ||
		strings.TrimSpace(cfg.OwnerInstanceID) == "" || strings.TrimSpace(cfg.CodexVersion) == "" {
		return nil, errors.New("control task manager configuration is incomplete")
	}
	reportError := cfg.ReportError
	if reportError == nil {
		reportError = func(err error) { log.Printf("control task worker: %v", err) }
	}
	return &Manager{
		store: runtimeStore, launcher: launcher, credentials: credentials, cfg: cfg,
		wake: make(chan struct{}, 1), done: make(chan struct{}),
		running: make(map[string]context.CancelFunc), reportError: reportError,
	}, nil
}

func (m *Manager) Start(parent context.Context) {
	m.startOnce.Do(func() {
		m.rootCtx, m.stop = context.WithCancel(parent)
		go m.loop()
	})
}

func (m *Manager) Wake() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

func (m *Manager) Cancel(taskID string) {
	m.mu.Lock()
	cancel := m.running[taskID]
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (m *Manager) Shutdown(ctx context.Context) {
	if m.stop != nil {
		m.stop()
	}
	select {
	case <-m.done:
	case <-ctx.Done():
	}
}

func (m *Manager) loop() {
	defer close(m.done)
	for {
		if m.rootCtx.Err() != nil {
			return
		}
		recoveryCtx, recoveryCancel := context.WithTimeout(m.rootCtx, 15*time.Second)
		recovered, recoveryErr := m.reconcileOne(recoveryCtx)
		recoveryCancel()
		if recoveryErr != nil {
			m.reportError(fmt.Errorf("reconcile expired control task: %w", recoveryErr))
			m.waitForWork()
			continue
		}
		if recovered {
			continue
		}
		claimCtx, cancel := context.WithTimeout(m.rootCtx, 5*time.Second)
		work, found, err := m.store.ClaimControlTask(claimCtx, m.cfg.OwnerInstanceID, m.cfg.CodexVersion)
		cancel()
		if err == nil && found {
			m.process(work)
			continue
		}
		m.waitForWork()
	}
}

func (m *Manager) waitForWork() {
	timer := time.NewTimer(500 * time.Millisecond)
	select {
	case <-m.rootCtx.Done():
		timer.Stop()
	case <-m.wake:
		if !timer.Stop() {
			<-timer.C
		}
	case <-timer.C:
	}
}

func (m *Manager) process(work store.ControlTaskWork) {
	timeout := time.Duration(work.TaskTimeoutSeconds) * time.Second
	if timeout < 30*time.Second || timeout > time.Hour {
		timeout = 3 * time.Minute
	}
	taskCtx, taskCancel := context.WithTimeout(m.rootCtx, timeout)
	m.mu.Lock()
	m.running[work.TaskID] = taskCancel
	m.mu.Unlock()
	defer func() {
		taskCancel()
		m.mu.Lock()
		delete(m.running, work.TaskID)
		m.mu.Unlock()
	}()

	runCtx, stopRenewal := m.startLeaseRenewal(taskCtx, work)
	renewalStopped := false
	defer func() {
		if !renewalStopped {
			_ = stopRenewal()
		}
	}()
	fail := func(code string, credentialExpired bool, promotedRevision *int64) {
		if !renewalStopped {
			_ = stopRenewal()
			renewalStopped = true
		}
		status := "failed"
		if errors.Is(taskCtx.Err(), context.DeadlineExceeded) {
			status = "timeout"
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		failErr := m.store.FailControlTask(ctx, work, status, code, credentialExpired)
		if failErr == nil {
			m.cleanupFailedOperation(work, promotedRevision)
		} else {
			// Cancellation may have terminalized and fenced the task before the
			// worker observes it.  Only an exact task-scoped DB reconciliation may
			// authorize filesystem cleanup; ambiguous/new-epoch states touch none.
			m.cleanupTerminalAfterFencedFailure(work)
		}
	}

	lock, err := m.credentials.AcquireExecutorLock(runCtx, work.ExecutorID)
	if err != nil {
		fail("runtime_error", false, nil)
		return
	}
	defer lock.Close()
	sourceRevision, err := m.credentials.RevisionPath(work.ExecutorID, work.CredentialRevision)
	if err != nil {
		fail("credential_commit_failed", false, nil)
		return
	}
	if err := credentialfs.ValidateReadOnlyTree(sourceRevision); err != nil {
		fail("credential_commit_failed", false, nil)
		return
	}
	sourceDigest, err := credentialfs.DigestTree(sourceRevision)
	if err != nil || sourceDigest != work.BindingDigest {
		fail("credential_commit_failed", false, nil)
		return
	}
	operationHome, err := m.credentials.CloneRevision(work.ExecutorID, work.CredentialRevision, work.OperationID)
	if err != nil {
		fail("credential_commit_failed", false, nil)
		return
	}
	if err := m.store.StartControlTask(runCtx, work); err != nil {
		fail("runtime_error", false, nil)
		return
	}

	account, models, authorized, err := m.runOperation(runCtx, work.OperationID, operationHome, work.TaskType != "credential_verify")
	if err != nil {
		fail(runtimeFailureCode(err), false, nil)
		return
	}
	if !authorized || account == nil {
		if err := m.credentials.RemoveEphemeral(operationHome); err != nil {
			fail("credential_commit_failed", true, nil)
			return
		}
		if work.TaskType != "credential_verify" {
			fail("credential_expired", true, nil)
			return
		}
		if err := m.finishRenewal(work, stopRenewal); err != nil {
			renewalStopped = true
			return
		}
		renewalStopped = true
		verified := false
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := m.store.CompleteControlTask(ctx, store.CompleteControlTaskInput{
			Work: work, CredentialAuthorized: &verified, CodexVersion: m.cfg.CodexVersion,
		}); err != nil {
			m.reportError(fmt.Errorf("complete unauthorized credential verification task %s: %w", work.TaskID, err))
		}
		return
	}

	fingerprint, _ := safeAccount(account)
	if fingerprint != work.AccountFingerprint {
		fail("verification_failed", false, nil)
		return
	}
	var catalog []store.ModelCatalogEntry
	if work.TaskType != "credential_verify" {
		catalog, err = sanitizeModels(models)
		if err != nil {
			fail("executor_app_server_unsupported", false, nil)
			return
		}
	}
	operationDigest, err := credentialfs.DigestTree(operationHome)
	if err != nil {
		fail("credential_commit_failed", false, nil)
		return
	}
	var promotedRevision *int64
	if operationDigest != sourceDigest {
		revision, err := m.store.PrepareControlTaskCredentialRotation(runCtx, work, operationDigest)
		if err != nil {
			fail("credential_commit_failed", false, nil)
			return
		}
		promotedRevision = &revision
		if err := m.store.MarkControlTaskCredentialCommitting(runCtx, work, revision, operationDigest); err != nil {
			fail("credential_commit_failed", false, promotedRevision)
			return
		}
		promotedPath, err := m.credentials.PromoteOperation(work.ExecutorID, work.OperationID, revision, operationDigest)
		if err != nil {
			fail("credential_commit_failed", false, promotedRevision)
			return
		}
		if err := m.verifyPromotedRevision(runCtx, work, revision, promotedPath, operationDigest); err != nil {
			fail("verification_failed", false, promotedRevision)
			return
		}
	} else if err := m.credentials.RemoveEphemeral(operationHome); err != nil {
		fail("credential_commit_failed", false, nil)
		return
	}

	if err := m.finishRenewal(work, stopRenewal); err != nil {
		renewalStopped = true
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		failErr := m.store.FailControlTask(ctx, work, "failed", "executor_operation_fenced", false)
		cancel()
		if failErr == nil {
			m.cleanupFailedOperation(work, promotedRevision)
		} else {
			m.cleanupTerminalAfterFencedFailure(work)
		}
		return
	}
	renewalStopped = true
	input := store.CompleteControlTaskInput{
		Work: work, Models: catalog, CodexVersion: m.cfg.CodexVersion,
		PromotedCredentialRevision: promotedRevision, PromotedBindingDigest: operationDigest,
	}
	switch work.TaskType {
	case "credential_verify":
		verified := true
		input.CredentialAuthorized = &verified
	case "readiness_check":
		input.ReadinessStatus, input.ReadinessReasonCode = readiness(catalog, work.DefaultModelKey)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := m.store.CompleteControlTask(ctx, input); err != nil {
		// Commit errors are potentially ambiguous. Recovery reconciles a
		// committing revision; never quarantine a revision that may be active.
		m.reportError(fmt.Errorf("complete control task %s: %w", work.TaskID, err))
	}
}

func (m *Manager) runOperation(ctx context.Context, operationID, credentialHome string, includeModels bool) (*appserver.Account, []appserver.Model, bool, error) {
	process, err := m.launcher.Launch(ctx, operationID, credentialHome)
	if err != nil {
		return nil, nil, false, err
	}
	client := appserver.NewClient(process)
	closed := false
	defer func() {
		if !closed {
			_ = client.Close()
		}
	}()
	if err := client.Initialize(ctx, m.cfg.CodexVersion); err != nil {
		return nil, nil, false, err
	}
	accountResult, err := client.ReadAccount(ctx, false)
	if err != nil {
		return nil, nil, false, err
	}
	if accountResult.Account == nil || accountResult.RequiresOpenAIAuth {
		if err := client.Close(); err != nil {
			return nil, nil, false, err
		}
		closed = true
		return nil, nil, false, nil
	}
	var models []appserver.Model
	if includeModels {
		models, err = client.ListModels(ctx)
		if err != nil {
			return nil, nil, false, err
		}
	}
	if err := client.Close(); err != nil {
		return nil, nil, false, err
	}
	closed = true
	return accountResult.Account, models, true, nil
}

func (m *Manager) verifyPromotedRevision(ctx context.Context, work store.ControlTaskWork, revision int64, promotedPath, expectedDigest string) error {
	// Verification is part of the same fenced operation.  Renew using the
	// complete database lease tuple immediately before reusing the operation
	// identifier; a derived verification ID would escape the persistent fence.
	if err := m.store.RenewControlTaskLease(ctx, work); err != nil {
		return err
	}
	if err := credentialfs.ValidateReadOnlyTree(promotedPath); err != nil {
		return err
	}
	digest, err := credentialfs.DigestTree(promotedPath)
	if err != nil || digest != expectedDigest {
		return credentialfs.ErrDigestMismatch
	}
	verificationID := work.OperationID
	verificationHome, err := m.credentials.CloneRevision(work.ExecutorID, revision, verificationID)
	if err != nil {
		return err
	}
	verificationRemoved := false
	defer func() {
		if !verificationRemoved {
			_ = m.credentials.RemoveEphemeral(verificationHome)
		}
	}()
	account, _, authorized, err := m.runOperation(ctx, verificationID, verificationHome, false)
	if err != nil || !authorized || account == nil {
		return errors.New("promoted credential verification failed")
	}
	fingerprint, _ := safeAccount(account)
	if fingerprint != work.AccountFingerprint {
		return errors.New("promoted credential account changed")
	}
	if err := m.store.RenewControlTaskLease(ctx, work); err != nil {
		return err
	}
	if err := m.credentials.RemoveEphemeral(verificationHome); err != nil {
		return err
	}
	verificationRemoved = true
	digest, err = credentialfs.DigestTree(promotedPath)
	if err != nil || digest != expectedDigest {
		return credentialfs.ErrDigestMismatch
	}
	return credentialfs.ValidateReadOnlyTree(promotedPath)
}

func (m *Manager) startLeaseRenewal(parent context.Context, work store.ControlTaskWork) (context.Context, func() error) {
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	errCh := make(chan error, 1)
	go func() {
		defer close(done)
		ticker := time.NewTicker(controlTaskLeaseRenewalInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				renewCtx, renewCancel := context.WithTimeout(ctx, 5*time.Second)
				err := m.store.RenewControlTaskLease(renewCtx, work)
				renewCancel()
				if err != nil {
					select {
					case errCh <- err:
					default:
					}
					cancel()
					return
				}
			}
		}
	}()
	return ctx, func() error {
		cancel()
		<-done
		select {
		case err := <-errCh:
			return err
		default:
			return nil
		}
	}
}

func (m *Manager) finishRenewal(work store.ControlTaskWork, stop func() error) error {
	if err := stop(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return m.store.RenewControlTaskLease(ctx, work)
}

func (m *Manager) cleanupFailedOperation(work store.ControlTaskWork, promotedRevision *int64) {
	if promotedRevision != nil {
		if path, err := m.credentials.RevisionPath(work.ExecutorID, *promotedRevision); err == nil {
			if existsDirectory(path) {
				_, _ = m.credentials.Quarantine(work.ExecutorID, path,
					fmt.Sprintf("control_failed_revision_%d_%s", *promotedRevision, digestString(work.TaskID)[:16]))
			}
		}
	}
	if path, err := m.credentials.OperationPath(work.ExecutorID, work.OperationID); err == nil && existsDirectory(path) {
		_ = m.credentials.RemoveEphemeral(path)
	}
}

func (m *Manager) cleanupTerminalAfterFencedFailure(work store.ControlTaskWork) {
	ctx, cancel := context.WithTimeout(context.Background(), controlTaskDatabaseTimeout)
	defer cancel()
	item, terminal, err := m.store.ReconcileTerminalControlTaskCredential(ctx, work)
	if err != nil {
		m.reportError(fmt.Errorf("reconcile terminal task %s after fenced failure: %w", work.TaskID, err))
		return
	}
	if !terminal {
		return
	}
	if err := m.quarantineRecoveryPaths(item); err != nil {
		m.reportError(fmt.Errorf("cleanup terminal task %s after fenced failure: %w", work.TaskID, err))
	}
}

func existsDirectory(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0
}

func runtimeFailureCode(err error) string {
	if errors.Is(err, appserver.ErrProtocolUnsupported) {
		return "executor_app_server_unsupported"
	}
	return "executor_app_server_unavailable"
}

func safeAccount(account *appserver.Account) (string, string) {
	email := ""
	if account.Email != nil {
		email = strings.ToLower(strings.TrimSpace(*account.Email))
	}
	return digestString(strings.TrimSpace(account.Type) + "\n" + email), safePlan(account.PlanType)
}

func safePlan(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "free", "go", "plus", "pro", "prolite", "team", "self_serve_business_usage_based",
		"business", "enterprise_cbp_usage_based", "enterprise", "edu":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "unknown"
	}
}

func sanitizeModels(models []appserver.Model) ([]store.ModelCatalogEntry, error) {
	if len(models) == 0 {
		return nil, errors.New("model catalog is empty")
	}
	if len(models) > 512 {
		return nil, errors.New("model catalog too large")
	}
	seen := make(map[string]struct{}, len(models))
	result := make([]store.ModelCatalogEntry, 0, len(models))
	for _, model := range models {
		if !safeCatalogValue.MatchString(model.ModelKey) || len(model.CatalogItemID) > 160 || len(model.DisplayName) > 200 {
			return nil, errors.New("unsafe model catalog entry")
		}
		if _, exists := seen[model.ModelKey]; exists {
			return nil, errors.New("duplicate model key")
		}
		seen[model.ModelKey] = struct{}{}
		modalities := uniqueAllowed(model.InputModalities, map[string]bool{"text": true, "image": true})
		if len(modalities) == 0 {
			return nil, errors.New("model modalities unavailable")
		}
		reasoning := make([]string, 0, len(model.SupportedReasoningEffort))
		for _, effort := range model.SupportedReasoningEffort {
			value := effort.ReasoningEffort
			if !map[string]bool{"none": true, "minimal": true, "low": true, "medium": true, "high": true, "xhigh": true}[value] {
				return nil, errors.New("model reasoning effort unsupported")
			}
			reasoning = append(reasoning, value)
		}
		sort.Strings(reasoning)
		modalitiesJSON, _ := json.Marshal(modalities)
		reasoningJSON, _ := json.Marshal(reasoning)
		upgrade := ""
		if model.Upgrade != nil {
			upgrade = strings.TrimSpace(*model.Upgrade)
			if upgrade != "" && !safeCatalogValue.MatchString(upgrade) {
				return nil, errors.New("unsafe model upgrade key")
			}
		}
		result = append(result, store.ModelCatalogEntry{
			CatalogItemID: model.CatalogItemID, ModelKey: model.ModelKey,
			DisplayName: strings.TrimSpace(model.DisplayName), InputModalitiesJSON: modalitiesJSON,
			SupportedReasoningJSON: reasoningJSON, Hidden: model.Hidden, UpgradeModelKey: upgrade,
		})
	}
	return result, nil
}

func uniqueAllowed(values []string, allowed map[string]bool) []string {
	seen := map[string]bool{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if allowed[value] && !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	sort.Strings(result)
	return result
}

func readiness(models []store.ModelCatalogEntry, defaultModel string) (string, string) {
	if defaultModel == "" {
		return "degraded", "default_model_missing"
	}
	for _, model := range models {
		if model.ModelKey != defaultModel || model.Hidden {
			continue
		}
		var modalities []string
		_ = json.Unmarshal(model.InputModalitiesJSON, &modalities)
		hasText, hasImage := false, false
		for _, modality := range modalities {
			hasText = hasText || modality == "text"
			hasImage = hasImage || modality == "image"
		}
		if hasText && hasImage {
			return "ready", ""
		}
	}
	return "degraded", "model_unavailable"
}

func digestString(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
