package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-auth-service/internal/auth"
	"github.com/Kysion/KyaiCRM/services/ky-auth-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-auth-service/internal/store"
	sharedauth "github.com/Kysion/KyaiCRM/shared/auth"
)

const sessionTTL = 24 * time.Hour
const desktopClientMode = "desktop"

type Server struct {
	cfg   config.Config
	store *store.Store
}

func New(cfg config.Config) *Server {
	return &Server{cfg: cfg}
}

func (s *Server) Run(ctx context.Context) error {
	if s.cfg.DatabaseURL != "" {
		opened, err := store.Open(ctx, s.cfg.DatabaseURL)
		if err == nil {
			s.store = opened
			defer opened.Close()
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /readyz", s.readyz)
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("POST /api/v1/auth/register", s.register)
	mux.HandleFunc("POST /api/v1/auth/login", s.login)
	mux.HandleFunc("POST /api/v1/auth/logout", s.logout)
	mux.HandleFunc("POST /api/v1/auth/change-password", s.changePassword)
	mux.HandleFunc("GET /api/v1/auth/me", s.me)
	mux.HandleFunc("GET /api/v1/auth/bootstrap", s.bootstrap)
	mux.HandleFunc("GET /api/v1/login-logs", s.loginLogs)
	mux.HandleFunc("GET /api/v1/platform/users", s.searchPlatformUsers)
	mux.HandleFunc("PATCH /api/v1/platform/users/{id}", s.updateUser)
	mux.HandleFunc("POST /api/v1/platform/users/{id}/reset-password", s.resetUserPassword)

	server := &http.Server{
		Addr:    s.cfg.HTTPAddr,
		Handler: mux,
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- server.ListenAndServe()
	}()

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

func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	databaseReady := false
	if s.store != nil {
		databaseReady = s.store.Ping(r.Context()) == nil
	}
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

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	_, _ = fmt.Fprintln(w, "ok")
}

type registerRequest struct {
	DisplayName string `json:"displayName"`
	Email       string `json:"email"`
	Phone       string `json:"phone"`
	Password    string `json:"password"`
}

type loginRequest struct {
	Account    string `json:"account"`
	Password   string `json:"password"`
	ClientMode string `json:"clientMode"`
	ClientName string `json:"clientName"`
}

func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	if !s.ensureReady(w, r) {
		return
	}
	var req registerRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	req.Email = strings.TrimSpace(req.Email)
	req.Phone = strings.TrimSpace(req.Phone)
	if req.Password == "" || (req.Email == "" && req.Phone == "") || req.DisplayName == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "displayName、password 以及 email/phone 至少一项不能为空")
		return
	}

	userID := newID("user")
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "密码处理失败")
		return
	}
	username := ""
	if req.Email != "" {
		username = strings.Split(req.Email, "@")[0]
	}
	if username == "" {
		username = userID
	}
	user := store.User{ID: userID, Username: username, DisplayName: req.DisplayName, AvatarURL: "", Email: req.Email, Phone: req.Phone, Status: "normal"}
	if err := s.store.CreateUser(r.Context(), user); err != nil {
		writeError(w, r, http.StatusConflict, "conflict", "用户创建失败")
		return
	}
	for _, identifier := range []string{username, req.Email, req.Phone} {
		if identifier == "" {
			continue
		}
		if err := s.store.CreateCredential(r.Context(), newID("cred"), userID, identifier, hash); err != nil {
			writeError(w, r, http.StatusConflict, "conflict", "登录凭据创建失败")
			return
		}
	}

	token, expiresAt, err := s.createSessionToken(r.Context(), userID, clientIP(r), r.UserAgent())
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "会话创建失败")
		return
	}
	writeData(w, r, map[string]any{"userId": userID, "token": token, "expiresAt": expiresAt.Format(time.RFC3339)})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !s.ensureReady(w, r) {
		return
	}
	var req loginRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	req.Account = strings.TrimSpace(req.Account)
	if req.Account == "" || req.Password == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "account 和 password 不能为空")
		return
	}
	userAgent := clientUserAgent(r, req.ClientMode, req.ClientName)
	credential, err := s.store.FindPasswordCredential(r.Context(), req.Account)
	if err != nil || credential.Status != "normal" || credential.User.Status != "normal" || !auth.VerifyPassword(credential.PasswordHash, req.Password) {
		_ = s.store.WriteLoginLog(r.Context(), newID("login"), nil, req.Account, "failed", "invalid credential", clientIP(r), userAgent)
		writeError(w, r, http.StatusUnauthorized, "unauthorized", "账号或密码错误")
		return
	}
	if err := s.store.UpdateLastLogin(r.Context(), credential.UserID); err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "登录状态更新失败")
		return
	}
	token, expiresAt, err := s.createSessionToken(r.Context(), credential.UserID, clientIP(r), userAgent)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "会话创建失败")
		return
	}
	_ = s.store.WriteLoginLog(r.Context(), newID("login"), &credential.UserID, req.Account, "success", "", clientIP(r), userAgent)
	writeData(w, r, map[string]any{
		"token":     token,
		"expiresAt": expiresAt.Format(time.RFC3339),
		"user": map[string]any{
			"id":          credential.User.ID,
			"username":    credential.User.Username,
			"displayName": credential.User.DisplayName,
			"avatarUrl":   credential.User.AvatarURL,
		},
	})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	payload, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	if err := s.store.RevokeSession(r.Context(), payload.SessionID); err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "登出失败")
		return
	}
	writeData(w, r, map[string]bool{"success": true})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	payload, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	user, err := s.store.GetUserByID(r.Context(), payload.UserID)
	if err != nil {
		writeError(w, r, http.StatusNotFound, "not_found", "用户不存在")
		return
	}
	writeData(w, r, map[string]any{
		"id":          user.ID,
		"username":    user.Username,
		"displayName": user.DisplayName,
		"avatarUrl":   user.AvatarURL,
		"phone":       user.Phone,
		"email":       user.Email,
		"status":      user.Status,
	})
}

func (s *Server) bootstrap(w http.ResponseWriter, r *http.Request) {
	payload, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	user, err := s.store.GetUserByID(r.Context(), payload.UserID)
	if err != nil {
		writeError(w, r, http.StatusNotFound, "not_found", "用户不存在")
		return
	}
	memberships, err := s.store.ListActiveMemberships(r.Context(), payload.UserID)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "后台身份查询失败")
		return
	}
	workspaces := make([]store.WorkspaceIdentity, 0, len(memberships))
	for _, membership := range memberships {
		name, err := s.store.WorkspaceName(r.Context(), membership.WorkspaceType, membership.WorkspaceID)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "internal_error", "工作区名称查询失败")
			return
		}
		roles, err := s.store.RolesForMembership(r.Context(), membership.ID)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "internal_error", "角色查询失败")
			return
		}
		permissions, actionPermissions, menuKeys, err := s.store.PermissionsForMembership(r.Context(), membership.ID)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "internal_error", "权限查询失败")
			return
		}
		dataScopes, err := s.store.DataScopesForMembership(r.Context(), membership.ID)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "internal_error", "数据范围查询失败")
			return
		}
		workspaces = append(workspaces, store.WorkspaceIdentity{
			ID:                membership.WorkspaceID,
			Type:              membership.WorkspaceType,
			Name:              name,
			MembershipID:      membership.ID,
			Roles:             roles,
			Permissions:       permissions,
			ActionPermissions: actionPermissions,
			MenuKeys:          menuKeys,
			DataScopes:        dataScopes,
		})
	}
	writeData(w, r, map[string]any{
		"user": map[string]any{
			"id":          user.ID,
			"username":    user.Username,
			"displayName": user.DisplayName,
			"avatarUrl":   user.AvatarURL,
			"phone":       user.Phone,
			"email":       user.Email,
		},
		"workspaces":             workspaces,
		"recommendedWorkspaceId": nil,
	})
}

func (s *Server) createSessionToken(ctx context.Context, userID string, ipAddress string, userAgent string) (string, time.Time, error) {
	sessionID := newID("session")
	tokenID := newID("token")
	expiresAt := time.Now().Add(sessionTTL)
	if err := s.store.CreateSession(ctx, store.Session{ID: sessionID, UserID: userID, TokenID: tokenID, IPAddress: ipAddress, UserAgent: userAgent, ExpiresAt: expiresAt}); err != nil {
		return "", time.Time{}, err
	}
	token, err := sharedauth.SignToken(s.cfg.AuthTokenSecret, sharedauth.TokenPayload{UserID: userID, SessionID: sessionID, Exp: expiresAt.Unix()})
	return token, expiresAt, err
}

func (s *Server) requireAuth(w http.ResponseWriter, r *http.Request) (sharedauth.TokenPayload, bool) {
	if !s.ensureReady(w, r) {
		return sharedauth.TokenPayload{}, false
	}
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		writeError(w, r, http.StatusUnauthorized, "unauthorized", "未登录或 token 无效")
		return sharedauth.TokenPayload{}, false
	}
	payload, err := sharedauth.VerifyToken(s.cfg.AuthTokenSecret, strings.TrimPrefix(header, "Bearer "))
	if err != nil {
		writeError(w, r, http.StatusUnauthorized, "unauthorized", "未登录或 token 无效")
		return sharedauth.TokenPayload{}, false
	}
	active, err := s.store.IsSessionActive(r.Context(), payload.SessionID, time.Now())
	if err != nil || !active {
		writeError(w, r, http.StatusUnauthorized, "unauthorized", "会话已失效")
		return sharedauth.TokenPayload{}, false
	}
	return payload, true
}

func (s *Server) ensureReady(w http.ResponseWriter, r *http.Request) bool {
	if s.store == nil {
		writeError(w, r, http.StatusServiceUnavailable, "service_unavailable", "数据库未连接")
		return false
	}
	if s.cfg.AuthTokenSecret == "" {
		writeError(w, r, http.StatusServiceUnavailable, "service_unavailable", "Token Secret 未配置")
		return false
	}
	return true
}

func decodeJSON(w http.ResponseWriter, r *http.Request, value any) bool {
	if err := json.NewDecoder(r.Body).Decode(value); err != nil {
		writeError(w, r, http.StatusBadRequest, "validation_error", "请求 JSON 格式错误")
		return false
	}
	return true
}

func writeData(w http.ResponseWriter, r *http.Request, data any) {
	writeJSON(w, map[string]any{"data": data, "requestId": requestID(r)})
}

func writeError(w http.ResponseWriter, r *http.Request, status int, code string, message string) {
	w.WriteHeader(status)
	writeJSON(w, map[string]any{
		"error":     map[string]any{"code": code, "message": message, "details": map[string]any{}},
		"requestId": requestID(r),
	})
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func requestID(r *http.Request) string {
	if id := r.Header.Get("X-KY-Request-Id"); id != "" {
		return id
	}
	return newID("req")
}

func newID(prefix string) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(errors.New("failed to generate id"))
	}
	return prefix + "_" + hex.EncodeToString(b[:])
}

func clientIP(r *http.Request) string {
	if ip := r.Header.Get("X-Forwarded-For"); ip != "" {
		return strings.TrimSpace(strings.Split(ip, ",")[0])
	}
	return r.RemoteAddr
}

func clientUserAgent(r *http.Request, bodyMode string, bodyName string) string {
	userAgent := r.UserAgent()
	mode := normalizeClientMode(firstNonEmpty(bodyMode, r.Header.Get("X-AiCRM-Client-Mode")))
	if mode == "" {
		return userAgent
	}
	name := sanitizeClientMarker(firstNonEmpty(bodyName, r.Header.Get("X-AiCRM-Client-Name")))
	marker := "[client:" + mode
	if name != "" {
		marker += ";name:" + name
	}
	marker += "]"
	if strings.HasPrefix(userAgent, marker) {
		return userAgent
	}
	if strings.TrimSpace(userAgent) == "" {
		return marker
	}
	return marker + " " + userAgent
}

func normalizeClientMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case desktopClientMode, "electron", "aicrm-desktop":
		return desktopClientMode
	default:
		return ""
	}
}

func sanitizeClientMarker(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' {
			return r
		}
		if r >= '0' && r <= '9' {
			return r
		}
		if r == '-' || r == '_' || r == '.' {
			return r
		}
		return -1
	}, value)
	if len(value) > 40 {
		return value[:40]
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
