package server

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/store"
	"github.com/Kysion/KyaiCRM/shared/auth"
)

type Server struct {
	cfg   config.Config
	store *store.Store
}

func New(cfg config.Config) *Server {
	return &Server{cfg: cfg}
}

type wsContext struct {
	UserID        string
	WorkspaceType string
	WorkspaceID   string
	MembershipID  string
}

type wsHandler func(w http.ResponseWriter, r *http.Request, wc wsContext)

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

func (s *Server) buildMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /readyz", s.readyz)
	mux.HandleFunc("GET /healthz", s.healthz)

	mux.HandleFunc("GET /api/v1/matrix-accounts", s.ws("view", s.listAccounts))
	mux.HandleFunc("POST /api/v1/matrix-accounts", s.ws("create", s.createAccount))
	mux.HandleFunc("GET /api/v1/matrix-accounts/{id}", s.ws("view", s.getAccount))
	mux.HandleFunc("PATCH /api/v1/matrix-accounts/{id}", s.ws("update", s.updateAccount))
	mux.HandleFunc("DELETE /api/v1/matrix-accounts/{id}", s.ws("delete", s.deleteAccount))
	mux.HandleFunc("PATCH /api/v1/matrix-accounts/{id}/status", s.ws("update_status", s.updateAccountStatus))
	mux.HandleFunc("POST /api/v1/matrix-accounts/{id}/login-tasks", s.ws("login", s.createLoginTask))
	mux.HandleFunc("GET /api/v1/matrix-accounts/{id}/login-tasks/{taskId}", s.ws("login", s.getLoginTask))
	mux.HandleFunc("POST /api/v1/matrix-accounts:batch-disable", s.ws("update_status", s.batchDisable))
	mux.HandleFunc("POST /api/v1/matrix-accounts:batch-check", s.ws("check", s.batchCheck))
	mux.HandleFunc("GET /api/v1/matrix-account-login-scripts", s.wsAny([]string{"matrix_account_scripts.view", "matrix_account_login_scripts.view"}, s.listLoginScripts))
	mux.HandleFunc("GET /api/v1/matrix-account-login-scripts/{id}", s.wsAny([]string{"matrix_account_scripts.view", "matrix_account_login_scripts.view"}, s.getLoginScript))
	mux.HandleFunc("PATCH /api/v1/matrix-account-login-scripts/{id}/status", s.wsAny([]string{"matrix_account_scripts.manage", "matrix_account_login_scripts.update"}, s.updateLoginScriptStatus))
	mux.HandleFunc("GET /api/v1/matrix-account-login-scripts/{id}/versions", s.wsAny([]string{"matrix_account_scripts.view", "matrix_account_login_scripts.view"}, s.listLoginScriptVersions))
	mux.HandleFunc("POST /api/v1/matrix-account-login-scripts/{id}/versions/{versionId}/activate", s.wsAny([]string{"matrix_account_scripts.manage", "matrix_account_login_scripts.activate_version"}, s.activateLoginScriptVersion))
	mux.HandleFunc("POST /api/v1/matrix-account-web-spaces", s.ws("create", s.createWebSpace))
	mux.HandleFunc("GET /api/v1/matrix-account-web-spaces/{id}", s.ws("view", s.getWebSpace))
	mux.HandleFunc("POST /api/v1/matrix-account-web-spaces/{id}/detect-result", s.ws("create", s.submitWebSpaceDetectResult))
	mux.HandleFunc("POST /api/v1/matrix-account-web-spaces/{id}/login-script/resolve", s.ws("create", s.resolveWebSpaceLoginScript))
	mux.HandleFunc("POST /api/v1/matrix-account-web-spaces/{id}/login-script/generate", s.ws("create", s.generateWebSpaceLoginScript))
	mux.HandleFunc("POST /api/v1/matrix-account-web-spaces/{id}/login-script/run-result", s.ws("create", s.submitWebSpaceLoginScriptRunResult))
	mux.HandleFunc("GET /api/v1/matrix-account-web-spaces/{id}/login-script/runs", s.ws("create", s.listWebSpaceLoginScriptRuns))
	mux.HandleFunc("POST /api/v1/matrix-account-web-spaces/{id}/abandon", s.ws("create", s.abandonWebSpace))
	mux.HandleFunc("POST /api/v1/matrix-account-web-spaces/{id}/clear", s.ws("clear_session", s.clearWebSpace))
	mux.HandleFunc("POST /api/v1/matrix-account-login-attempts", s.ws("create", s.createLoginAttempt))
	mux.HandleFunc("GET /api/v1/matrix-account-login-attempts/{id}", s.ws("view", s.getLoginAttempt))
	mux.HandleFunc("GET /api/v1/matrix-account-login-attempts/{id}/events", s.ws("view", s.listLoginAttemptEvents))
	mux.HandleFunc("POST /api/v1/matrix-account-login-attempts/{id}/commands/{command}", s.ws("login", s.runLoginAttemptCommand))
	mux.HandleFunc("POST /api/v1/matrix-account-login-attempts/{id}/step-results", s.ws("login", s.submitLoginAttemptStepResult))

	return mux
}

func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	databaseReady := s.store != nil && s.store.Ping(r.Context()) == nil
	tokenSecretConfigured := s.cfg.AuthTokenSecret != ""
	status := "ok"
	if !databaseReady || !tokenSecretConfigured {
		status = "degraded"
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	writeJSON(w, map[string]any{
		"status":                status,
		"service":               s.cfg.ServiceName,
		"databaseReady":         databaseReady,
		"tokenSecretConfigured": tokenSecretConfigured,
	})
}

func (s *Server) healthz(w http.ResponseWriter, _ *http.Request) {
	_, _ = w.Write([]byte("ok\n"))
}

func (s *Server) ws(requiredAction string, next wsHandler) http.HandlerFunc {
	return s.wsAny([]string{requiredAction}, next)
}

func (s *Server) wsAny(requiredActions []string, next wsHandler) http.HandlerFunc {
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
		if !validOneOf(wsType, "platform", "agency", "enterprise") {
			writeError(w, r, http.StatusForbidden, "workspace_forbidden", "工作区类型无效")
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
		requiredPerms := make([]string, 0, len(requiredActions))
		for _, action := range requiredActions {
			requiredPerms = append(requiredPerms, workspacePermissionCode(wsType, action))
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

func workspacePermissionCode(workspaceType, requiredAction string) string {
	if strings.HasPrefix(requiredAction, workspaceType+".") {
		return requiredAction
	}
	if strings.Contains(requiredAction, ".") {
		return workspaceType + "." + requiredAction
	}
	return workspaceType + ".matrix_accounts." + requiredAction
}
