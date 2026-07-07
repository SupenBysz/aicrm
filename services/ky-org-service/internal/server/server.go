package server

import (
	"context"
	"net/http"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/store"
	"github.com/Kysion/KyaiCRM/shared/auth"
	"github.com/Kysion/KyaiCRM/shared/crypto"
)

type Server struct {
	cfg    config.Config
	store  *store.Store
	cipher *crypto.Cipher
}

func New(cfg config.Config) *Server {
	c, _ := crypto.New(cfg.SecretKey)
	return &Server{cfg: cfg, cipher: c}
}

// wsContext carries the validated workspace identity for a request.
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

	perms := func(codes ...string) []string { return codes }
	const orgWs = "agency,enterprise"

	// Platform agencies
	mux.HandleFunc("GET /api/v1/platform/agencies", s.ws("platform", perms("platform.agencies.view"), s.listAgencies))
	mux.HandleFunc("POST /api/v1/platform/agencies", s.ws("platform", perms("platform.agencies.create"), s.createAgency))
	mux.HandleFunc("GET /api/v1/platform/agencies/{id}", s.ws("platform", perms("platform.agencies.view"), s.getAgency))
	mux.HandleFunc("PATCH /api/v1/platform/agencies/{id}", s.ws("platform", perms("platform.agencies.update"), s.updateAgency))
	mux.HandleFunc("PATCH /api/v1/platform/agencies/{id}/status", s.ws("platform", perms("platform.agencies.disable", "platform.agencies.freeze"), s.updateAgencyStatus))

	// Platform enterprises
	mux.HandleFunc("GET /api/v1/platform/enterprises", s.ws("platform", perms("platform.enterprises.view"), s.listEnterprises))
	mux.HandleFunc("POST /api/v1/platform/enterprises", s.ws("platform", perms("platform.enterprises.create"), s.createEnterprise))
	mux.HandleFunc("GET /api/v1/platform/enterprises/{id}", s.ws("platform", perms("platform.enterprises.view"), s.getEnterprise))
	mux.HandleFunc("PATCH /api/v1/platform/enterprises/{id}", s.ws("platform", perms("platform.enterprises.update"), s.updateEnterprise))
	mux.HandleFunc("PATCH /api/v1/platform/enterprises/{id}/agency", s.ws("platform", perms("platform.enterprises.assign_agency"), s.assignEnterpriseAgency))
	mux.HandleFunc("PATCH /api/v1/platform/enterprises/{id}/status", s.ws("platform", perms("platform.enterprises.disable"), s.updateEnterpriseStatus))

	// Qualifications (资质审核): organizations submit from their workspace, platform reviews
	mux.HandleFunc("GET /api/v1/qualifications", s.ws(orgWs, perms("agency.qualification.view", "enterprise.qualification.view"), s.listMyQualifications))
	mux.HandleFunc("POST /api/v1/qualifications", s.ws(orgWs, perms("agency.qualification.submit", "enterprise.qualification.submit"), s.submitQualification))
	mux.HandleFunc("GET /api/v1/platform/qualifications", s.ws("platform", perms("platform.qualifications.view"), s.listQualifications))
	mux.HandleFunc("GET /api/v1/platform/qualifications/{id}", s.ws("platform", perms("platform.qualifications.view"), s.getQualification))
	mux.HandleFunc("PATCH /api/v1/platform/qualifications/{id}/approve", s.ws("platform", perms("platform.qualifications.review"), s.approveQualification))
	mux.HandleFunc("PATCH /api/v1/platform/qualifications/{id}/reject", s.ws("platform", perms("platform.qualifications.review"), s.rejectQualification))

	// Current organization
	mux.HandleFunc("GET /api/v1/organizations/current", s.ws(orgWs, perms("agency.profile.view", "enterprise.profile.view"), s.getCurrentOrg))
	mux.HandleFunc("PATCH /api/v1/organizations/current", s.ws(orgWs, perms("agency.profile.update", "enterprise.profile.update"), s.updateCurrentOrg))

	// Agency enterprises
	mux.HandleFunc("GET /api/v1/agency/enterprises", s.ws("agency", perms("agency.enterprises.view"), s.listAgencyEnterprises))
	mux.HandleFunc("GET /api/v1/agency/enterprises/{id}", s.ws("agency", perms("agency.enterprises.view"), s.getAgencyEnterprise))
	mux.HandleFunc("POST /api/v1/agency/enterprises", s.ws("agency", perms("agency.enterprises.create"), s.createAgencyEnterprise))
	mux.HandleFunc("PATCH /api/v1/agency/enterprises/{id}", s.ws("agency", perms("agency.enterprises.update"), s.updateAgencyEnterprise))

	// Departments
	mux.HandleFunc("GET /api/v1/departments", s.ws(orgWs, perms("agency.departments.view", "enterprise.departments.view"), s.listDepartments))
	mux.HandleFunc("POST /api/v1/departments", s.ws(orgWs, perms("agency.departments.create", "enterprise.departments.create"), s.createDepartment))
	mux.HandleFunc("PATCH /api/v1/departments/{id}", s.ws(orgWs, perms("agency.departments.update", "enterprise.departments.update"), s.updateDepartment))
	mux.HandleFunc("DELETE /api/v1/departments/{id}", s.ws(orgWs, perms("agency.departments.delete", "enterprise.departments.delete"), s.deleteDepartment))

	// Settings
	mux.HandleFunc("GET /api/v1/settings", s.ws(orgWs, perms("agency.settings.view", "enterprise.settings.view"), s.getSettings))
	mux.HandleFunc("PATCH /api/v1/settings", s.ws(orgWs, perms("agency.settings.update", "enterprise.settings.update"), s.updateSettings))
	mux.HandleFunc("GET /api/v1/platform/system-settings", s.ws("platform", perms("platform.settings.view"), s.getPlatformSettings))
	mux.HandleFunc("PATCH /api/v1/platform/system-settings", s.ws("platform", perms("platform.settings.update"), s.updatePlatformSettings))

	// 基础信息 (platform identity) — public read + platform manage.
	mux.HandleFunc("GET /api/v1/public/platform-profile", s.getPublicPlatformProfile)
	mux.HandleFunc("GET /api/v1/platform/platform-profile", s.ws("platform", perms("platform.basic_info.view"), s.getPlatformProfile))
	mux.HandleFunc("PATCH /api/v1/platform/platform-profile", s.ws("platform", perms("platform.basic_info.update"), s.updatePlatformProfile))

	// 通知模板 (notification templates)
	mux.HandleFunc("GET /api/v1/platform/notification-templates", s.ws("platform", perms("platform.notification_templates.view"), s.listNotificationTemplates))
	mux.HandleFunc("PATCH /api/v1/platform/notification-templates/{key}", s.ws("platform", perms("platform.notification_templates.update"), s.updateNotificationTemplate))
	mux.HandleFunc("PATCH /api/v1/platform/notification-templates/{key}/status", s.ws("platform", perms("platform.notification_templates.update"), s.updateNotificationTemplateStatus))
	mux.HandleFunc("POST /api/v1/platform/notification-templates/{key}/reset", s.ws("platform", perms("platform.notification_templates.update"), s.resetNotificationTemplate))

	// App 版本设置 (app version rules) — platform CRUD + public check.
	mux.HandleFunc("GET /api/v1/public/app-version-check", s.publicAppVersionCheck)
	mux.HandleFunc("GET /api/v1/platform/app-version-rules", s.ws("platform", perms("platform.app_version.view"), s.listAppVersionRules))
	mux.HandleFunc("POST /api/v1/platform/app-version-rules", s.ws("platform", perms("platform.app_version.create"), s.createAppVersionRule))
	mux.HandleFunc("PATCH /api/v1/platform/app-version-rules/{id}", s.ws("platform", perms("platform.app_version.update"), s.updateAppVersionRule))
	mux.HandleFunc("DELETE /api/v1/platform/app-version-rules/{id}", s.ws("platform", perms("platform.app_version.delete"), s.deleteAppVersionRule))

	// 对象存储设置 (object storage)
	mux.HandleFunc("GET /api/v1/platform/storage-setting", s.ws("platform", perms("platform.storage.view"), s.getStorageSetting))
	mux.HandleFunc("PATCH /api/v1/platform/storage-setting", s.ws("platform", perms("platform.storage.update"), s.updateStorageSetting))
	mux.HandleFunc("POST /api/v1/platform/storage-setting/rotate-secret", s.ws("platform", perms("platform.storage.update"), s.rotateStorageSecret))
	mux.HandleFunc("POST /api/v1/platform/storage-setting/test", s.ws("platform", perms("platform.storage.test"), s.testStorageSetting))

	// 短信服务 (sms)
	mux.HandleFunc("GET /api/v1/platform/sms/accounts", s.ws("platform", perms("platform.sms.view"), s.listSMSAccounts))
	mux.HandleFunc("POST /api/v1/platform/sms/accounts", s.ws("platform", perms("platform.sms.update"), s.createSMSAccount))
	mux.HandleFunc("PATCH /api/v1/platform/sms/accounts/{id}", s.ws("platform", perms("platform.sms.update"), s.updateSMSAccount))
	mux.HandleFunc("DELETE /api/v1/platform/sms/accounts/{id}", s.ws("platform", perms("platform.sms.update"), s.deleteSMSAccount))
	mux.HandleFunc("GET /api/v1/platform/sms/signatures", s.ws("platform", perms("platform.sms.view"), s.listSMSSignatures))
	mux.HandleFunc("POST /api/v1/platform/sms/signatures", s.ws("platform", perms("platform.sms.update"), s.createSMSSignature))
	mux.HandleFunc("PATCH /api/v1/platform/sms/signatures/{id}", s.ws("platform", perms("platform.sms.update"), s.updateSMSSignature))
	mux.HandleFunc("DELETE /api/v1/platform/sms/signatures/{id}", s.ws("platform", perms("platform.sms.update"), s.deleteSMSSignature))
	mux.HandleFunc("GET /api/v1/platform/sms/templates", s.ws("platform", perms("platform.sms.view"), s.listSMSTemplates))
	mux.HandleFunc("POST /api/v1/platform/sms/templates", s.ws("platform", perms("platform.sms.update"), s.createSMSTemplate))
	mux.HandleFunc("PATCH /api/v1/platform/sms/templates/{id}", s.ws("platform", perms("platform.sms.update"), s.updateSMSTemplate))
	mux.HandleFunc("DELETE /api/v1/platform/sms/templates/{id}", s.ws("platform", perms("platform.sms.update"), s.deleteSMSTemplate))
	mux.HandleFunc("POST /api/v1/platform/sms/templates/{id}/test", s.ws("platform", perms("platform.sms.test"), s.testSMSTemplate))

	// 邮件服务 (email)
	mux.HandleFunc("GET /api/v1/platform/email/accounts", s.ws("platform", perms("platform.email.view"), s.listEmailAccounts))
	mux.HandleFunc("POST /api/v1/platform/email/accounts", s.ws("platform", perms("platform.email.update"), s.createEmailAccount))
	mux.HandleFunc("PATCH /api/v1/platform/email/accounts/{id}", s.ws("platform", perms("platform.email.update"), s.updateEmailAccount))
	mux.HandleFunc("DELETE /api/v1/platform/email/accounts/{id}", s.ws("platform", perms("platform.email.update"), s.deleteEmailAccount))
	mux.HandleFunc("GET /api/v1/platform/email/identities", s.ws("platform", perms("platform.email.view"), s.listEmailIdentities))
	mux.HandleFunc("POST /api/v1/platform/email/identities", s.ws("platform", perms("platform.email.update"), s.createEmailIdentity))
	mux.HandleFunc("PATCH /api/v1/platform/email/identities/{id}", s.ws("platform", perms("platform.email.update"), s.updateEmailIdentity))
	mux.HandleFunc("DELETE /api/v1/platform/email/identities/{id}", s.ws("platform", perms("platform.email.update"), s.deleteEmailIdentity))
	mux.HandleFunc("GET /api/v1/platform/email/templates", s.ws("platform", perms("platform.email.view"), s.listEmailTemplates))
	mux.HandleFunc("POST /api/v1/platform/email/templates", s.ws("platform", perms("platform.email.update"), s.createEmailTemplate))
	mux.HandleFunc("PATCH /api/v1/platform/email/templates/{id}", s.ws("platform", perms("platform.email.update"), s.updateEmailTemplate))
	mux.HandleFunc("DELETE /api/v1/platform/email/templates/{id}", s.ws("platform", perms("platform.email.update"), s.deleteEmailTemplate))
	mux.HandleFunc("POST /api/v1/platform/email/templates/{id}/test", s.ws("platform", perms("platform.email.test"), s.testEmailTemplate))
	mux.HandleFunc("GET /api/v1/dictionaries", s.ws("platform", perms("platform.dictionaries.view"), s.listDictionaries))

	// Workbench summaries
	mux.HandleFunc("GET /api/v1/platform/workbench/summary", s.ws("platform", perms("platform.workbench.view"), s.platformWorkbench))
	mux.HandleFunc("GET /api/v1/agency/workbench/summary", s.ws("agency", perms("agency.workbench.view"), s.agencyWorkbench))
	mux.HandleFunc("GET /api/v1/enterprise/workbench/summary", s.ws("enterprise", perms("enterprise.workbench.view"), s.enterpriseWorkbench))

	// Teams
	mux.HandleFunc("GET /api/v1/teams", s.ws(orgWs, perms("agency.teams.view", "enterprise.teams.view"), s.listTeams))
	mux.HandleFunc("POST /api/v1/teams", s.ws(orgWs, perms("agency.teams.create", "enterprise.teams.create"), s.createTeam))
	mux.HandleFunc("PATCH /api/v1/teams/{id}", s.ws(orgWs, perms("agency.teams.update", "enterprise.teams.update"), s.updateTeam))
	mux.HandleFunc("POST /api/v1/teams/{id}/members", s.ws(orgWs, perms("agency.teams.manage_members", "enterprise.teams.manage_members"), s.setTeamMembers))

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
// allowedTypes is a comma-separated list of acceptable workspace types.
// requiredPerms is an OR set: the caller must hold at least one code in the
// current workspace. An empty set means membership alone suffices.
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
