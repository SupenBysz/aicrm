package server

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/accessclient"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/appserver"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/authorization"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/controltask"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/credentialfs"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/credentialrevocation"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/desktopactivation"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/desktophandoff"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/operationconfirmation"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
	"github.com/Kysion/KyaiCRM/shared/auth"
)

type Server struct {
	cfg                 config.Config
	reader              store.Reader
	control             controlStore
	authorizer          accessclient.Authorizer
	authRuntime         authorizationRuntime
	taskRuntime         taskRuntime
	confirmationRuntime operationConfirmationRuntime
	handoffRuntime      desktopHandoffRuntime
	revocationRuntime   credentialRevocationRuntime
	activationRuntime   desktopActivationRuntime
}

type authorizationRuntime interface {
	Start(store.AuthorizationSessionProjection) error
	UserAction(string, string) (authorization.UserAction, error)
	Cancel(string)
	Shutdown(context.Context)
}

type taskRuntime interface {
	Cancel(string)
	Wake()
}

type controlStore interface {
	Ping(context.Context) error
	ListExecutors(context.Context, string, string) ([]store.ExecutorControlProjection, error)
	GetExecutor(context.Context, string, string, string) (store.ExecutorControlProjection, error)
	CreateExecutor(context.Context, store.CreateExecutorInput, string, string) (store.ExecutorControlProjection, error)
	PatchExecutor(context.Context, string, store.ExecutorPatch, string, string) (store.ExecutorControlProjection, error)
	ListModels(context.Context, string, bool) ([]store.ModelProjection, error)
	ListWorkspaceGrants(context.Context, string) ([]store.WorkspaceGrantProjection, error)
	PutWorkspaceGrant(context.Context, string, string, string, string, string, int64) (store.WorkspaceGrantProjection, error)
	DeleteWorkspaceGrant(context.Context, string, string, string, string, int64) (store.WorkspaceGrantProjection, error)
	CreateAuthorizationSession(context.Context, store.CreateAuthorizationSessionInput) (store.CreateAuthorizationSessionResult, error)
	GetCurrentAuthorizationSession(context.Context, string) (store.AuthorizationSessionProjection, error)
	GetAuthorizationSession(context.Context, string) (store.AuthorizationSessionProjection, error)
	ListAuthorizationEvents(context.Context, string, int64, int) ([]store.AuthorizationEventProjection, error)
	CancelAuthorizationSession(context.Context, store.CancelAuthorizationInput) (store.AuthorizationSessionProjection, bool, error)
	RecordAuthorizationReopen(context.Context, string, string, string, string) error
	FailAuthorizationSession(context.Context, string, string, string, string) (store.AuthorizationSessionProjection, error)
	RecoverInterruptedAuthorizationSessions(context.Context, string) ([]store.AuthorizationRecoveryItem, error)
	ListPublicTasks(context.Context, store.PublicTaskFilter) ([]store.PublicTaskProjection, int64, error)
	GetPublicTask(context.Context, string, string, string) (store.PublicTaskProjection, error)
	ListPublicTaskEvents(context.Context, string, string, string, int64, int) ([]store.PublicTaskEventProjection, error)
	ListPublicTaskTerminal(context.Context, string, string, string, int64, int) ([]store.PublicTaskTerminalProjection, error)
	PublicTaskTerminalClosedSequence(context.Context, string, string, string) (int64, error)
	CancelPublicTask(context.Context, store.CancelPublicTaskInput) (store.PublicTaskProjection, bool, error)
	CreateControlTask(context.Context, store.CreateControlTaskInput) (store.CreateControlTaskResult, error)
}

func New(cfg config.Config) *Server {
	return &Server{cfg: cfg}
}

func newWithReader(cfg config.Config, reader store.Reader) *Server {
	return &Server{cfg: cfg, reader: reader}
}

func newWithControl(cfg config.Config, reader store.Reader, control controlStore, authorizer accessclient.Authorizer) *Server {
	return &Server{cfg: cfg, reader: reader, control: control, authorizer: authorizer}
}

func (s *Server) Run(ctx context.Context) error {
	if err := s.cfg.Validate(); err != nil {
		return err
	}
	if s.cfg.DatabaseURL != "" {
		opened, err := store.Open(ctx, s.cfg.DatabaseURL)
		if err != nil {
			return err
		}
		s.reader = opened
		defer opened.Close()
	}
	if s.cfg.WriteEnabled {
		opened, err := store.OpenControl(ctx, s.cfg.WriterDatabaseURL)
		if err != nil {
			return err
		}
		s.control = opened
		defer opened.Close()
		authorizer, err := accessclient.New(s.cfg.MembershipURL, s.cfg.InternalToken)
		if err != nil {
			return err
		}
		s.authorizer = authorizer
		keyMaterial, err := s.cfg.TrustedTokenKeyMaterial()
		if err != nil {
			return err
		}
		signer, err := trustedtoken.NewSigner(keyMaterial.KeyID, keyMaterial.PrivateKey)
		if err != nil {
			return err
		}
		confirmationManager, err := operationconfirmation.New(
			opened,
			signer,
			trustedtoken.KeySet{keyMaterial.KeyID: keyMaterial.VerificationKey},
			[]byte(s.cfg.ConfirmationChallengeSecret),
			[]byte(s.cfg.TrustedTokenNonceSecret),
		)
		if err != nil {
			return err
		}
		s.confirmationRuntime = confirmationManager
		handoffManager, err := desktophandoff.New(
			opened,
			signer,
			trustedtoken.KeySet{keyMaterial.KeyID: keyMaterial.VerificationKey},
			[]byte(s.cfg.TrustedTokenNonceSecret),
		)
		if err != nil {
			return err
		}
		s.handoffRuntime = handoffManager
		activationManager, err := desktopactivation.New(
			opened,
			signer,
			trustedtoken.KeySet{keyMaterial.KeyID: keyMaterial.VerificationKey},
			[]byte(s.cfg.TrustedTokenNonceSecret),
		)
		if err != nil {
			return err
		}
		s.activationRuntime = activationManager
		revocationManager, err := credentialrevocation.New(
			opened,
			confirmationManager,
			signer,
			trustedtoken.KeySet{keyMaterial.KeyID: keyMaterial.VerificationKey},
			[]byte(s.cfg.TrustedTokenNonceSecret),
		)
		if err != nil {
			return err
		}
		s.revocationRuntime = revocationManager
		credentials, err := credentialfs.New(s.cfg.CredentialRoot)
		if err != nil {
			return err
		}
		recoveryItems, err := opened.RecoverInterruptedAuthorizationSessions(ctx, s.cfg.OwnerInstanceID)
		if err != nil {
			return err
		}
		if err := recoverAuthorizationCredentialTrees(credentials, recoveryItems); err != nil {
			return err
		}
		launcher := appserver.BrokerLauncher{SocketPath: s.cfg.RuntimeBrokerSocket}
		runtime, err := authorization.New(opened, launcher, credentials, authorization.Config{
			OwnerInstanceID: s.cfg.OwnerInstanceID, CodexVersion: s.cfg.CodexVersion,
			RuntimeBindingID: s.cfg.RuntimeBindingID, RuntimeBindingRevision: 1,
		})
		if err != nil {
			return err
		}
		if err := runtime.Recover(ctx, recoveryItems); err != nil {
			return err
		}
		s.authRuntime = runtime
		defer func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			runtime.Shutdown(shutdownCtx)
		}()
		controlRuntime, err := controltask.New(opened, launcher, credentials, controltask.Config{
			OwnerInstanceID: s.cfg.OwnerInstanceID,
			CodexVersion:    s.cfg.CodexVersion,
		})
		if err != nil {
			return err
		}
		if err := controlRuntime.Recover(ctx); err != nil {
			return err
		}
		controlRuntime.Start(ctx)
		s.taskRuntime = controlRuntime
		defer func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			controlRuntime.Shutdown(shutdownCtx)
		}()
	}

	httpServer := &http.Server{
		Addr:              s.cfg.HTTPAddr,
		Handler:           s.buildMux(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() { errCh <- httpServer.ListenAndServe() }()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return httpServer.Shutdown(shutdownCtx)
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func recoverAuthorizationCredentialTrees(credentials *credentialfs.Manager, items []store.AuthorizationRecoveryItem) error {
	for _, item := range items {
		staging, err := credentials.StagingPath(item.ExecutorID, item.SessionID)
		if err != nil {
			return err
		}
		operation := ""
		if item.OperationID != "" {
			operation, err = credentials.OperationPath(item.ExecutorID, item.OperationID)
			if err != nil {
				return err
			}
		}
		if item.PreparedCredentialRevision == nil {
			for _, path := range []string{staging, operation} {
				if path == "" {
					continue
				}
				exists, err := safeCredentialDirectoryExists(path)
				if err != nil {
					return err
				}
				if exists {
					if err := credentials.RemoveEphemeral(path); err != nil {
						return err
					}
				}
			}
			continue
		}
		if item.BindingStatus != "quarantined" {
			continue
		}
		revision, err := credentials.RevisionPath(item.ExecutorID, *item.PreparedCredentialRevision)
		if err != nil {
			return err
		}
		candidates := []struct {
			path string
			name string
		}{
			{staging, "recovery_staging_" + item.SessionID},
			{revision, "recovery_revision_" + item.SessionID},
		}
		if operation != "" {
			candidates = append(candidates, struct {
				path string
				name string
			}{operation, "recovery_operation_" + item.SessionID})
		}
		for _, candidate := range candidates {
			exists, err := safeCredentialDirectoryExists(candidate.path)
			if err != nil {
				return err
			}
			if exists {
				if _, err := credentials.Quarantine(item.ExecutorID, candidate.path, candidate.name); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func safeCredentialDirectoryExists(path string) (bool, error) {
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

func (s *Server) buildMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("GET /readyz", s.readyz)

	// P1 safe shadow-read projections.
	mux.HandleFunc("GET /internal/v1/shadow/executors/{executorId}", s.internal(s.getExecutorShadow))
	mux.HandleFunc("GET /internal/v1/executor-tasks/{taskId}", s.internal(s.getTask))
	mux.HandleFunc("GET /internal/v1/executor-tasks/{taskId}/result", s.internal(s.getTaskResult))

	// Canonical future write entry points are intentionally registered so
	// callers receive a deterministic fail-closed result instead of falling
	// through to legacy model-service behavior.
	mux.HandleFunc("POST /internal/v1/executor-bindings/resolve", s.internal(s.shadowWriteRejected))
	mux.HandleFunc("POST /internal/v1/executor-tasks", s.internal(s.shadowWriteRejected))
	mux.HandleFunc("POST /internal/v1/executor-tasks/{taskId}/cancel", s.internal(s.shadowWriteRejected))

	// P2A public control plane. The handlers remain fail-closed unless the
	// dedicated writer role and Membership access-decision client are enabled.
	mux.HandleFunc("GET /api/v1/ai-executors", s.public([]string{"platform.ai_executors.view"}, nil, s.listExecutors))
	mux.HandleFunc("POST /api/v1/ai-executors", s.public([]string{"platform.ai_executors.create"}, nil, s.createExecutor))
	mux.HandleFunc("GET /api/v1/ai-executors/{executorId}", s.public([]string{"platform.ai_executors.view"}, nil, s.getExecutor))
	mux.HandleFunc("PATCH /api/v1/ai-executors/{executorId}", s.public([]string{"platform.ai_executors.update"}, nil, s.patchExecutor))
	mux.HandleFunc("GET /api/v1/ai-executors/{executorId}/models", s.public([]string{"platform.ai_executors.view"}, nil, s.listExecutorModels))
	mux.HandleFunc("GET /api/v1/ai-executors/{executorId}/workspace-grants", s.public([]string{"platform.ai_executors.view"}, nil, s.listExecutorWorkspaceGrants))
	mux.HandleFunc("PUT /api/v1/ai-executors/{executorId}/workspace-grants/{workspaceType}/{workspaceId}", s.public([]string{"platform.ai_executors.update"}, nil, s.putExecutorWorkspaceGrant))
	mux.HandleFunc("DELETE /api/v1/ai-executors/{executorId}/workspace-grants/{workspaceType}/{workspaceId}", s.public([]string{"platform.ai_executors.update"}, nil, s.deleteExecutorWorkspaceGrant))
	mux.HandleFunc("POST /api/v1/ai-executors/{executorId}/authorization-sessions", s.public(nil, []string{"platform.ai_executors.authorize", "platform.ai_executors.change_account"}, s.createAuthorizationSession))
	mux.HandleFunc("GET /api/v1/ai-executors/{executorId}/authorization-sessions/current", s.public([]string{"platform.ai_executors.view"}, nil, s.getCurrentAuthorizationSession))
	mux.HandleFunc("GET /api/v1/ai-executor-authorization-sessions/{sessionId}", s.public([]string{"platform.ai_executors.view"}, nil, s.getAuthorizationSession))
	mux.HandleFunc("GET /api/v1/ai-executor-authorization-sessions/{sessionId}/user-action", s.public(nil, []string{"platform.ai_executors.authorize", "platform.ai_executors.change_account"}, s.getAuthorizationUserAction))
	mux.HandleFunc("POST /api/v1/ai-executor-authorization-sessions/{sessionId}/reopen", s.public(nil, []string{"platform.ai_executors.authorize", "platform.ai_executors.change_account"}, s.reopenAuthorizationSession))
	mux.HandleFunc("POST /api/v1/ai-executor-authorization-sessions/{sessionId}/cancel", s.public(nil, []string{"platform.ai_executors.authorize", "platform.ai_executors.change_account", "platform.ai_executors.force_revoke"}, s.cancelAuthorizationSession))
	mux.HandleFunc("GET /api/v1/ai-executor-authorization-sessions/{sessionId}/events", s.public([]string{"platform.ai_executors.view"}, nil, s.listAuthorizationSessionEvents))
	mux.HandleFunc("GET /api/v1/ai-executor-authorization-sessions/{sessionId}/events-stream", s.public([]string{"platform.ai_executors.view"}, nil, s.streamAuthorizationSessionEvents))
	mux.HandleFunc("GET /api/v1/ai-executor-tasks", s.public([]string{"platform.ai_executor_tasks.view"}, nil, s.listPublicTasks))
	mux.HandleFunc("GET /api/v1/ai-executor-tasks/{taskId}", s.public([]string{"platform.ai_executor_tasks.view"}, nil, s.getPublicTask))
	mux.HandleFunc("GET /api/v1/ai-executor-tasks/{taskId}/events", s.public([]string{"platform.ai_executor_tasks.view"}, nil, s.listPublicTaskEvents))
	mux.HandleFunc("GET /api/v1/ai-executor-tasks/{taskId}/events-stream", s.public([]string{"platform.ai_executor_tasks.view"}, nil, s.streamPublicTaskEvents))
	mux.HandleFunc("GET /api/v1/ai-executor-tasks/{taskId}/terminal-frames", s.public([]string{"platform.ai_executor_tasks.view"}, nil, s.listPublicTaskTerminal))
	mux.HandleFunc("GET /api/v1/ai-executor-tasks/{taskId}/terminal-stream", s.public([]string{"platform.ai_executor_tasks.view"}, nil, s.streamPublicTaskTerminal))
	mux.HandleFunc("POST /api/v1/ai-executor-tasks/{taskId}/cancel", s.public([]string{"platform.ai_executor_tasks.cancel"}, nil, s.cancelPublicTask))
	s.registerControlTaskRoutes(mux)
	s.registerDeviceRoutes(mux)
	s.registerOperationConfirmationRoutes(mux)
	s.registerDeviceBindingRoutes(mux)
	s.registerDesktopHandoffRoutes(mux)
	s.registerDesktopActivationRoutes(mux)
	s.registerCredentialRevocationRoutes(mux)

	return mux
}

type actorContext struct {
	ActorID            string
	SessionID          string
	MembershipID       string
	WorkspaceType      string
	WorkspaceID        string
	GrantedPermissions map[string]bool
}

type publicHandler func(http.ResponseWriter, *http.Request, actorContext)

func permissionSet(values []string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[value] = true
	}
	return result
}

func (s *Server) public(requiredAll, requiredAny []string, next publicHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		noStore(w)
		ensureRequestID(r)
		if !s.cfg.WriteEnabled || s.control == nil || s.authorizer == nil {
			writeError(w, r, http.StatusServiceUnavailable, "control_plane_disabled", "Agent Executor control plane is disabled")
			return
		}
		if s.cfg.AuthTokenSecret == "" {
			writeError(w, r, http.StatusServiceUnavailable, "authentication_unavailable", "authentication is unavailable")
			return
		}
		header := r.Header.Get("Authorization")
		if !strings.HasPrefix(header, "Bearer ") {
			writeError(w, r, http.StatusUnauthorized, "unauthorized", "authentication is required")
			return
		}
		payload, err := auth.VerifyToken(s.cfg.AuthTokenSecret, strings.TrimPrefix(header, "Bearer "))
		if err != nil || !validOpaqueID(payload.UserID) || !validOpaqueID(payload.SessionID) {
			writeError(w, r, http.StatusUnauthorized, "unauthorized", "authentication is invalid")
			return
		}
		workspaceType := strings.TrimSpace(r.Header.Get("X-KY-Workspace-Type"))
		workspaceID := strings.TrimSpace(r.Header.Get("X-KY-Workspace-Id"))
		if workspaceType != "platform" || workspaceID != "platform_root" {
			writeError(w, r, http.StatusForbidden, "workspace_forbidden", "platform workspace is required")
			return
		}
		decision, err := s.authorizer.Evaluate(r.Context(), requestID(r), accessclient.Request{
			ActorID: payload.UserID, SessionID: payload.SessionID,
			WorkspaceType: workspaceType, WorkspaceID: workspaceID,
			RequiredAllPermissions: requiredAll, RequiredAnyPermissions: requiredAny,
		})
		if errors.Is(err, accessclient.ErrDenied) {
			writeError(w, r, http.StatusForbidden, "permission_denied", "permission is denied")
			return
		}
		if err != nil {
			writeError(w, r, http.StatusServiceUnavailable, "authorization_unavailable", "authorization decision is unavailable")
			return
		}
		next(w, r, actorContext{
			ActorID: payload.UserID, SessionID: payload.SessionID, MembershipID: decision.MembershipID,
			WorkspaceType: workspaceType, WorkspaceID: workspaceID,
			GrantedPermissions: permissionSet(decision.GrantedRequiredPermissions),
		})
	}
}

func (s *Server) internal(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		noStore(w)
		if s.cfg.InternalToken == "" {
			writeError(w, r, http.StatusServiceUnavailable, "internal_auth_unavailable", "internal authentication is not configured")
			return
		}
		if !tokenEqual(s.cfg.InternalToken, r.Header.Get("X-KY-Internal-Token")) {
			writeError(w, r, http.StatusUnauthorized, "internal_unauthorized", "internal token is invalid")
			return
		}
		if !requestIDPattern.MatchString(requestID(r)) {
			writeError(w, r, http.StatusBadRequest, "request_id_required", "X-KY-Request-Id is required")
			return
		}
		if r.Header.Get("Authorization") != "" ||
			r.Header.Get("X-KY-Workspace-Type") != "" ||
			r.Header.Get("X-KY-Workspace-Id") != "" {
			writeError(w, r, http.StatusBadRequest, "internal_header_forbidden", "user authorization and workspace override headers are forbidden")
			return
		}
		next(w, r)
	}
}

func (s *Server) healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok\n"))
}

func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	databaseReady := s.reader != nil && s.reader.Ping(r.Context()) == nil
	internalTokenConfigured := s.cfg.InternalToken != ""
	controlReady := !s.cfg.WriteEnabled || (s.control != nil && s.control.Ping(r.Context()) == nil && s.authorizer != nil &&
		operationConfirmationRuntimeReady(s.confirmationRuntime) &&
		s.handoffRuntime != nil &&
		s.activationRuntime != nil &&
		s.revocationRuntime != nil &&
		s.cfg.AuthTokenSecret != "" && validDeviceChallengeSecret(s.cfg.DeviceChallengeSecret, s.cfg.AuthTokenSecret, s.cfg.InternalToken))
	status := "ok"
	httpStatus := http.StatusOK
	if !databaseReady || !internalTokenConfigured || !controlReady {
		status = "degraded"
		httpStatus = http.StatusServiceUnavailable
	}
	mode := config.ShadowMode
	if s.cfg.WriteEnabled {
		mode = config.ControlMode
	}
	writeJSON(w, httpStatus, map[string]any{
		"status":                  status,
		"service":                 config.ServiceName,
		"mode":                    mode,
		"writeEnabled":            s.cfg.WriteEnabled && controlReady,
		"scriptMaintenanceReady":  false,
		"databaseReady":           databaseReady,
		"controlReady":            controlReady,
		"internalTokenConfigured": internalTokenConfigured,
	})
}

func (s *Server) getExecutorShadow(w http.ResponseWriter, r *http.Request) {
	if s.reader == nil {
		writeError(w, r, http.StatusServiceUnavailable, "shadow_store_unavailable", "shadow reader is unavailable")
		return
	}
	id := r.PathValue("executorId")
	if !validOpaqueID(id) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "executorId is invalid")
		return
	}
	projection, err := s.reader.Executor(r.Context(), id)
	if err != nil {
		s.writeReadError(w, r, err)
		return
	}
	projection.ReadinessReasonCode = safeCode(projection.ReadinessReasonCode)
	writeData(w, r, http.StatusOK, projection)
}

func (s *Server) getTask(w http.ResponseWriter, r *http.Request) {
	if s.reader == nil {
		writeError(w, r, http.StatusServiceUnavailable, "shadow_store_unavailable", "shadow reader is unavailable")
		return
	}
	id := r.PathValue("taskId")
	if !validOpaqueID(id) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "taskId is invalid")
		return
	}
	projection, err := s.reader.Task(r.Context(), id)
	if err != nil {
		s.writeReadError(w, r, err)
		return
	}
	projection.FailureCode = safeCode(projection.FailureCode)
	writeData(w, r, http.StatusOK, projection)
}

func (s *Server) getTaskResult(w http.ResponseWriter, r *http.Request) {
	if s.reader == nil {
		writeError(w, r, http.StatusServiceUnavailable, "shadow_store_unavailable", "shadow reader is unavailable")
		return
	}
	id := r.PathValue("taskId")
	if !validOpaqueID(id) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "taskId is invalid")
		return
	}
	projection, err := s.reader.TaskResult(r.Context(), id)
	if err != nil {
		s.writeReadError(w, r, err)
		return
	}
	projection.FailureCode = safeCode(projection.FailureCode)
	projection.SafeResult = sanitizeSafeJSON(projection.SafeResult)
	writeData(w, r, http.StatusOK, projection)
}

func (s *Server) shadowWriteRejected(w http.ResponseWriter, r *http.Request) {
	if taskID := r.PathValue("taskId"); taskID != "" && !validOpaqueID(taskID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "taskId is invalid")
		return
	}
	writeError(w, r, http.StatusServiceUnavailable, "shadow_read_only", "Agent Executor P1 is shadow-read-only")
}

func (s *Server) writeReadError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, r, http.StatusNotFound, "not_found", "resource not found")
		return
	}
	// Never expose SQL text, connection strings, paths or driver errors.
	writeError(w, r, http.StatusInternalServerError, "shadow_read_failed", "shadow projection could not be read")
}
