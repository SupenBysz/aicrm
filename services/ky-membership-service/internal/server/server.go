package server

import (
	"context"
	"net/http"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-membership-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-membership-service/internal/store"
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

func (s *Server) Run(ctx context.Context) error {
	if s.cfg.DatabaseURL != "" {
		if opened, err := store.Open(ctx, s.cfg.DatabaseURL); err == nil {
			s.store = opened
			defer opened.Close()
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /readyz", s.readyz)
	mux.HandleFunc("GET /healthz", s.healthz)

	const allWs = "platform,agency,enterprise"
	const orgWs = "agency,enterprise"

	perms := func(codes ...string) []string { return codes }

	// Workspace members
	mux.HandleFunc("GET /api/v1/workspace/members", s.ws(allWs, perms("platform.members.view", "agency.members.view", "enterprise.members.view"), s.listMembers))
	mux.HandleFunc("POST /api/v1/workspace/members", s.ws(allWs, perms("platform.members.create", "agency.members.create", "enterprise.members.create"), s.createMember))
	mux.HandleFunc("GET /api/v1/workspace/members/{id}", s.ws(allWs, perms("platform.members.view", "agency.members.view", "enterprise.members.view"), s.getMember))
	mux.HandleFunc("PATCH /api/v1/workspace/members/{id}/status", s.ws(allWs, perms("platform.members.disable", "agency.members.disable", "enterprise.members.disable"), s.updateMemberStatus))
	mux.HandleFunc("DELETE /api/v1/workspace/members/{id}", s.ws(allWs, perms("platform.members.remove", "agency.members.remove", "enterprise.members.remove"), s.removeMember))
	mux.HandleFunc("POST /api/v1/workspace/members/{id}/departments", s.ws(orgWs, perms("agency.members.assign_department", "enterprise.members.assign_department"), s.assignMemberDepartments))
	mux.HandleFunc("POST /api/v1/workspace/members/{id}/teams", s.ws(orgWs, perms("agency.members.assign_team", "enterprise.members.assign_team"), s.assignMemberTeams))
	// Platform view: members of a specific organization (for agency/enterprise lists)
	mux.HandleFunc("GET /api/v1/platform/organizations/{workspaceType}/{workspaceId}/members", s.ws("platform", perms("platform.members.view"), s.listOrgMembers))

	// Invitations
	mux.HandleFunc("GET /api/v1/invitations", s.ws(allWs, perms("platform.invitations.view", "agency.invitations.view", "enterprise.invitations.view"), s.listInvitations))
	mux.HandleFunc("POST /api/v1/invitations", s.ws(allWs, perms("platform.members.invite", "agency.members.invite", "agency.enterprises.invite_admin", "enterprise.members.invite"), s.createInvitation))
	mux.HandleFunc("PATCH /api/v1/invitations/{id}/cancel", s.ws(allWs, perms("platform.members.invite", "agency.members.invite", "agency.enterprises.invite_admin", "enterprise.members.invite"), s.cancelInvitation))

	// Access API — roles
	mux.HandleFunc("GET /api/v1/roles", s.ws(allWs, perms("platform.roles.view", "agency.roles.view", "enterprise.roles.view"), s.listRoles))
	mux.HandleFunc("POST /api/v1/roles", s.ws(allWs, perms("platform.roles.create", "agency.roles.create", "enterprise.roles.create"), s.createRole))
	mux.HandleFunc("PATCH /api/v1/roles/{id}", s.ws(allWs, perms("platform.roles.update", "agency.roles.update", "enterprise.roles.update"), s.updateRole))
	mux.HandleFunc("PATCH /api/v1/roles/{id}/status", s.ws(allWs, perms("platform.roles.disable", "agency.roles.update", "enterprise.roles.update"), s.updateRoleStatus))
	mux.HandleFunc("POST /api/v1/roles/{id}/permissions", s.ws(allWs, perms("platform.roles.update_permissions", "agency.roles.update_permissions", "enterprise.roles.update_permissions"), s.setRolePermissions))

	// Access API — permissions catalog
	mux.HandleFunc("GET /api/v1/permissions", s.ws(allWs, perms("platform.permissions.view", "agency.permissions.view", "enterprise.permissions.view"), s.listPermissions))

	// Access API — memberships authorization
	mux.HandleFunc("POST /api/v1/memberships/{id}/roles", s.ws(allWs, perms("platform.roles.assign", "agency.roles.assign", "enterprise.roles.assign"), s.assignMembershipRoles))
	mux.HandleFunc("GET /api/v1/memberships/{id}/permissions", s.ws(allWs, perms("platform.roles.view", "agency.roles.view", "enterprise.roles.view"), s.membershipPermissions))

	// Access API — data scopes
	mux.HandleFunc("GET /api/v1/data-scopes", s.ws(allWs, perms("platform.data_scopes.view", "agency.data_scopes.view", "enterprise.data_scopes.view"), s.listDataScopes))

	// Notifications
	mux.HandleFunc("GET /api/v1/notifications", s.ws(allWs, perms("platform.notifications.view", "agency.notifications.view", "enterprise.notifications.view"), s.listNotifications))
	mux.HandleFunc("GET /api/v1/notifications/unread-count", s.ws(allWs, perms("platform.notifications.view", "agency.notifications.view", "enterprise.notifications.view"), s.notificationUnreadCount))
	mux.HandleFunc("PATCH /api/v1/notifications/{id}/read", s.ws(allWs, perms("platform.notifications.view", "agency.notifications.view", "enterprise.notifications.view"), s.markNotificationRead))
	mux.HandleFunc("POST /api/v1/notifications/read-all", s.ws(allWs, perms("platform.notifications.view", "agency.notifications.view", "enterprise.notifications.view"), s.markAllNotificationsRead))

	// Announcements
	mux.HandleFunc("GET /api/v1/announcements", s.ws(allWs, perms("platform.announcements.view", "agency.announcements.view", "enterprise.announcements.view"), s.listAnnouncements))
	mux.HandleFunc("POST /api/v1/announcements", s.ws("platform", perms("platform.announcements.create"), s.createAnnouncement))
	mux.HandleFunc("PATCH /api/v1/announcements/{id}", s.ws("platform", perms("platform.announcements.update"), s.updateAnnouncement))
	mux.HandleFunc("DELETE /api/v1/announcements/{id}", s.ws("platform", perms("platform.announcements.delete"), s.deleteAnnouncement))
	mux.HandleFunc("PATCH /api/v1/announcements/{id}/publish", s.ws("platform", perms("platform.announcements.publish"), s.publishAnnouncement))

	// Audit logs
	mux.HandleFunc("GET /api/v1/audit-logs", s.ws(allWs, perms("platform.audit.view", "agency.audit.view", "enterprise.audit.view"), s.listAuditLogs))

	// Public invitations (no auth)
	mux.HandleFunc("GET /api/v1/public/invitations/{token}", s.getPublicInvitation)
	mux.HandleFunc("POST /api/v1/public/invitations/{token}/accept", s.acceptPublicInvitation)

	server := &http.Server{Addr: s.cfg.HTTPAddr, Handler: mux}

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

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	_, _ = w.Write([]byte("ok\n"))
}

type wsHandler func(w http.ResponseWriter, r *http.Request, wc wsContext)

// ws wraps a handler with auth + workspace validation + permission gating.
// requiredPerms is an OR set: the caller must hold at least one of the codes
// in the current workspace. An empty set means membership alone suffices.
func (s *Server) ws(allowedTypes string, requiredPerms []string, next wsHandler) http.HandlerFunc {
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
		if !typeAllowed(allowedTypes, wsType) {
			writeError(w, r, http.StatusForbidden, "workspace_forbidden", "当前工作区不允许访问该接口")
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
		if len(requiredPerms) > 0 {
			ok, err := s.store.HasAny(r.Context(), membershipID, requiredPerms)
			if err != nil {
				writeError(w, r, http.StatusInternalServerError, "internal_error", "权限校验失败")
				return
			}
			if !ok {
				writeError(w, r, http.StatusForbidden, "permission_denied", "当前后台身份无权执行该操作")
				return
			}
		}
		next(w, r, wsContext{UserID: payload.UserID, WorkspaceType: wsType, WorkspaceID: wsID, MembershipID: membershipID})
	}
}

func typeAllowed(allowed, wsType string) bool {
	for _, t := range splitComma(allowed) {
		if t == wsType {
			return true
		}
	}
	return false
}

func splitComma(s string) []string {
	out := []string{}
	cur := ""
	for _, c := range s {
		if c == ',' {
			if cur != "" {
				out = append(out, cur)
			}
			cur = ""
			continue
		}
		cur += string(c)
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}
