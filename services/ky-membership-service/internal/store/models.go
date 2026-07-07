package store

import "time"

type MemberRole struct {
	ID   string `json:"id"`
	Code string `json:"code"`
	Name string `json:"name"`
}

type Member struct {
	ID            string       `json:"id"`
	UserID        string       `json:"userId"`
	Username      string       `json:"username"`
	WorkspaceType string       `json:"workspaceType"`
	WorkspaceID   string       `json:"workspaceId"`
	DisplayName   string       `json:"displayName"`
	EmployeeNo    string       `json:"employeeNo"`
	Title         string       `json:"title"`
	Status        string       `json:"status"`
	Email         string       `json:"email"`
	Phone         string       `json:"phone"`
	JoinedAt      *time.Time   `json:"joinedAt"`
	DepartmentIDs []string     `json:"departmentIds"`
	TeamIDs       []string     `json:"teamIds"`
	RoleIDs       []string     `json:"roleIds"`
	Roles         []MemberRole `json:"roles"`
}

type CreateMemberInput struct {
	ID            string
	UserID        string
	Username      string
	DisplayName   string
	Email         string
	Phone         string
	PasswordHash  string
	EmployeeNo    string
	Title         string
	WorkspaceType string
	WorkspaceID   string
	CreatedBy     string
	RoleIDs       []string
	DepartmentIDs []string
	TeamIDs       []string
}

type Invitation struct {
	ID                 string     `json:"id"`
	WorkspaceType      string     `json:"workspaceType"`
	WorkspaceID        string     `json:"workspaceId"`
	InvitationType     string     `json:"invitationType"`
	InviteeEmail       *string    `json:"inviteeEmail"`
	InviteePhone       *string    `json:"inviteePhone"`
	Token              string     `json:"token"`
	PresetRoleIDs      []string   `json:"presetRoleIds"`
	PresetDeptIDs      []string   `json:"presetDepartmentIds"`
	PresetTeamIDs      []string   `json:"presetTeamIds"`
	Status             string     `json:"status"`
	ExpiresAt          time.Time  `json:"expiresAt"`
	AcceptedUserID     *string    `json:"acceptedUserId"`
	AcceptedAt         *time.Time `json:"acceptedAt"`
	InvitedByMembershp string     `json:"-"`
	CreatedAt          time.Time  `json:"createdAt"`
}

type Page struct {
	Page     int   `json:"page"`
	PageSize int   `json:"pageSize"`
	Total    int64 `json:"total"`
}

type DepartmentAssignment struct {
	DepartmentID string `json:"departmentId"`
	IsPrimary    bool   `json:"isPrimary"`
}

type DataScope struct {
	ScopeType     string   `json:"scopeType"`
	DepartmentIDs []string `json:"departmentIds,omitempty"`
	TeamIDs       []string `json:"teamIds,omitempty"`
	AgencyIDs     []string `json:"agencyIds,omitempty"`
	EnterpriseIDs []string `json:"enterpriseIds,omitempty"`
}

type Role struct {
	ID            string      `json:"id"`
	WorkspaceType string      `json:"workspaceType"`
	WorkspaceID   *string     `json:"workspaceId"`
	Name          string      `json:"name"`
	Code          string      `json:"code"`
	Description   string      `json:"description"`
	IsSystem      bool        `json:"isSystem"`
	Status        string      `json:"status"`
	PermissionIDs []string    `json:"permissionIds"`
	DataScopes    []DataScope `json:"dataScopes"`
}

type Permission struct {
	ID             string   `json:"id"`
	Code           string   `json:"code"`
	Name           string   `json:"name"`
	Category       string   `json:"category"`
	Resource       string   `json:"resource"`
	Action         string   `json:"action"`
	WorkspaceTypes []string `json:"workspaceTypes"`
	Status         string   `json:"status"`
}

// PermissionSet holds a membership's effective permissions split by category.
type PermissionSet struct {
	Permissions       []string `json:"permissions"`
	ActionPermissions []string `json:"actionPermissions"`
	MenuKeys          []string `json:"menuKeys"`
}
