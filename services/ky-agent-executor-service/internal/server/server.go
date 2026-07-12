package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/accessclient"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/shared/auth"
)

type Server struct {
	cfg        config.Config
	reader     store.Reader
	control    controlStore
	authorizer accessclient.Authorizer
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

	return mux
}

type actorContext struct {
	ActorID       string
	SessionID     string
	MembershipID  string
	WorkspaceType string
	WorkspaceID   string
}

type publicHandler func(http.ResponseWriter, *http.Request, actorContext)

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
	controlReady := !s.cfg.WriteEnabled || (s.control != nil && s.control.Ping(r.Context()) == nil && s.authorizer != nil && s.cfg.AuthTokenSecret != "")
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
