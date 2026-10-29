// Package menucatalog owns the trusted internal-route manifest generated from
// plugin registrations. It is metadata, never a grant of business permissions.
package menucatalog

import (
	_ "embed"
	"encoding/json"
)

//go:embed builtin.json
var manifest []byte

type Entry struct {
	DirectoryType      string              `json:"directoryType"`
	MenuKey            string              `json:"menuKey"`
	NodeType           string              `json:"nodeType"`
	ParentKey          *string             `json:"parentKey"`
	Name               string              `json:"name"`
	Icon               string              `json:"icon"`
	WorkspaceTypes     []string            `json:"workspaceTypes"`
	RouteKey           *string             `json:"routeKey"`
	RoutePath          *string             `json:"routePath"`
	PageType           string              `json:"pageType"`
	Status             string              `json:"status"`
	SortOrder          int                 `json:"sortOrder"`
	PermissionCode     string              `json:"permissionCode"`
	PermissionBindings map[string][]string `json:"permissionBindings"`
}

func Entries() []Entry {
	var catalog struct {
		Entries []Entry `json:"entries"`
	}
	if err := json.Unmarshal(manifest, &catalog); err != nil {
		panic(err)
	}
	return catalog.Entries
}
func InternalRouteAllowed(directory, key string) bool {
	for _, entry := range Entries() {
		if entry.DirectoryType == directory && entry.RouteKey != nil && *entry.RouteKey == key {
			return true
		}
	}
	return false
}
