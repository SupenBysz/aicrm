package server

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-membership-service/internal/store"
)

var (
	internalRequestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
	opaqueReferencePattern   = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,160}$`)
	permissionCodePattern    = regexp.MustCompile(`^[a-z][a-z0-9_.]{2,159}$`)
)

type accessDecisionAssuranceInput struct {
	RequireWorkspaceOwner       bool `json:"requireWorkspaceOwner"`
	MaxAuthenticationAgeSeconds int  `json:"maxAuthenticationAgeSeconds"`
	RequireMFAIfEnabled         bool `json:"requireMfaIfEnabled"`
}

type accessDecisionInput struct {
	ActorID                string                        `json:"actorId"`
	SessionID              string                        `json:"sessionId"`
	WorkspaceType          string                        `json:"workspaceType"`
	WorkspaceID            string                        `json:"workspaceId"`
	RequiredAllPermissions []string                      `json:"requiredAllPermissions"`
	RequiredAnyPermissions []string                      `json:"requiredAnyPermissions"`
	Assurance              *accessDecisionAssuranceInput `json:"assurance,omitempty"`
}

func (s *Server) internalAccessDecision(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	requestID := strings.TrimSpace(r.Header.Get("X-KY-Request-Id"))
	if s.cfg.InternalToken == "" {
		writeError(w, r, http.StatusServiceUnavailable, "internal_auth_unavailable", "内部认证未配置")
		return
	}
	actualToken := r.Header.Get("X-KY-Internal-Token")
	if len(actualToken) != len(s.cfg.InternalToken) || subtle.ConstantTimeCompare([]byte(actualToken), []byte(s.cfg.InternalToken)) != 1 {
		writeError(w, r, http.StatusUnauthorized, "internal_unauthorized", "内部认证失败")
		return
	}
	if !internalRequestIDPattern.MatchString(requestID) {
		writeError(w, r, http.StatusBadRequest, "request_id_required", "X-KY-Request-Id 必填")
		return
	}
	if r.Header.Get("Authorization") != "" || r.Header.Get("X-KY-Workspace-Type") != "" || r.Header.Get("X-KY-Workspace-Id") != "" {
		writeError(w, r, http.StatusBadRequest, "internal_header_forbidden", "内部接口禁止用户认证与工作区覆盖 Header")
		return
	}
	var input accessDecisionInput
	r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		writeError(w, r, http.StatusBadRequest, "validation_error", "请求 JSON 无效")
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, r, http.StatusBadRequest, "validation_error", "请求只能包含一个 JSON 对象")
		return
	}
	if !validAccessDecisionInput(input) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "权限决策参数无效")
		return
	}
	if s.store == nil {
		writeError(w, r, http.StatusServiceUnavailable, "service_unavailable", "权限决策存储不可用")
		return
	}

	request := store.AccessDecisionRequest{
		ActorID: input.ActorID, SessionID: input.SessionID,
		WorkspaceType: input.WorkspaceType, WorkspaceID: input.WorkspaceID,
		RequiredAllPermissions: input.RequiredAllPermissions,
		RequiredAnyPermissions: input.RequiredAnyPermissions,
	}
	if input.Assurance != nil {
		request.Assurance = &store.AccessAssuranceRequirements{
			RequireWorkspaceOwner:       input.Assurance.RequireWorkspaceOwner,
			MaxAuthenticationAgeSeconds: input.Assurance.MaxAuthenticationAgeSeconds,
			RequireMFAIfEnabled:         input.Assurance.RequireMFAIfEnabled,
		}
	}
	decision, err := s.store.EvaluateAccessDecision(r.Context(), request)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "access_decision_failed", "权限决策失败")
		return
	}
	writeData(w, r, decision)
}

func validAccessDecisionInput(input accessDecisionInput) bool {
	if !opaqueReferencePattern.MatchString(input.ActorID) ||
		!opaqueReferencePattern.MatchString(input.SessionID) ||
		!opaqueReferencePattern.MatchString(input.WorkspaceID) ||
		(input.WorkspaceType != "platform" && input.WorkspaceType != "agency" && input.WorkspaceType != "enterprise") ||
		len(input.RequiredAllPermissions) > 64 || len(input.RequiredAnyPermissions) > 64 {
		return false
	}
	if input.Assurance != nil {
		if input.Assurance.MaxAuthenticationAgeSeconds < 0 || input.Assurance.MaxAuthenticationAgeSeconds > 86400 ||
			(!input.Assurance.RequireWorkspaceOwner && input.Assurance.MaxAuthenticationAgeSeconds == 0 && !input.Assurance.RequireMFAIfEnabled) {
			return false
		}
	}
	seen := make(map[string]struct{}, len(input.RequiredAllPermissions)+len(input.RequiredAnyPermissions))
	for _, permissions := range [][]string{input.RequiredAllPermissions, input.RequiredAnyPermissions} {
		for _, code := range permissions {
			if !permissionCodePattern.MatchString(code) {
				return false
			}
			if _, exists := seen[code]; exists {
				return false
			}
			seen[code] = struct{}{}
		}
	}
	return true
}
