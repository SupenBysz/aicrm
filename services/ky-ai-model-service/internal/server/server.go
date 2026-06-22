package server

import (
	"context"
	"net/http"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-ai-model-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-ai-model-service/internal/crypto"
	"github.com/Kysion/KyaiCRM/services/ky-ai-model-service/internal/store"
	"github.com/Kysion/KyaiCRM/shared/auth"
)

type Server struct {
	cfg    config.Config
	store  *store.Store
	cipher *crypto.Cipher
}

func New(cfg config.Config) *Server {
	c, _ := crypto.New(cfg.AISecretKey)
	return &Server{cfg: cfg, cipher: c}
}

type wsContext struct {
	UserID        string
	WorkspaceType string
	WorkspaceID   string
	MembershipID  string
}

func (s *Server) Run(ctx context.Context) error {
	if s.cfg.DatabaseURL != "" {
		if opened, err := store.Open(ctx, s.cfg.DatabaseURL); err == nil {
			s.store = opened
			defer opened.Close()
		}
	}

	server := &http.Server{Addr: s.cfg.HTTPAddr, Handler: s.buildMux()}

	errCh := make(chan error, 1)
	go func() { errCh <- server.ListenAndServe() }()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithCancel(context.Background())
		defer cancel()
		return server.Shutdown(shutdownCtx)
	case err := <-errCh:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	}
}

// buildMux registers all routes. Extracted from Run so a test can construct it
// and catch Go 1.22 ServeMux pattern conflicts (which only panic at registration
// time and are invisible to `go build`/`go vet`).
func (s *Server) buildMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /readyz", s.readyz)
	mux.HandleFunc("GET /healthz", s.healthz)

	perms := func(codes ...string) []string { return codes }

	mux.HandleFunc("GET /api/v1/ai-models/providers", s.ws(perms("platform.ai_providers.view"), s.listProviders))
	mux.HandleFunc("POST /api/v1/ai-models/providers", s.ws(perms("platform.ai_providers.create"), s.createProvider))
	mux.HandleFunc("PATCH /api/v1/ai-models/providers/{id}", s.ws(perms("platform.ai_providers.update"), s.updateProvider))
	mux.HandleFunc("PATCH /api/v1/ai-models/providers/{id}/status", s.ws(perms("platform.ai_providers.update_status"), s.updateProviderStatus))
	mux.HandleFunc("POST /api/v1/ai-models/providers/{id}/rotate-api-key", s.ws(perms("platform.ai_providers.rotate_key"), s.rotateProviderAPIKey))

	mux.HandleFunc("GET /api/v1/ai-models/settings", s.ws(perms("platform.ai_model_settings.view"), s.getSettings))
	mux.HandleFunc("PATCH /api/v1/ai-models/settings", s.ws(perms("platform.ai_model_settings.update"), s.updateSettings))

	// Models are a sub-collection (/ai-models/models) so the {id} wildcard never
	// overlaps the sibling literals `providers`/`settings` — otherwise Go 1.22's
	// ServeMux panics on ambiguous patterns at registration time.
	mux.HandleFunc("GET /api/v1/ai-models/models", s.ws(perms("platform.ai_models.view"), s.listModels))
	mux.HandleFunc("POST /api/v1/ai-models/models", s.ws(perms("platform.ai_models.create"), s.createModel))
	mux.HandleFunc("PATCH /api/v1/ai-models/models/{id}", s.ws(perms("platform.ai_models.update"), s.updateModel))
	mux.HandleFunc("PATCH /api/v1/ai-models/models/{id}/status", s.ws(perms("platform.ai_models.update_status"), s.updateModelStatus))
	mux.HandleFunc("POST /api/v1/ai-models/models/{id}/test", s.ws(perms("platform.ai_models.test"), s.testModel))

	return mux
}

func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	databaseReady := s.store != nil && s.store.Ping(r.Context()) == nil
	tokenSecretConfigured := s.cfg.AuthTokenSecret != ""
	aiSecretConfigured := s.cipher != nil
	status := "ok"
	if !databaseReady || !tokenSecretConfigured || !aiSecretConfigured {
		status = "degraded"
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	writeJSON(w, map[string]any{
		"status":                status,
		"service":               s.cfg.ServiceName,
		"databaseReady":         databaseReady,
		"tokenSecretConfigured": tokenSecretConfigured,
		"aiSecretConfigured":    aiSecretConfigured,
	})
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	_, _ = w.Write([]byte("ok\n"))
}

type wsHandler func(w http.ResponseWriter, r *http.Request, wc wsContext)

// ws gates a handler to the platform workspace with the given required
// permissions (OR set). All AI configuration is platform-only.
func (s *Server) ws(requiredPerms []string, next wsHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.store == nil {
			writeError(w, r, http.StatusServiceUnavailable, "service_unavailable", "数据库未连接")
			return
		}
		if s.cfg.AuthTokenSecret == "" {
			writeError(w, r, http.StatusServiceUnavailable, "service_unavailable", "Token Secret 未配置")
			return
		}
		header := r.Header.Get("Authorization")
		if len(header) < 8 || header[:7] != "Bearer " {
			writeError(w, r, http.StatusUnauthorized, "unauthorized", "未登录或 token 无效")
			return
		}
		payload, err := auth.VerifyToken(s.cfg.AuthTokenSecret, header[7:])
		if err != nil {
			writeError(w, r, http.StatusUnauthorized, "unauthorized", "未登录或 token 无效")
			return
		}
		active, err := s.store.SessionActive(r.Context(), payload.SessionID, time.Now())
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "internal_error", "会话校验失败")
			return
		}
		if !active {
			writeError(w, r, http.StatusUnauthorized, "unauthorized", "会话已失效")
			return
		}
		wsType := r.Header.Get("X-KY-Workspace-Type")
		wsID := r.Header.Get("X-KY-Workspace-Id")
		if wsType == "" || wsID == "" {
			writeError(w, r, http.StatusBadRequest, "workspace_required", "缺少工作区 Header")
			return
		}
		if wsType != "platform" {
			writeError(w, r, http.StatusForbidden, "workspace_forbidden", "AI 配置仅平台后台可访问")
			return
		}
		membershipID, err := s.store.ActiveMembershipID(r.Context(), payload.UserID, wsType, wsID)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "internal_error", "工作区身份校验失败")
			return
		}
		if membershipID == "" {
			writeError(w, r, http.StatusForbidden, "workspace_forbidden", "用户无当前工作区身份")
			return
		}
		ok, err := s.store.HasAny(r.Context(), membershipID, requiredPerms)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "internal_error", "权限校验失败")
			return
		}
		if !ok {
			writeError(w, r, http.StatusForbidden, "permission_denied", "当前后台身份无权执行该操作")
			return
		}
		next(w, r, wsContext{UserID: payload.UserID, WorkspaceType: wsType, WorkspaceID: wsID, MembershipID: membershipID})
	}
}
