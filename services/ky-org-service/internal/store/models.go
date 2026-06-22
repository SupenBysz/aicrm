package store

import "time"

// UserBrief is a lightweight view of the user who created an organization.
type UserBrief struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Email       string `json:"email"`
	Phone       string `json:"phone"`
	Status      string `json:"status"`
}

type Agency struct {
	ID           string     `json:"id"`
	Name         string     `json:"name"`
	Code         string     `json:"code"`
	LogoURL      string     `json:"logoUrl"`
	Description  string     `json:"description"`
	Status       string     `json:"status"`
	ContactName  string     `json:"contactName"`
	ContactPhone string     `json:"contactPhone"`
	ContactEmail string     `json:"contactEmail"`
	CreatedBy    string     `json:"createdBy"`
	Creator      *UserBrief `json:"creator"`
	MemberCount  int64      `json:"memberCount"`
	CreatedAt    time.Time  `json:"createdAt"`
	UpdatedAt    time.Time  `json:"updatedAt"`
}

type Enterprise struct {
	ID           string     `json:"id"`
	AgencyID     *string    `json:"agencyId"`
	Name         string     `json:"name"`
	Code         string     `json:"code"`
	LogoURL      string     `json:"logoUrl"`
	Description  string     `json:"description"`
	Status       string     `json:"status"`
	ContactName  string     `json:"contactName"`
	ContactPhone string     `json:"contactPhone"`
	ContactEmail string     `json:"contactEmail"`
	CreatedBy    string     `json:"createdBy"`
	Creator      *UserBrief `json:"creator"`
	MemberCount  int64      `json:"memberCount"`
	CreatedAt    time.Time  `json:"createdAt"`
	UpdatedAt    time.Time  `json:"updatedAt"`
}

type Department struct {
	ID                 string    `json:"id"`
	WorkspaceType      string    `json:"workspaceType"`
	WorkspaceID        string    `json:"workspaceId"`
	ParentID           *string   `json:"parentId"`
	Name               string    `json:"name"`
	Code               string    `json:"code"`
	LeaderMembershipID *string   `json:"leaderMembershipId"`
	SortOrder          int       `json:"sortOrder"`
	Status             string    `json:"status"`
	CreatedAt          time.Time `json:"createdAt"`
	UpdatedAt          time.Time `json:"updatedAt"`
}

type Team struct {
	ID                 string    `json:"id"`
	WorkspaceType      string    `json:"workspaceType"`
	WorkspaceID        string    `json:"workspaceId"`
	DepartmentID       *string   `json:"departmentId"`
	Name               string    `json:"name"`
	Code               string    `json:"code"`
	LeaderMembershipID *string   `json:"leaderMembershipId"`
	Description        string    `json:"description"`
	Status             string    `json:"status"`
	CreatedAt          time.Time `json:"createdAt"`
	UpdatedAt          time.Time `json:"updatedAt"`
}

type Page struct {
	Page     int   `json:"page"`
	PageSize int   `json:"pageSize"`
	Total    int64 `json:"total"`
}
