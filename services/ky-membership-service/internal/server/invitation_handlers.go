package server

import (
	"net/http"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-membership-service/internal/store"
	"github.com/Kysion/KyaiCRM/shared/auth"
)

func (s *Server) listInvitations(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, pageSize := parsePage(r)

	// Data-scope restriction (Phase 1.13c): restricted callers see only
	// invitations created by members within their visible member set.
	scope, err := s.store.ResolveMemberScope(r.Context(), wc.MembershipID, wc.WorkspaceType, wc.WorkspaceID)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "数据范围解析失败")
		return
	}
	var inviterMembershipIDs []string // nil = unrestricted
	if !scope.Unrestricted {
		inviterMembershipIDs, err = s.store.VisibleMembershipIDs(r.Context(), wc.WorkspaceType, wc.WorkspaceID, scope)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "internal_error", "可见成员解析失败")
			return
		}
	}

	items, total, err := s.store.ListInvitations(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.URL.Query().Get("status"), inviterMembershipIDs, page, pageSize)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeList(w, r, items, store.Page{Page: page, PageSize: pageSize, Total: total})
}

type createInvitationInput struct {
	TargetWorkspaceType string   `json:"targetWorkspaceType"`
	TargetWorkspaceID   string   `json:"targetWorkspaceId"`
	InvitationType      string   `json:"invitationType"`
	InviteeEmail        string   `json:"inviteeEmail"`
	InviteePhone        string   `json:"inviteePhone"`
	RoleIDs             []string `json:"roleIds"`
	DepartmentIDs       []string `json:"departmentIds"`
	TeamIDs             []string `json:"teamIds"`
	ExpiresAt           string   `json:"expiresAt"`
}

func (s *Server) createInvitation(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in createInvitationInput
	if !decodeJSON(w, r, &in) {
		return
	}
	in.TargetWorkspaceType = strings.TrimSpace(in.TargetWorkspaceType)
	in.TargetWorkspaceID = strings.TrimSpace(in.TargetWorkspaceID)
	in.InvitationType = strings.TrimSpace(in.InvitationType)
	if in.InvitationType == "" {
		in.InvitationType = "member"
	}
	if strings.TrimSpace(in.InviteeEmail) == "" && strings.TrimSpace(in.InviteePhone) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "inviteeEmail / inviteePhone 至少一个")
		return
	}
	if in.TargetWorkspaceType == "" || in.TargetWorkspaceID == "" {
		// default target = current workspace
		in.TargetWorkspaceType = wc.WorkspaceType
		in.TargetWorkspaceID = wc.WorkspaceID
	}
	if !validStatus(in.InvitationType, "member", "agency_admin", "enterprise_admin") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "invitationType 非法")
		return
	}
	if ok, msg := s.invitationTargetAllowed(r, wc, in); !ok {
		writeError(w, r, http.StatusForbidden, "workspace_forbidden", msg)
		return
	}

	expiresAt := time.Now().Add(7 * 24 * time.Hour)
	if in.ExpiresAt != "" {
		t, err := time.Parse(time.RFC3339, in.ExpiresAt)
		if err != nil {
			writeError(w, r, http.StatusBadRequest, "validation_error", "expiresAt 格式错误")
			return
		}
		expiresAt = t
	}

	inv := store.Invitation{
		ID:             newID("inv"),
		WorkspaceType:  in.TargetWorkspaceType,
		WorkspaceID:    in.TargetWorkspaceID,
		InvitationType: in.InvitationType,
		InviteeEmail:   strPtr(in.InviteeEmail),
		InviteePhone:   strPtr(in.InviteePhone),
		Token:          newID("invtok"),
		PresetRoleIDs:  in.RoleIDs,
		PresetDeptIDs:  in.DepartmentIDs,
		PresetTeamIDs:  in.TeamIDs,
		ExpiresAt:      expiresAt,
	}
	if err := s.store.CreateInvitation(r.Context(), inv, wc.MembershipID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "invitation.created", "invitation", inv.ID, map[string]any{"invitationType": inv.InvitationType, "targetWorkspaceId": inv.WorkspaceID})
	writeData(w, r, map[string]any{
		"id":             inv.ID,
		"token":          inv.Token,
		"workspaceType":  inv.WorkspaceType,
		"workspaceId":    inv.WorkspaceID,
		"invitationType": inv.InvitationType,
		"status":         "pending",
		"expiresAt":      inv.ExpiresAt.Format(time.RFC3339),
	})
}

// invitationTargetAllowed enforces who may invite into which workspace.
func (s *Server) invitationTargetAllowed(r *http.Request, wc wsContext, in createInvitationInput) (bool, string) {
	switch in.InvitationType {
	case "member":
		if in.TargetWorkspaceType != wc.WorkspaceType || in.TargetWorkspaceID != wc.WorkspaceID {
			return false, "普通成员邀请目标必须为当前工作区"
		}
		return true, ""
	case "agency_admin":
		if wc.WorkspaceType != "platform" {
			return false, "仅平台后台可邀请机构管理员"
		}
		if in.TargetWorkspaceType != "agency" {
			return false, "机构管理员邀请目标必须为机构"
		}
		return true, ""
	case "enterprise_admin":
		if in.TargetWorkspaceType != "enterprise" {
			return false, "企业管理员邀请目标必须为企业"
		}
		if wc.WorkspaceType == "platform" {
			return true, ""
		}
		if wc.WorkspaceType == "agency" {
			ok, err := s.store.EnterpriseBelongsToAgency(r.Context(), in.TargetWorkspaceID, wc.WorkspaceID)
			if err != nil || !ok {
				return false, "目标企业不属于当前机构"
			}
			return true, ""
		}
		return false, "当前工作区无权邀请企业管理员"
	}
	return false, "invitationType 非法"
}

func (s *Server) cancelInvitation(w http.ResponseWriter, r *http.Request, wc wsContext) {
	if err := s.store.CancelInvitation(r.Context(), r.PathValue("id"), wc.WorkspaceType, wc.WorkspaceID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "invitation.cancelled", "invitation", r.PathValue("id"), nil)
	writeData(w, r, map[string]any{"id": r.PathValue("id"), "status": "cancelled"})
}

// --- public invitation handlers (no auth) ---

func (s *Server) getPublicInvitation(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeError(w, r, http.StatusServiceUnavailable, "service_unavailable", "数据库未连接")
		return
	}
	inv, err := s.store.GetInvitationByToken(r.Context(), r.PathValue("token"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	// A pending invitation past its expiry is gone, per requirement 5.10.
	if inv.Status == "pending" && !inv.ExpiresAt.After(time.Now()) {
		writeStoreError(w, r, store.ErrGone)
		return
	}
	name, err := s.store.WorkspaceName(r.Context(), inv.WorkspaceType, inv.WorkspaceID)
	if err != nil {
		name = ""
	}
	presetRoles, err := s.store.RolesByIDs(r.Context(), inv.PresetRoleIDs)
	if err != nil {
		presetRoles = []store.RoleRef{}
	}
	writeData(w, r, map[string]any{
		"id":            inv.ID,
		"workspaceType": inv.WorkspaceType,
		"workspaceId":   inv.WorkspaceID,
		"workspaceName": name,
		"inviteeEmail":  inv.InviteeEmail,
		"status":        inv.Status,
		"expiresAt":     inv.ExpiresAt.Format(time.RFC3339),
		"presetRoles":   presetRoles,
	})
}

type acceptInvitationInput struct {
	UserID string `json:"userId"`
}

func (s *Server) acceptPublicInvitation(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeError(w, r, http.StatusServiceUnavailable, "service_unavailable", "数据库未连接")
		return
	}
	if s.cfg.AuthTokenSecret == "" {
		writeError(w, r, http.StatusServiceUnavailable, "service_unavailable", "Token Secret 未配置")
		return
	}
	// Hardened: the accepting user must be authenticated; the accepted userId is
	// always taken from the token, never trusted from the body (Phase 1.12).
	header := r.Header.Get("Authorization")
	if len(header) < 8 || header[:7] != "Bearer " {
		writeError(w, r, http.StatusUnauthorized, "unauthorized", "接受邀请需要登录")
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
	var in acceptInvitationInput
	if !decodeJSON(w, r, &in) {
		return
	}
	in.UserID = strings.TrimSpace(in.UserID)
	if in.UserID != "" && in.UserID != payload.UserID {
		writeError(w, r, http.StatusForbidden, "permission_denied", "只能为当前登录用户接受邀请")
		return
	}
	userID := payload.UserID
	displayName, err := s.store.UserDisplayName(r.Context(), userID)
	if err != nil {
		if err == store.ErrNotFound {
			writeError(w, r, http.StatusBadRequest, "validation_error", "用户不存在")
			return
		}
		writeStoreError(w, r, err)
		return
	}
	res, err := s.store.AcceptInvitation(r.Context(), r.PathValue("token"), userID, displayName, time.Now())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	// The accepting user is the actor; no workspace membership context yet.
	_ = s.store.WriteAudit(r.Context(), store.AuditEntry{
		ActorUserID:   userID,
		WorkspaceType: res.WorkspaceType,
		WorkspaceID:   res.WorkspaceID,
		Action:        "invitation.accepted",
		ResourceType:  "membership",
		ResourceID:    res.MembershipID,
		Result:        "success",
		RequestID:     requestID(r),
		IPAddress:     clientIP(r),
		UserAgent:     r.UserAgent(),
		Source:        "ky-membership-service",
	})
	writeData(w, r, map[string]any{
		"membershipId":  res.MembershipID,
		"workspaceType": res.WorkspaceType,
		"workspaceId":   res.WorkspaceID,
	})
}
