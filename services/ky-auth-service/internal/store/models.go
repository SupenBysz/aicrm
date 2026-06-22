package store

import "time"

type User struct {
	ID          string
	Username    string
	DisplayName string
	AvatarURL   string
	Phone       string
	Email       string
	Status      string
}

type Credential struct {
	ID           string
	UserID       string
	PasswordHash string
	Status       string
	User         User
}

type Membership struct {
	ID            string
	UserID        string
	WorkspaceType string
	WorkspaceID   string
	DisplayName   string
	Status        string
}

type Role struct {
	ID   string `json:"id"`
	Code string `json:"code"`
	Name string `json:"name"`
}

type DataScope struct {
	ScopeType     string   `json:"scopeType"`
	DepartmentIDs []string `json:"departmentIds,omitempty"`
	TeamIDs       []string `json:"teamIds,omitempty"`
	AgencyIDs     []string `json:"agencyIds,omitempty"`
	EnterpriseIDs []string `json:"enterpriseIds,omitempty"`
}

type Session struct {
	ID        string
	UserID    string
	TokenID   string
	UserAgent string
	IPAddress string
	Status    string
	ExpiresAt time.Time
}

type WorkspaceIdentity struct {
	ID                string      `json:"id"`
	Type              string      `json:"type"`
	Name              string      `json:"name"`
	MembershipID      string      `json:"membershipId"`
	Roles             []Role      `json:"roles"`
	Permissions       []string    `json:"permissions"`
	ActionPermissions []string    `json:"actionPermissions"`
	MenuKeys          []string    `json:"menuKeys"`
	DataScopes        []DataScope `json:"dataScopes"`
}
