package server

import (
	"net/http"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/store"
)

// --- departments ---

func (s *Server) listDepartments(w http.ResponseWriter, r *http.Request, wc wsContext) {
	q := r.URL.Query()
	scope, err := s.store.ResolveOrgScope(r.Context(), wc.MembershipID, wc.WorkspaceType, wc.WorkspaceID)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "数据范围解析失败")
		return
	}
	items, err := s.store.ListDepartments(r.Context(), wc.WorkspaceType, wc.WorkspaceID, q.Get("parentId"), q.Get("status"), scope)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, items)
}

type departmentInput struct {
	ParentID           string `json:"parentId"`
	Name               string `json:"name"`
	Code               string `json:"code"`
	LeaderMembershipID string `json:"leaderMembershipId"`
	SortOrder          int    `json:"sortOrder"`
	Status             string `json:"status"`
}

func (s *Server) createDepartment(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in departmentInput
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Code = strings.TrimSpace(in.Code)
	if in.Name == "" || in.Code == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "name 和 code 不能为空")
		return
	}
	d := store.Department{
		ID: newID("dep"), WorkspaceType: wc.WorkspaceType, WorkspaceID: wc.WorkspaceID,
		ParentID: strPtr(in.ParentID), Name: in.Name, Code: in.Code,
		LeaderMembershipID: strPtr(in.LeaderMembershipID), SortOrder: in.SortOrder, Status: normalize(in.Status),
	}
	if err := s.store.CreateDepartment(r.Context(), d, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "department.created", "department", d.ID, map[string]any{"code": d.Code})
	writeData(w, r, d)
}

func (s *Server) updateDepartment(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in departmentInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "name 不能为空")
		return
	}
	d := store.Department{
		Name: strings.TrimSpace(in.Name), ParentID: strPtr(in.ParentID),
		LeaderMembershipID: strPtr(in.LeaderMembershipID), SortOrder: in.SortOrder, Status: normalize(in.Status),
	}
	if err := s.store.UpdateDepartment(r.Context(), r.PathValue("id"), wc.WorkspaceType, wc.WorkspaceID, d, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "department.updated", "department", r.PathValue("id"), nil)
	writeData(w, r, map[string]any{"id": r.PathValue("id")})
}

func (s *Server) deleteDepartment(w http.ResponseWriter, r *http.Request, wc wsContext) {
	if err := s.store.DeleteDepartment(r.Context(), r.PathValue("id"), wc.WorkspaceType, wc.WorkspaceID, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "department.deleted", "department", r.PathValue("id"), nil)
	writeData(w, r, map[string]any{"id": r.PathValue("id"), "deleted": true})
}

// --- teams ---

func (s *Server) listTeams(w http.ResponseWriter, r *http.Request, wc wsContext) {
	q := r.URL.Query()
	scope, err := s.store.ResolveOrgScope(r.Context(), wc.MembershipID, wc.WorkspaceType, wc.WorkspaceID)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "数据范围解析失败")
		return
	}
	items, err := s.store.ListTeams(r.Context(), wc.WorkspaceType, wc.WorkspaceID, q.Get("departmentId"), q.Get("status"), scope)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, items)
}

type teamInput struct {
	Name               string `json:"name"`
	Code               string `json:"code"`
	DepartmentID       string `json:"departmentId"`
	LeaderMembershipID string `json:"leaderMembershipId"`
	Description        string `json:"description"`
	Status             string `json:"status"`
}

func (s *Server) createTeam(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in teamInput
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Code = strings.TrimSpace(in.Code)
	if in.Name == "" || in.Code == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "name 和 code 不能为空")
		return
	}
	t := store.Team{
		ID: newID("team"), WorkspaceType: wc.WorkspaceType, WorkspaceID: wc.WorkspaceID,
		DepartmentID: strPtr(in.DepartmentID), Name: in.Name, Code: in.Code,
		LeaderMembershipID: strPtr(in.LeaderMembershipID), Description: in.Description, Status: normalize(in.Status),
	}
	if err := s.store.CreateTeam(r.Context(), t, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "team.created", "team", t.ID, map[string]any{"code": t.Code})
	writeData(w, r, t)
}

func (s *Server) updateTeam(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in teamInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "name 不能为空")
		return
	}
	t := store.Team{
		Name: strings.TrimSpace(in.Name), DepartmentID: strPtr(in.DepartmentID),
		LeaderMembershipID: strPtr(in.LeaderMembershipID), Description: in.Description, Status: normalize(in.Status),
	}
	if err := s.store.UpdateTeam(r.Context(), r.PathValue("id"), wc.WorkspaceType, wc.WorkspaceID, t, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "team.updated", "team", r.PathValue("id"), nil)
	writeData(w, r, map[string]any{"id": r.PathValue("id")})
}

type teamMembersInput struct {
	MembershipIDs []string `json:"membershipIds"`
}

func (s *Server) setTeamMembers(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in teamMembersInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if err := s.store.SetTeamMembers(r.Context(), r.PathValue("id"), wc.WorkspaceType, wc.WorkspaceID, in.MembershipIDs); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "team.members_set", "team", r.PathValue("id"), map[string]any{"count": len(in.MembershipIDs)})
	writeData(w, r, map[string]any{"id": r.PathValue("id"), "memberCount": len(in.MembershipIDs)})
}

func normalize(status string) string {
	if status == "" {
		return "normal"
	}
	return status
}
