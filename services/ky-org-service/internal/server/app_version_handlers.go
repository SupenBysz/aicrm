package server

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/store"
)

func (s *Server) listAppVersionRules(w http.ResponseWriter, r *http.Request, wc wsContext) {
	items, err := s.store.ListAppVersionRules(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{"items": items})
}

type appVersionRuleInput struct {
	Platform                string `json:"platform"`
	Channel                 string `json:"channel"`
	LatestVersionCode       int    `json:"latestVersionCode"`
	LatestVersionName       string `json:"latestVersionName"`
	MinSupportedVersionCode int    `json:"minSupportedVersionCode"`
	ForceUpdate             bool   `json:"forceUpdate"`
	UpdateTitle             string `json:"updateTitle"`
	UpdateNotes             string `json:"updateNotes"`
	UpdateURL               string `json:"updateUrl"`
	Enabled                 *bool  `json:"enabled"`
	InternalRemark          string `json:"internalRemark"`
}

func (in appVersionRuleInput) toRule(id string) store.AppVersionRule {
	channel := strings.TrimSpace(in.Channel)
	if channel == "" {
		channel = "default"
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	return store.AppVersionRule{
		ID: id, Platform: in.Platform, Channel: channel,
		LatestVersionCode: in.LatestVersionCode, LatestVersionName: strings.TrimSpace(in.LatestVersionName),
		MinSupportedVersionCode: in.MinSupportedVersionCode, ForceUpdate: in.ForceUpdate,
		UpdateTitle: in.UpdateTitle, UpdateNotes: in.UpdateNotes, UpdateURL: strings.TrimSpace(in.UpdateURL),
		Enabled: enabled, InternalRemark: in.InternalRemark,
	}
}

func (s *Server) createAppVersionRule(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in appVersionRuleInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.Platform != "ios" && in.Platform != "android" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "platform 必须为 ios 或 android")
		return
	}
	id, err := s.store.CreateAppVersionRule(r.Context(), in.toRule(""), wc.UserID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "app_version_rule.created", "app_version_rule", id, map[string]any{"platform": in.Platform})
	created, err := s.store.GetAppVersionRule(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, created)
}

func (s *Server) updateAppVersionRule(w http.ResponseWriter, r *http.Request, wc wsContext) {
	id := r.PathValue("id")
	var in appVersionRuleInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if err := s.store.UpdateAppVersionRule(r.Context(), in.toRule(id), wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "app_version_rule.updated", "app_version_rule", id, nil)
	updated, err := s.store.GetAppVersionRule(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, updated)
}

func (s *Server) deleteAppVersionRule(w http.ResponseWriter, r *http.Request, wc wsContext) {
	id := r.PathValue("id")
	if err := s.store.DeleteAppVersionRule(r.Context(), id); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "app_version_rule.deleted", "app_version_rule", id, nil)
	writeData(w, r, map[string]any{"id": id, "deleted": true})
}

// publicAppVersionCheck serves GET /api/v1/public/app-version-check (no auth).
func (s *Server) publicAppVersionCheck(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeError(w, r, http.StatusServiceUnavailable, "service_unavailable", "数据库未连接")
		return
	}
	q := r.URL.Query()
	platform := q.Get("platform")
	if platform != "ios" && platform != "android" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "platform 必须为 ios 或 android")
		return
	}
	versionCode, _ := strconv.Atoi(q.Get("versionCode"))
	rule, err := s.store.GetEnabledAppVersionRule(r.Context(), platform, q.Get("channel"))
	if err == store.ErrNotFound {
		writeData(w, r, map[string]any{"hasUpdate": false, "platform": platform, "channel": q.Get("channel")})
		return
	}
	if err != nil {
		writeStoreError(w, r, err)
		return
	}

	hasUpdate := versionCode < rule.LatestVersionCode
	forceUpdate := rule.ForceUpdate || versionCode < rule.MinSupportedVersionCode
	// Stateless once-per-day reminder: client reports lastPromptedDate (YYYY-MM-DD).
	canRemindToday := !forceUpdate && q.Get("lastPromptedDate") != time.Now().Format("2006-01-02")

	writeData(w, r, map[string]any{
		"hasUpdate":               hasUpdate,
		"forceUpdate":             forceUpdate,
		"canRemindToday":          canRemindToday,
		"platform":                rule.Platform,
		"channel":                 rule.Channel,
		"latestVersionCode":       rule.LatestVersionCode,
		"latestVersionName":       rule.LatestVersionName,
		"minSupportedVersionCode": rule.MinSupportedVersionCode,
		"updateTitle":             rule.UpdateTitle,
		"updateNotes":             rule.UpdateNotes,
		"updateUrl":               rule.UpdateURL,
	})
}
