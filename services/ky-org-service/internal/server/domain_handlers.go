package server

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/domains"
	"github.com/Kysion/KyaiCRM/shared/domainentry"
	"github.com/jackc/pgx/v5/pgconn"
	"io"
	"net/http"
	"os"
	"strings"
)

func (s *Server) domainRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/v1/platform/agencies/domain-summaries", s.ws("platform", []string{"platform.agency_domains.view"}, s.domainSummaries))
	m.HandleFunc("POST /internal/v1/domains/workspace-scope", s.domainWorkspaceScope)
	m.HandleFunc("GET /api/v1/platform/agencies/{id}/domains", s.ws("platform", []string{"platform.agency_domains.view"}, s.domainList))
	m.HandleFunc("GET /api/v1/platform/agencies/{id}/domains/{binding}", s.ws("platform", []string{"platform.agency_domains.view"}, s.domainGet))
	m.HandleFunc("POST /api/v1/platform/agencies/{id}/domains", s.ws("platform", []string{"platform.agency_domains.manage"}, s.domainCommand))
	m.HandleFunc("POST /api/v1/platform/agencies/{id}/domains/{binding}/{action}", s.ws("platform", nil, s.domainCommand))
	m.HandleFunc("POST /internal/v1/domains/resolve", s.domainResolve)
	m.HandleFunc("POST /internal/v1/domains/worker/{action}", s.domainWorker)
}
func strictDomain(w http.ResponseWriter, r *http.Request, out any) bool {
	raw, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 16384))
	if e != nil || !bytes.HasPrefix(bytes.TrimSpace(raw), []byte("{")) {
		writeError(w, r, 400, "validation_error", "请求格式不正确")
		return false
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(out) != nil || d.Decode(new(any)) != io.EOF {
		writeError(w, r, 400, "validation_error", "请求格式不正确")
		return false
	}
	return true
}
func (s *Server) domainError(w http.ResponseWriter, r *http.Request, e error) {
	var pg *pgconn.PgError
	if errors.As(e, &pg) && (pg.Code == "23505" || pg.Code == "40001") {
		e = domains.ErrConflict
	}
	if errors.Is(e, domains.ErrThrottled) {
		w.Header().Set("Retry-After", "15")
		writeError(w, r, 429, "rate_limited", "检测过于频繁，请15秒后重试")
		return
	}
	code, msg := 503, "域名服务暂时不可用，请保留配置重试"
	if errors.Is(e, domains.ErrInvalid) {
		code, msg = 400, "请检查域名格式、接入方式及必选项"
	}
	if errors.Is(e, domains.ErrReserved) {
		code, msg = 400, "该域名属于平台保留入口，请使用其他子域名"
	}
	if errors.Is(e, domains.ErrConflict) {
		code, msg = 409, "域名、任务或版本已变化，请刷新后重试"
	}
	if errors.Is(e, domains.ErrNotFound) {
		code, msg = 404, "域名记录不存在或不可访问"
	}
	writeError(w, r, code, "domain_operation_failed", msg)
}
func (s *Server) domainList(w http.ResponseWriter, r *http.Request, wc wsContext) {
	if !s.domainScope(w, r, wc, "platform.agency_domains.view") {
		return
	}
	items, e := s.store.Domains().List(r.Context(), r.PathValue("id"))
	if e != nil {
		s.domainError(w, r, e)
		return
	}
	writeData(w, r, map[string]any{"items": items, "mode": "managed", "ipEnabled": false, "managedEnabled": os.Getenv("KY_DOMAIN_MANAGED_ENABLED") == "1", "automationReady": (os.Getenv("KY_DOMAIN_AUTOMATION_READY") == "1" && os.Getenv("KY_DOMAIN_ORIGIN_ISOLATED") == "1")})
}
func (s *Server) domainGet(w http.ResponseWriter, r *http.Request, wc wsContext) {
	if !s.domainScope(w, r, wc, "platform.agency_domains.view") {
		return
	}
	b, e := s.store.Domains().Get(r.Context(), r.PathValue("id"), r.PathValue("binding"))
	if e != nil {
		s.domainError(w, r, e)
		return
	}
	writeData(w, r, b)
}
func (s *Server) domainCommand(w http.ResponseWriter, r *http.Request, wc wsContext) {
	action := r.PathValue("action")
	if action == "" {
		action = "create"
	}
	permission := "platform.agency_domains.manage"
	if action == "activate" || action == "suspend" || action == "resume" || action == "detach" {
		permission = "platform.agency_domains.activate"
	}
	if !s.domainScope(w, r, wc, permission) {
		return
	}
	allowed, e := s.store.HasAny(r.Context(), wc.MembershipID, []string{permission})
	if e != nil || !allowed {
		writeError(w, r, 403, "permission_denied", "无域名操作权限")
		return
	}
	var in domains.Input
	if !strictDomain(w, r, &in) {
		return
	}
	in.RequestID = r.Header.Get("X-KY-Request-Id")
	if in.RequestID == "" {
		in.RequestID = newID("req")
	}
	if action == "create" {
		in.Hostname, e = domains.Normalize(in.Hostname, strings.Split(os.Getenv("KY_DOMAIN_RESERVED_ROOTS"), ","), strings.Split(os.Getenv("KY_DOMAIN_PLATFORM_HOSTS")+","+os.Getenv("KY_DOMAIN_RESERVED_HOSTS"), ","))
		if e != nil {
			s.domainError(w, r, e)
			return
		}
		if in.Mode != "managed" || os.Getenv("KY_DOMAIN_MANAGED_ENABLED") != "1" {
			s.domainError(w, r, domains.ErrInvalid)
			return
		}
	}
	// Real admission cannot be enabled until all server gates and the route probe are operational.
	if (action == "activate" || action == "resume") && (os.Getenv("KY_DOMAIN_AUTOMATION_READY") != "1" || os.Getenv("KY_DOMAIN_ORIGIN_ISOLATED") != "1") {
		writeError(w, r, 503, "domain_setup_required", "入口安全配置尚未就绪，暂不能启用")
		return
	}
	b, e := s.store.Domains().Command(r.Context(), wc.UserID, wc.WorkspaceID, r.PathValue("id"), r.PathValue("binding"), action, r.Header.Get("Idempotency-Key"), in)
	if e != nil {
		s.domainError(w, r, e)
		return
	}
	writeData(w, r, b)
}
func (s *Server) domainResolve(w http.ResponseWriter, r *http.Request) {
	if !domainentry.Internal(r, s.cfg.InternalServiceToken) && !(len(os.Getenv("KY_DOMAIN_GATEWAY_TOKEN")) >= 32 && domainentry.Internal(r, os.Getenv("KY_DOMAIN_GATEWAY_TOKEN"))) {
		writeError(w, r, 401, "unauthorized", "内部认证失败")
		return
	}
	if s.store == nil {
		writeError(w, r, 503, "unavailable", "域名服务不可用")
		return
	}
	var in struct {
		Host  string `json:"host"`
		Probe bool   `json:"probe"`
	}
	if !strictDomain(w, r, &in) {
		return
	}
	b, e := s.store.Domains().Resolve(r.Context(), in.Host)
	if in.Probe { // Probe lookup is available only to a separately authenticated gateway, not public clients.
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-KY-Domain-Probe")), []byte(os.Getenv("KY_DOMAIN_PROBE_SECRET"))) != 1 || len(os.Getenv("KY_DOMAIN_PROBE_SECRET")) < 32 {
			writeError(w, r, 403, "forbidden", "探测不可用")
			return
		}
		listErr := e
		b, listErr = s.store.Domains().ProbeBinding(r.Context(), in.Host)
		e = listErr
	}
	if e != nil {
		s.domainError(w, r, e)
		return
	}
	writeData(w, r, domainentry.Entry{Host: b.Hostname, BindingID: b.ID, AgencyID: b.AgencyID, Generation: b.Generation})
}
func (s *Server) domainWorker(w http.ResponseWriter, r *http.Request) {
	token := os.Getenv("KY_DOMAIN_WORKER_TOKEN")
	if len(token) < 32 || !domainentry.Internal(r, token) {
		writeError(w, r, 401, "unauthorized", "工作进程认证失败")
		return
	}
	if s.store == nil {
		writeError(w, r, 503, "unavailable", "域名服务未就绪")
		return
	}
	if r.PathValue("action") == "claim" {
		work, e := s.store.Domains().Claim(r.Context())
		if e != nil {
			s.domainError(w, r, e)
			return
		}
		work.Ready = (os.Getenv("KY_DOMAIN_AUTOMATION_READY") == "1" && os.Getenv("KY_DOMAIN_ORIGIN_ISOLATED") == "1")
		var access struct {
			Allowed bool `json:"allowed"`
		}
		if work.Binding.State != "detaching" && work.Binding.State != "detached" {
			err := domainentry.Call(r.Context(), s.cfg.MembershipURL, s.cfg.InternalServiceToken, "/internal/v1/domains/operator-access", map[string]string{"actorId": work.Binding.ActorID, "workspaceId": work.Binding.WorkspaceID, "agencyId": work.Binding.AgencyID, "permission": "platform.agency_domains.manage"}, &access)
			work.Ready = work.Ready && err == nil && access.Allowed
		}

		writeData(w, r, work)
		return
	}
	if r.PathValue("action") != "complete" {
		writeError(w, r, 404, "not_found", "操作不存在")
		return
	}
	var in struct {
		Work        domains.Work        `json:"work"`
		Observation domains.Observation `json:"observation"`
	}
	if !strictDomain(w, r, &in) {
		return
	}
	// Reload the immutable actor identity from Org, never trust the worker's copy for authorization.
	b, e := s.store.Domains().Get(r.Context(), in.Work.Binding.AgencyID, in.Work.Binding.ID)
	if e != nil {
		s.domainError(w, r, e)
		return
	}
	var auth struct {
		Allowed bool `json:"allowed"`
	}
	e = domainentry.Call(r.Context(), s.cfg.MembershipURL, s.cfg.InternalServiceToken, "/internal/v1/domains/operator-access", map[string]string{"actorId": b.ActorID, "workspaceId": b.WorkspaceID, "agencyId": b.AgencyID, "permission": "platform.agency_domains.manage"}, &auth)
	authorized := e == nil && auth.Allowed && (os.Getenv("KY_DOMAIN_AUTOMATION_READY") == "1" && os.Getenv("KY_DOMAIN_ORIGIN_ISOLATED") == "1")
	if authorized {
		auth.Allowed = false
		e = domainentry.Call(r.Context(), s.cfg.MembershipURL, s.cfg.InternalServiceToken, "/internal/v1/domains/operator-access", map[string]string{"actorId": b.ActorID, "workspaceId": b.WorkspaceID, "agencyId": b.AgencyID, "permission": "platform.agency_domains.activate"}, &auth)
		authorized = e == nil && auth.Allowed
	}
	if e = s.store.Domains().Complete(r.Context(), in.Work, in.Observation, authorized); e != nil {
		s.domainError(w, r, e)
		return
	}
	writeData(w, r, map[string]bool{"saved": true})
}
func (s *Server) domainWorkspaceScope(w http.ResponseWriter, r *http.Request) {
	if !domainentry.Internal(r, s.cfg.InternalServiceToken) {
		writeError(w, r, 401, "unauthorized", "内部认证失败")
		return
	}
	var in struct {
		AgencyID   string              `json:"agencyId"`
		Workspaces []domains.Workspace `json:"workspaces"`
	}
	if !strictDomain(w, r, &in) {
		return
	}
	if s.store == nil || len(in.Workspaces) > 500 {
		writeError(w, r, 503, "unavailable", "归属不可确认")
		return
	}
	refs, e := s.store.Domains().AllowedWorkspaces(r.Context(), in.AgencyID, in.Workspaces)
	if e != nil {
		s.domainError(w, r, e)
		return
	}
	writeData(w, r, map[string]any{"allowed": len(refs) > 0, "workspaces": refs})
}

func (s *Server) domainScope(w http.ResponseWriter, r *http.Request, wc wsContext, permission string) bool {
	var out struct {
		Allowed bool `json:"allowed"`
	}
	err := domainentry.Call(r.Context(), s.cfg.MembershipURL, s.cfg.InternalServiceToken, "/internal/v1/domains/operator-access", map[string]string{"actorId": wc.UserID, "workspaceId": wc.WorkspaceID, "agencyId": r.PathValue("id"), "permission": permission}, &out)
	if err != nil {
		writeError(w, r, 503, "scope_unavailable", "权限服务暂不可用，请重试")
		return false
	}
	if !out.Allowed {
		writeError(w, r, 403, "permission_denied", "无当前机构域名权限")
		return false
	}
	return true
}

func (s *Server) domainSummaries(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in struct {
		IDs []string `json:"ids"`
	}
	if !strictDomain(w, r, &in) {
		return
	}
	if len(in.IDs) > 100 {
		writeError(w, r, 400, "validation_error", "每次最多100个机构")
		return
	}
	var out struct {
		IDs []string `json:"ids"`
	}
	if e := domainentry.Call(r.Context(), s.cfg.MembershipURL, s.cfg.InternalServiceToken, "/internal/v1/domains/operator-access", map[string]any{"actorId": wc.UserID, "workspaceId": wc.WorkspaceID, "agencyIds": in.IDs, "permission": "platform.agency_domains.view"}, &out); e != nil {
		writeError(w, r, 503, "unavailable", "范围查询暂时不可用")
		return
	}
	result, e := s.store.Domains().Summaries(r.Context(), out.IDs)
	if e != nil {
		s.domainError(w, r, e)
		return
	}
	writeData(w, r, result)
}
