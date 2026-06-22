package server

import (
	"net/http"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-membership-service/internal/store"
)

func (s *Server) listMembers(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, pageSize := parsePage(r)
	q := r.URL.Query()
	scope, err := s.store.ResolveMemberScope(r.Context(), wc.MembershipID, wc.WorkspaceType, wc.WorkspaceID)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "数据范围解析失败")
		return
	}
	items, total, err := s.store.ListMembers(r.Context(), wc.WorkspaceType, wc.WorkspaceID,
		strings.TrimSpace(q.Get("keyword")), q.Get("departmentId"), q.Get("teamId"), q.Get("status"), scope, page, pageSize)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeList(w, r, items, store.Page{Page: page, PageSize: pageSize, Total: total})
}

func (s *Server) getMember(w http.ResponseWriter, r *http.Request, wc wsContext) {
	scope, err := s.store.ResolveMemberScope(r.Context(), wc.MembershipID, wc.WorkspaceType, wc.WorkspaceID)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "数据范围解析失败")
		return
	}
	m, err := s.store.GetMember(r.Context(), r.PathValue("id"), wc.WorkspaceType, wc.WorkspaceID, scope)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, m)
}

// listOrgMembers lists members of a specific organization (agency/enterprise),
// used by the platform backend to view an org's members (unrestricted scope).
func (s *Server) listOrgMembers(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, pageSize := parsePage(r)
	wsType := r.PathValue("workspaceType")
	wsID := r.PathValue("workspaceId")
	items, total, err := s.store.ListMembers(r.Context(), wsType, wsID, "", "", "", "", store.ScopeFilter{Unrestricted: true}, page, pageSize)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeList(w, r, items, store.Page{Page: page, PageSize: pageSize, Total: total})
}

type memberStatusInput struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}

func (s *Server) updateMemberStatus(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in memberStatusInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if !validStatus(in.Status, "active", "disabled", "left") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "status 非法")
		return
	}
	if err := s.store.UpdateMemberStatus(r.Context(), r.PathValue("id"), wc.WorkspaceType, wc.WorkspaceID, in.Status, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "member.status_changed", "membership", r.PathValue("id"), map[string]any{"status": in.Status})
	s.notifyMember(r.Context(), wc, r.PathValue("id"), "成员状态变更", "您在『{ws}』的成员状态已变更为："+in.Status, "security")
	writeData(w, r, map[string]any{"id": r.PathValue("id"), "status": in.Status})
}

func (s *Server) removeMember(w http.ResponseWriter, r *http.Request, wc wsContext) {
	if r.PathValue("id") == wc.MembershipID {
		writeError(w, r, http.StatusConflict, "conflict", "不能移除当前登录身份")
		return
	}
	if err := s.store.RemoveMember(r.Context(), r.PathValue("id"), wc.WorkspaceType, wc.WorkspaceID, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "member.removed", "membership", r.PathValue("id"), nil)
	s.notifyMember(r.Context(), wc, r.PathValue("id"), "成员移除", "您已被移出『{ws}』", "organization")
	writeData(w, r, map[string]any{"id": r.PathValue("id"), "removed": true})
}

type assignDepartmentsInput struct {
	Departments []store.DepartmentAssignment `json:"departments"`
}

func (s *Server) assignMemberDepartments(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in assignDepartmentsInput
	if !decodeJSON(w, r, &in) {
		return
	}
	primaries := 0
	for _, d := range in.Departments {
		if strings.TrimSpace(d.DepartmentID) == "" {
			writeError(w, r, http.StatusBadRequest, "validation_error", "departmentId 不能为空")
			return
		}
		if d.IsPrimary {
			primaries++
		}
	}
	if primaries > 1 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "至多一个主部门")
		return
	}
	if err := s.store.AssignMemberDepartments(r.Context(), r.PathValue("id"), wc.WorkspaceType, wc.WorkspaceID, in.Departments); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "member.departments_assigned", "membership", r.PathValue("id"), map[string]any{"count": len(in.Departments)})
	s.notifyMember(r.Context(), wc, r.PathValue("id"), "部门调整", "您在『{ws}』的部门归属已更新", "organization")
	writeData(w, r, map[string]any{"id": r.PathValue("id"), "departmentCount": len(in.Departments)})
}

type assignTeamsInput struct {
	TeamIDs []string `json:"teamIds"`
}

func (s *Server) assignMemberTeams(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in assignTeamsInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if err := s.store.AssignMemberTeams(r.Context(), r.PathValue("id"), wc.WorkspaceType, wc.WorkspaceID, in.TeamIDs); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "member.teams_assigned", "membership", r.PathValue("id"), map[string]any{"count": len(in.TeamIDs)})
	s.notifyMember(r.Context(), wc, r.PathValue("id"), "团队调整", "您在『{ws}』的团队归属已更新", "organization")
	writeData(w, r, map[string]any{"id": r.PathValue("id"), "teamCount": len(in.TeamIDs)})
}
