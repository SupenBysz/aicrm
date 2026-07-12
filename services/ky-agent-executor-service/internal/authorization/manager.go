package authorization

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
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

var (
	ErrChallengeGone      = errors.New("authorization challenge gone")
	ErrRequesterMismatch  = errors.New("authorization requester mismatch")
	ErrRuntimeUnsupported = errors.New("authorization runtime unsupported")
	safeCatalogValue      = regexp.MustCompile(`^[A-Za-z0-9._:/+-]{1,160}$`)
)

type RuntimeStore interface {
	MarkAuthorizationWaiting(context.Context, string, string, string, int64) (store.AuthorizationSessionProjection, error)
	MarkAuthorizationVerifying(context.Context, string, string, int64) (store.AuthorizationSessionProjection, error)
	PrepareServerCredential(context.Context, store.CredentialPreparationInput) (store.CredentialPreparation, error)
	MarkCredentialCommitting(context.Context, store.CredentialPreparation, string) error
	RenewServerCredentialLease(context.Context, store.CredentialPreparation, string) error
	ActivateServerCredential(context.Context, store.ActivateServerCredentialInput) (store.AuthorizationSessionProjection, error)
	QuarantineServerCredential(context.Context, string, store.CredentialPreparation, string, string, string) (store.AuthorizationSessionProjection, bool, error)
	FailAuthorizationSession(context.Context, string, string, string, string) (store.AuthorizationSessionProjection, error)
}

type Launcher interface {
	Launch(context.Context, string, string) (appserver.Process, error)
}

type CredentialManager interface {
	CreateStaging(string, string) (string, error)
	AcquireExecutorLock(context.Context, string) (*credentialfs.ExecutorLock, error)
	StagingPath(string, string) (string, error)
	CloneRevision(string, int64, string) (string, error)
	OperationPath(string, string) (string, error)
	Promote(string, string, int64, string) (string, error)
	RevisionPath(string, int64) (string, error)
	Quarantine(string, string, string) (string, error)
	RemoveEphemeral(string) error
}

type Manager struct {
	store                  RuntimeStore
	launcher               Launcher
	credentials            CredentialManager
	ownerInstanceID        string
	codexVersion           string
	runtimeBindingID       string
	runtimeBindingRevision int64

	mu       sync.Mutex
	sessions map[string]*ownedSession
	closed   bool
}

type ownedSession struct {
	session   store.AuthorizationSessionProjection
	challenge *UserAction
	loginID   string
	client    *appserver.Client
	staging   string
	cancel    context.CancelFunc
	done      chan struct{}
}

type UserAction struct {
	VerificationURL   string `json:"verificationUrl"`
	UserCode          string `json:"userCode"`
	SessionDeadlineAt string `json:"sessionDeadlineAt"`
}

type Config struct {
	OwnerInstanceID        string
	CodexVersion           string
	RuntimeBindingID       string
	RuntimeBindingRevision int64
}

func New(runtimeStore RuntimeStore, launcher Launcher, credentials CredentialManager, cfg Config) (*Manager, error) {
	if runtimeStore == nil || launcher == nil || credentials == nil ||
		strings.TrimSpace(cfg.OwnerInstanceID) == "" || strings.TrimSpace(cfg.CodexVersion) == "" ||
		strings.TrimSpace(cfg.RuntimeBindingID) == "" || cfg.RuntimeBindingRevision < 1 {
		return nil, errors.New("authorization manager configuration is incomplete")
	}
	return &Manager{
		store: runtimeStore, launcher: launcher, credentials: credentials,
		ownerInstanceID: cfg.OwnerInstanceID, codexVersion: cfg.CodexVersion,
		runtimeBindingID: cfg.RuntimeBindingID, runtimeBindingRevision: cfg.RuntimeBindingRevision,
		sessions: make(map[string]*ownedSession),
	}, nil
}

func (m *Manager) Start(session store.AuthorizationSessionProjection) error {
	if session.RuntimeType != "server" || session.FlowType != "device_code" || session.Status != "starting" {
		return ErrRuntimeUnsupported
	}
	deadline, err := time.Parse(time.RFC3339Nano, session.SessionDeadlineAt)
	if err != nil || !deadline.After(time.Now()) {
		return ErrRuntimeUnsupported
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return errors.New("authorization manager is closed")
	}
	if _, exists := m.sessions[session.ID]; exists {
		return nil
	}
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	owned := &ownedSession{session: session, cancel: cancel, done: make(chan struct{})}
	m.sessions[session.ID] = owned
	go m.run(ctx, owned)
	return nil
}

func (m *Manager) UserAction(sessionID, actorID string) (UserAction, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	owned := m.sessions[sessionID]
	if owned == nil || owned.challenge == nil {
		return UserAction{}, ErrChallengeGone
	}
	if owned.session.RequestedBy != actorID {
		return UserAction{}, ErrRequesterMismatch
	}
	return *owned.challenge, nil
}

func (m *Manager) Cancel(sessionID string) {
	m.mu.Lock()
	owned := m.sessions[sessionID]
	if owned == nil {
		m.mu.Unlock()
		return
	}
	client, loginID, cancel := owned.client, owned.loginID, owned.cancel
	m.mu.Unlock()
	if client != nil && loginID != "" {
		ctx, done := context.WithTimeout(context.Background(), 2*time.Second)
		_ = client.CancelLogin(ctx, loginID)
		done()
	}
	cancel()
}

func (m *Manager) Shutdown(ctx context.Context) {
	m.mu.Lock()
	m.closed = true
	owned := make([]*ownedSession, 0, len(m.sessions))
	for _, session := range m.sessions {
		owned = append(owned, session)
		session.cancel()
	}
	m.mu.Unlock()
	for _, session := range owned {
		select {
		case <-session.done:
		case <-ctx.Done():
			return
		}
	}
}

func (m *Manager) run(ctx context.Context, owned *ownedSession) {
	defer close(owned.done)
	defer m.remove(owned.session.ID)
	session := owned.session
	staging, err := m.credentials.CreateStaging(session.ExecutorID, session.ID)
	if err != nil {
		m.fail(session.ID, "credential_commit_failed", ctx)
		return
	}
	m.mu.Lock()
	owned.staging = staging
	m.mu.Unlock()
	removeStagingOnExit := true
	defer func() {
		if removeStagingOnExit {
			_ = m.credentials.RemoveEphemeral(staging)
		}
	}()
	operationID := "auth_" + session.ID
	process, err := m.launcher.Launch(ctx, operationID, staging)
	if err != nil {
		m.fail(session.ID, "app_server_start_failed", ctx)
		return
	}
	client := appserver.NewClient(process)
	m.mu.Lock()
	owned.client = client
	m.mu.Unlock()
	clientClosed := false
	defer func() {
		if !clientClosed {
			_ = client.Close()
		}
	}()
	if err := client.Initialize(ctx, "aicrm-agent-executor"); err != nil {
		m.fail(session.ID, "app_server_protocol_unsupported", ctx)
		return
	}
	challenge, err := client.StartDeviceCodeLogin(ctx)
	if err != nil || !validVerificationURL(challenge.VerificationURL) || !validUserCode(challenge.UserCode) {
		m.fail(session.ID, "device_code_unavailable", ctx)
		return
	}
	m.mu.Lock()
	owned.loginID = challenge.LoginID
	m.mu.Unlock()
	waiting, err := m.store.MarkAuthorizationWaiting(ctx, session.ID, m.ownerInstanceID, digestString(challenge.LoginID), session.Revision)
	if err != nil {
		return
	}
	m.mu.Lock()
	owned.session = waiting
	owned.challenge = &UserAction{
		VerificationURL: challenge.VerificationURL, UserCode: challenge.UserCode,
		SessionDeadlineAt: session.SessionDeadlineAt,
	}
	m.mu.Unlock()
	completion, err := client.WaitLoginCompleted(ctx, challenge.LoginID)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			m.fail(session.ID, "session_deadline_exceeded", ctx)
			return
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			m.fail(session.ID, "service_restarted", ctx)
			return
		}
		m.fail(session.ID, "app_server_start_failed", ctx)
		return
	}
	if !completion.Success {
		m.fail(session.ID, "login_failed", ctx)
		return
	}
	verifying, err := m.store.MarkAuthorizationVerifying(ctx, session.ID, m.ownerInstanceID, waiting.Revision)
	if err != nil {
		return
	}
	m.mu.Lock()
	owned.session = verifying
	owned.challenge = nil
	m.mu.Unlock()
	accountResult, err := client.ReadAccount(ctx, true)
	if err != nil || accountResult.Account == nil || accountResult.RequiresOpenAIAuth {
		m.fail(session.ID, "verification_failed", ctx)
		return
	}
	// Freeze the credential home before hashing and promotion. The App Server
	// must not be able to refresh or rewrite auth files between the digest and
	// the no-replace rename/durable barrier.
	if err := client.Close(); err != nil {
		m.fail(session.ID, "app_server_start_failed", ctx)
		return
	}
	clientClosed = true
	m.mu.Lock()
	owned.client = nil
	m.mu.Unlock()
	fingerprint, _, planType := safeAccount(accountResult.Account)
	digest, err := credentialfs.DigestTree(staging)
	if err != nil {
		m.fail(session.ID, "credential_commit_failed", ctx)
		return
	}
	removeStagingOnExit = false
	prep, err := m.store.PrepareServerCredential(ctx, store.CredentialPreparationInput{
		SessionID: session.ID, ExpectedSessionRevision: verifying.Revision,
		OwnerInstanceID: m.ownerInstanceID, OperationID: operationID,
		RuntimeBindingID: m.runtimeBindingID, RuntimeBindingRevision: m.runtimeBindingRevision,
		AccountFingerprint: fingerprint, PlanType: planType, BindingDigest: digest,
	})
	if err != nil {
		m.fail(session.ID, "credential_commit_failed", ctx)
		return
	}
	leaseCtx, stopLeaseRenewal := m.startLeaseRenewal(ctx, prep, operationID)
	leaseRenewalStopped := false
	defer func() {
		if !leaseRenewalStopped {
			_ = stopLeaseRenewal()
		}
	}()
	executorLock, err := m.credentials.AcquireExecutorLock(leaseCtx, session.ExecutorID)
	if err != nil {
		m.failCredentialCandidate(session, prep, operationID, "credential_commit_failed", ctx)
		return
	}
	defer executorLock.Close()
	if err := m.store.MarkCredentialCommitting(leaseCtx, prep, operationID); err != nil {
		m.failCredentialCandidate(session, prep, operationID, "credential_commit_failed", ctx)
		return
	}
	if _, err := m.credentials.Promote(session.ExecutorID, session.ID, prep.CredentialRevision, digest); err != nil {
		m.failCredentialCandidate(session, prep, operationID, "credential_commit_failed", ctx)
		return
	}
	verificationOperationID := operationID
	verificationHome, err := m.credentials.CloneRevision(session.ExecutorID, prep.CredentialRevision, verificationOperationID)
	if err != nil {
		m.failCredentialCandidate(session, prep, operationID, "verification_failed", ctx)
		return
	}
	verificationHomeRemoved := false
	defer func() {
		if !verificationHomeRemoved {
			_ = m.credentials.RemoveEphemeral(verificationHome)
		}
	}()
	verificationProcess, err := m.launcher.Launch(leaseCtx, verificationOperationID, verificationHome)
	if err != nil {
		m.failCredentialCandidate(session, prep, operationID, "app_server_start_failed", ctx)
		return
	}
	verificationClient := appserver.NewClient(verificationProcess)
	m.mu.Lock()
	owned.client = verificationClient
	m.mu.Unlock()
	verificationClosed := false
	defer func() {
		if !verificationClosed {
			_ = verificationClient.Close()
		}
	}()
	if err := verificationClient.Initialize(leaseCtx, "aicrm-agent-executor-verifier"); err != nil {
		m.failCredentialCandidate(session, prep, operationID, "app_server_protocol_unsupported", ctx)
		return
	}
	verifiedAccount, err := verificationClient.ReadAccount(leaseCtx, false)
	if err != nil || verifiedAccount.Account == nil || verifiedAccount.RequiresOpenAIAuth {
		m.failCredentialCandidate(session, prep, operationID, "verification_failed", ctx)
		return
	}
	models, err := verificationClient.ListModels(leaseCtx)
	if err != nil {
		m.failCredentialCandidate(session, prep, operationID, "verification_failed", ctx)
		return
	}
	catalog, err := sanitizeModels(models)
	if err != nil {
		m.failCredentialCandidate(session, prep, operationID, "app_server_protocol_unsupported", ctx)
		return
	}
	if err := verificationClient.Close(); err != nil {
		m.failCredentialCandidate(session, prep, operationID, "app_server_start_failed", ctx)
		return
	}
	verificationClosed = true
	m.mu.Lock()
	owned.client = nil
	m.mu.Unlock()
	if err := m.credentials.RemoveEphemeral(verificationHome); err != nil {
		m.failCredentialCandidate(session, prep, operationID, "credential_commit_failed", ctx)
		return
	}
	verificationHomeRemoved = true
	verifiedFingerprint, summary, verifiedPlanType := safeAccount(verifiedAccount.Account)
	if verifiedFingerprint != fingerprint || verifiedPlanType != planType {
		m.failCredentialCandidate(session, prep, operationID, "verification_failed", ctx)
		return
	}
	if ctx.Err() != nil {
		m.failCredentialCandidate(session, prep, operationID, "service_restarted", ctx)
		return
	}
	revisionPath, err := m.credentials.RevisionPath(session.ExecutorID, prep.CredentialRevision)
	if err != nil {
		m.failCredentialCandidate(session, prep, operationID, "credential_commit_failed", ctx)
		return
	}
	verifiedDigest, err := credentialfs.DigestTree(revisionPath)
	if err != nil || verifiedDigest != prep.BindingDigest {
		m.failCredentialCandidate(session, prep, operationID, "credential_commit_failed", ctx)
		return
	}
	if err := stopLeaseRenewal(); err != nil {
		leaseRenewalStopped = true
		m.failCredentialCandidate(session, prep, operationID, "credential_commit_failed", ctx)
		return
	}
	leaseRenewalStopped = true
	if err := m.store.RenewServerCredentialLease(ctx, prep, operationID); err != nil {
		m.failCredentialCandidate(session, prep, operationID, "credential_commit_failed", ctx)
		return
	}
	_, err = m.store.ActivateServerCredential(ctx, store.ActivateServerCredentialInput{
		SessionID: session.ID, OwnerInstanceID: m.ownerInstanceID,
		OperationID: operationID, Preparation: prep,
		AccountSummaryJSON: summary, AccountFingerprint: fingerprint,
		RuntimeBindingID: m.runtimeBindingID, RuntimeBindingRevision: m.runtimeBindingRevision,
		CodexVersion: m.codexVersion, Models: catalog,
	})
	if err != nil {
		m.failCredentialCandidate(session, prep, operationID, "credential_commit_failed", ctx)
	}
}

func (m *Manager) startLeaseRenewal(parent context.Context, prep store.CredentialPreparation, operationID string) (context.Context, func() error) {
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	errCh := make(chan error, 1)
	go func() {
		defer close(done)
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				renewCtx, renewCancel := context.WithTimeout(ctx, 5*time.Second)
				err := m.store.RenewServerCredentialLease(renewCtx, prep, operationID)
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

func (m *Manager) failCredentialCandidate(session store.AuthorizationSessionProjection, prep store.CredentialPreparation, operationID, code string, runCtx context.Context) {
	status := "failed"
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		status, code = "expired", "session_deadline_exceeded"
	} else if errors.Is(runCtx.Err(), context.Canceled) {
		status, code = "interrupted", "service_restarted"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, shouldQuarantine, err := m.store.QuarantineServerCredential(ctx, session.ID, prep, operationID, status, code)
	if err != nil || !shouldQuarantine {
		return
	}
	digestSuffix := digestString(session.ID)[:24]
	candidates := []struct {
		path string
		name string
	}{}
	if stagingPath, pathErr := m.credentials.StagingPath(session.ExecutorID, session.ID); pathErr == nil {
		candidates = append(candidates, struct {
			path string
			name string
		}{stagingPath, fmt.Sprintf("failed_staging_%d_%s", prep.CredentialRevision, digestSuffix)})
	}
	if revisionPath, pathErr := m.credentials.RevisionPath(session.ExecutorID, prep.CredentialRevision); pathErr == nil {
		candidates = append(candidates, struct {
			path string
			name string
		}{revisionPath, fmt.Sprintf("failed_revision_%d_%s", prep.CredentialRevision, digestSuffix)})
	}
	for _, candidate := range candidates {
		info, statErr := os.Lstat(candidate.path)
		if errors.Is(statErr, os.ErrNotExist) {
			continue
		}
		if statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		_, _ = m.credentials.Quarantine(session.ExecutorID, candidate.path, candidate.name)
	}
	operationPath, err := m.credentials.OperationPath(session.ExecutorID, operationID)
	if err != nil {
		return
	}
	info, err := os.Lstat(operationPath)
	if err == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
		_ = m.credentials.RemoveEphemeral(operationPath)
	}
}

func (m *Manager) fail(sessionID, code string, runCtx context.Context) {
	status := "failed"
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		status = "expired"
		code = "session_deadline_exceeded"
	} else if errors.Is(runCtx.Err(), context.Canceled) {
		status = "interrupted"
		code = "service_restarted"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = m.store.FailAuthorizationSession(ctx, sessionID, m.ownerInstanceID, status, code)
}

func (m *Manager) remove(sessionID string) {
	m.mu.Lock()
	delete(m.sessions, sessionID)
	m.mu.Unlock()
}

func validVerificationURL(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	if parsed.Port() != "" && parsed.Port() != "443" {
		return false
	}
	switch strings.ToLower(parsed.Hostname()) {
	case "auth.openai.com", "platform.openai.com", "chatgpt.com":
		return true
	default:
		return false
	}
}

func validUserCode(value string) bool {
	if len(value) < 4 || len(value) > 64 {
		return false
	}
	for _, char := range value {
		if (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' {
			continue
		}
		return false
	}
	return true
}

func safeAccount(account *appserver.Account) (string, []byte, string) {
	email := ""
	if account.Email != nil {
		email = strings.ToLower(strings.TrimSpace(*account.Email))
	}
	fingerprint := digestString(strings.TrimSpace(account.Type) + "\n" + email)
	plan := safePlan(account.PlanType)
	summary := map[string]any{"accountFingerprint": fingerprint, "planType": plan}
	if at := strings.LastIndexByte(email, '@'); at > 0 && at < len(email)-1 {
		summary["emailDomainHash"] = digestString(email[at+1:])
	}
	encoded, _ := json.Marshal(summary)
	return fingerprint, encoded, plan
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
	if len(models) > 512 {
		return nil, ErrRuntimeUnsupported
	}
	seen := make(map[string]struct{}, len(models))
	result := make([]store.ModelCatalogEntry, 0, len(models))
	for _, model := range models {
		if !safeCatalogValue.MatchString(model.ModelKey) || len(model.CatalogItemID) > 160 || len(model.DisplayName) > 200 {
			return nil, ErrRuntimeUnsupported
		}
		if _, exists := seen[model.ModelKey]; exists {
			return nil, ErrRuntimeUnsupported
		}
		seen[model.ModelKey] = struct{}{}
		modalities := uniqueAllowed(model.InputModalities, map[string]bool{"text": true, "image": true})
		if len(modalities) == 0 {
			return nil, ErrRuntimeUnsupported
		}
		reasoning := make([]string, 0, len(model.SupportedReasoningEffort))
		for _, effort := range model.SupportedReasoningEffort {
			value := effort.ReasoningEffort
			if !map[string]bool{"none": true, "minimal": true, "low": true, "medium": true, "high": true, "xhigh": true}[value] {
				return nil, ErrRuntimeUnsupported
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
				return nil, ErrRuntimeUnsupported
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
	result := []string{}
	for _, value := range values {
		if !allowed[value] || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func digestString(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
