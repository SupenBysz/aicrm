package server

import (
	"net/http"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-membership-service/internal/store"
)

func platformRootIfPlatform(wc wsContext) string {
	return wc.WorkspaceID
}

// --- roles ---

func (s *Server) listRoles(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, pageSize := parsePage(r)
	items, total, err := s.store.ListRoles(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.URL.Query().Get("status"), page, pageSize)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeList(w, r, items, store.Page{Page: page, PageSize: pageSize, Total: total})
}

type roleInput struct {
	Name          string          `json:"name"`
	Code          string          `json:"code"`
	Description   string          `json:"description"`
	PermissionIDs []string        `json:"permissionIds"`
	DataScope     *dataScopeInput `json:"dataScope"`
}

type dataScopeInput struct {
	ScopeType     string   `json:"scopeType"`
	DepartmentIDs []string `json:"departmentIds"`
	TeamIDs       []string `json:"teamIds"`
	AgencyIDs     []string `json:"agencyIds"`
	EnterpriseIDs []string `json:"enterpriseIds"`
}

var validScopeTypes = map[string]bool{
	"all": true, "current_agency": true, "current_enterprise": true,
	"specified_agency": true, "specified_enterprise": true,
	"department": true, "department_tree": true, "specified_department": true,
	"team": true, "specified_team": true, "self": true, "custom": true,
}

// validateDataScope checks scopeType validity and required-id combinations.
func validateDataScope(in *dataScopeInput) (store.DataScope, bool, string) {
	if in == nil {
		return store.DataScope{}, true, ""
	}
	if !validScopeTypes[in.ScopeType] {
		return store.DataScope{}, false, "scopeType 非法"
	}
	ds := store.DataScope{
		ScopeType: in.ScopeType, DepartmentIDs: in.DepartmentIDs, TeamIDs: in.TeamIDs,
		AgencyIDs: in.AgencyIDs, EnterpriseIDs: in.EnterpriseIDs,
	}
	switch in.ScopeType {
	case "specified_agency":
		if len(in.AgencyIDs) == 0 {
			return ds, false, "specified_agency 需要 agencyIds"
		}
	case "specified_enterprise":
		if len(in.EnterpriseIDs) == 0 {
			return ds, false, "specified_enterprise 需要 enterpriseIds"
		}
	case "specified_department":
		if len(in.DepartmentIDs) == 0 {
			return ds, false, "specified_department 需要 departmentIds"
		}
	case "specified_team":
		if len(in.TeamIDs) == 0 {
			return ds, false, "specified_team 需要 teamIds"
		}
	case "custom":
		if len(in.DepartmentIDs)+len(in.TeamIDs)+len(in.AgencyIDs)+len(in.EnterpriseIDs) == 0 {
			return ds, false, "custom 需要至少一个 ID 列表"
		}
	}
	return ds, true, ""
}

func (s *Server) createRole(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in roleInput
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Code = strings.TrimSpace(in.Code)
	if in.Name == "" || in.Code == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "name 和 code 不能为空")
		return
	}
	ds, ok, msg := validateDataScope(in.DataScope)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", msg)
		return
	}
	if len(in.PermissionIDs) > 0 {
		belong, err := s.store.PermissionsAllBelongToWorkspaceType(r.Context(), in.PermissionIDs, wc.WorkspaceType)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "internal_error", "权限校验失败")
			return
		}
		if !belong {
			writeError(w, r, http.StatusBadRequest, "validation_error", "permissionIds 含非当前工作区类型权限")
			return
		}
	}
	wsID := platformRootIfPlatform(wc)
	role := store.Role{ID: newID("role"), WorkspaceType: wc.WorkspaceType, WorkspaceID: &wsID, Name: in.Name, Code: in.Code, Description: in.Description}
	var dsPtr *store.DataScope
	if in.DataScope != nil {
		dsPtr = &ds
	}
	id, err := s.store.CreateRole(r.Context(), role, dsPtr, in.PermissionIDs, wc.UserID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "role.created", "role", id, map[string]any{"code": in.Code})
	created, err := s.store.GetRole(r.Context(), id, wc.WorkspaceType, wc.WorkspaceID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, created)
}

func (s *Server) updateRole(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in roleInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "name 不能为空")
		return
	}
	ds, ok, msg := validateDataScope(in.DataScope)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", msg)
		return
	}
	var dsPtr *store.DataScope
	if in.DataScope != nil {
		dsPtr = &ds
	}
	if err := s.store.UpdateRole(r.Context(), r.PathValue("id"), wc.WorkspaceType, wc.WorkspaceID, strings.TrimSpace(in.Name), in.Description, dsPtr, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "role.updated", "role", r.PathValue("id"), nil)
	updated, err := s.store.GetRole(r.Context(), r.PathValue("id"), wc.WorkspaceType, wc.WorkspaceID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, updated)
}

type roleStatusInput struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}

func (s *Server) updateRoleStatus(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in roleStatusInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if !validStatus(in.Status, "normal", "disabled") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "status 非法")
		return
	}
	if err := s.store.UpdateRoleStatus(r.Context(), r.PathValue("id"), wc.WorkspaceType, wc.WorkspaceID, in.Status, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "role.status_changed", "role", r.PathValue("id"), map[string]any{"status": in.Status})
	// Disabling a role strips its permissions from all holders (the resolver
	// filters r.status='normal'); re-enabling restores them. Either way the
	// holders' effective permissions change, so fan out like permissions_updated.
	if userIDs, err := s.store.UserIDsByRole(r.Context(), r.PathValue("id")); err == nil {
		content := "您在『{ws}』的角色已恢复启用，相关权限已生效"
		if in.Status == "disabled" {
			content = "您在『{ws}』的角色已被停用，相关权限已收回"
		}
		s.notifyUsers(r.Context(), wc, userIDs, "权限变更", content, "permission")
	}
	writeData(w, r, map[string]any{"id": r.PathValue("id"), "status": in.Status})
}

type rolePermissionsInput struct {
	PermissionIDs []string `json:"permissionIds"`
}

func (s *Server) setRolePermissions(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in rolePermissionsInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if len(in.PermissionIDs) > 0 {
		belong, err := s.store.PermissionsAllBelongToWorkspaceType(r.Context(), in.PermissionIDs, wc.WorkspaceType)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "internal_error", "权限校验失败")
			return
		}
		if !belong {
			writeError(w, r, http.StatusBadRequest, "validation_error", "permissionIds 含非当前工作区类型权限")
			return
		}
	}
	if err := s.store.SetRolePermissions(r.Context(), r.PathValue("id"), wc.WorkspaceType, wc.WorkspaceID, in.PermissionIDs, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "role.permissions_updated", "role", r.PathValue("id"), map[string]any{"count": len(in.PermissionIDs)})
	if userIDs, err := s.store.UserIDsByRole(r.Context(), r.PathValue("id")); err == nil {
		s.notifyUsers(r.Context(), wc, userIDs, "权限变更", "您在『{ws}』的角色权限已更新", "permission")
	}
	writeData(w, r, map[string]any{"id": r.PathValue("id"), "permissionCount": len(in.PermissionIDs)})
}

// --- permissions catalog ---

func (s *Server) listPermissions(w http.ResponseWriter, r *http.Request, wc wsContext) {
	workspaceType := r.URL.Query().Get("workspaceType")
	if workspaceType == "" {
		workspaceType = wc.WorkspaceType
	}
	items, err := s.store.ListPermissions(r.Context(), workspaceType, r.URL.Query().Get("category"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, items)
}

// --- memberships authorization ---

type assignRolesInput struct {
	RoleIDs []string `json:"roleIds"`
}

func (s *Server) assignMembershipRoles(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in assignRolesInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if err := s.store.AssignMembershipRoles(r.Context(), r.PathValue("id"), wc.WorkspaceType, wc.WorkspaceID, in.RoleIDs, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "membership.roles_assigned", "membership", r.PathValue("id"), map[string]any{"count": len(in.RoleIDs)})
	s.notifyMember(r.Context(), wc, r.PathValue("id"), "权限变更", "您在『{ws}』的角色已更新", "permission")
	writeData(w, r, map[string]any{"id": r.PathValue("id"), "roleCount": len(in.RoleIDs)})
}

func (s *Server) membershipPermissions(w http.ResponseWriter, r *http.Request, wc wsContext) {
	id := r.PathValue("id")
	ok, err := s.store.MembershipInWorkspace(r.Context(), id, wc.WorkspaceType, wc.WorkspaceID)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "成员校验失败")
		return
	}
	if !ok {
		writeError(w, r, http.StatusNotFound, "not_found", "成员不存在")
		return
	}
	set, err := s.store.EffectivePermissions(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	scopes, err := s.store.DataScopesForMembership(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{
		"permissions":       set.Permissions,
		"actionPermissions": set.ActionPermissions,
		"menuKeys":          set.MenuKeys,
		"dataScopes":        scopes,
	})
}

// --- data scopes ---

type dataScopeDefinition struct {
	ScopeType string `json:"scopeType"`
	Label     string `json:"label"`
}

func (s *Server) listDataScopes(w http.ResponseWriter, r *http.Request, wc wsContext) {
	definitions := dataScopeDefinitionsFor(wc.WorkspaceType)
	current, err := s.store.DataScopesForMembership(r.Context(), wc.MembershipID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{
		"definitions": definitions,
		"current":     current,
	})
}

func dataScopeDefinitionsFor(workspaceType string) []dataScopeDefinition {
	switch workspaceType {
	case "platform":
		return []dataScopeDefinition{
			{"all", "全部"}, {"specified_agency", "指定机构"}, {"specified_enterprise", "指定企业"},
		}
	case "agency":
		return []dataScopeDefinition{
			{"current_agency", "当前机构"}, {"specified_enterprise", "指定企业"},
			{"department", "本部门"}, {"department_tree", "本部门及下级"}, {"specified_department", "指定部门"},
			{"team", "本团队"}, {"specified_team", "指定团队"}, {"self", "仅本人"}, {"custom", "自定义范围"},
		}
	case "enterprise":
		return []dataScopeDefinition{
			{"current_enterprise", "当前企业"},
			{"department", "本部门"}, {"department_tree", "本部门及下级"}, {"specified_department", "指定部门"},
			{"team", "本团队"}, {"specified_team", "指定团队"}, {"self", "仅本人"}, {"custom", "自定义范围"},
		}
	default:
		return []dataScopeDefinition{}
	}
}
