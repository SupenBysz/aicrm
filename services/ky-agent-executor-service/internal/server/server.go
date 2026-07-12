package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
)

type Server struct {
	cfg    config.Config
	reader store.Reader
}

func New(cfg config.Config) *Server {
	return &Server{cfg: cfg}
}

func newWithReader(cfg config.Config, reader store.Reader) *Server {
	return &Server{cfg: cfg, reader: reader}
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

	return mux
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
	status := "ok"
	httpStatus := http.StatusOK
	if !databaseReady || !internalTokenConfigured {
		status = "degraded"
		httpStatus = http.StatusServiceUnavailable
	}
	writeJSON(w, httpStatus, map[string]any{
		"status":                  status,
		"service":                 config.ServiceName,
		"mode":                    config.ShadowMode,
		"writeEnabled":            false,
		"scriptMaintenanceReady":  false,
		"databaseReady":           databaseReady,
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
