package server

import (
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-membership-service/internal/store"
)

func requestExpectedRevision(r *http.Request) (int64, bool) {
	value := strings.TrimSpace(r.Header.Get("X-KY-Expected-Revision"))
	if value == "" {
		return 0, false
	}
	revision, err := strconv.ParseInt(value, 10, 64)
	return revision, err == nil && revision > 0
}

func (s *Server) listMenuDirectory(w http.ResponseWriter, r *http.Request, wc wsContext) {
	directory := r.PathValue("directoryType")
	includeDisabled := r.URL.Query().Get("includeDisabled") == "1"
	if includeDisabled {
		allowed, err := s.store.HasAny(r.Context(), wc.MembershipID, []string{"platform.menu_catalog.manage"})
		if err != nil {
			writeError(w, r, 503, "authorization_unavailable", "菜单权限暂不可用")
			return
		}
		if !allowed {
			writeError(w, r, 403, "permission_denied", "无权查看停用菜单")
			return
		}
	}
	items, err := s.store.ListMenuDirectory(r.Context(), directory, wc.WorkspaceType, includeDisabled)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{"items": items})
}

func (s *Server) listVisibleMenuDirectory(w http.ResponseWriter, r *http.Request, wc wsContext) {
	directory := r.PathValue("directoryType")
	entries, err := s.store.ListMenuDirectory(r.Context(), directory, wc.WorkspaceType, false)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	permissions, err := s.store.EffectivePermissions(r.Context(), wc.MembershipID)
	if err != nil {
		writeError(w, r, 503, "authorization_unavailable", "菜单授权暂不可用")
		return
	}
	allowed := map[string]bool{}
	for _, code := range permissions.MenuKeys {
		allowed[code] = true
	}
	byKey := map[string]store.MenuEntry{}
	for _, entry := range entries {
		byKey[entry.MenuKey] = entry
	}
	leaves := []store.MenuEntry{}
	ancestors := map[string]store.MenuEntry{}
	for _, entry := range entries {
		if entry.NodeType != "leaf" || !allowed[entry.PermissionCode] || !menuAncestorsEnabled(entry, byKey) {
			continue
		}
		leaves = append(leaves, entry)
		parent := entry.ParentKey
		for parent != nil && *parent != "" {
			ancestors[*parent] = byKey[*parent]
			parent = byKey[*parent].ParentKey
		}
	}
	writeData(w, r, map[string]any{"items": menuNavigationProjection(leaves), "ancestors": menuNavigationProjection(mapMenuEntries(ancestors))})
}

func (s *Server) listAssignableMenuDirectory(w http.ResponseWriter, r *http.Request, wc wsContext) {
	entries, err := s.store.ListMenuDirectory(r.Context(), r.PathValue("directoryType"), wc.WorkspaceType, false)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	leaves := make([]store.MenuEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.NodeType == "leaf" {
			leaves = append(leaves, entry)
		}
	}
	writeData(w, r, map[string]any{"items": leaves, "ancestors": menuAncestorsFor(leaves, entries)})
}

func menuAncestorsFor(leaves, entries []store.MenuEntry) []store.MenuEntry {
	byKey := map[string]store.MenuEntry{}
	for _, entry := range entries {
		byKey[entry.MenuKey] = entry
	}
	found := map[string]store.MenuEntry{}
	for _, leaf := range leaves {
		parent := leaf.ParentKey
		seen := map[string]bool{}
		for parent != nil && *parent != "" && !seen[*parent] {
			seen[*parent] = true
			if p, ok := byKey[*parent]; ok && p.NodeType == "group" {
				found[p.MenuKey] = p
				parent = p.ParentKey
			} else {
				break
			}
		}
	}
	return mapMenuEntries(found)
}

type menuNavItem struct {
	DirectoryType string  `json:"directoryType"`
	MenuKey       string  `json:"menuKey"`
	NodeType      string  `json:"nodeType"`
	ParentKey     *string `json:"parentKey,omitempty"`
	Name          string  `json:"name"`
	Icon          string  `json:"icon"`
	RouteKey      *string `json:"routeKey,omitempty"`
	PageType      string  `json:"pageType"`
	SortOrder     int     `json:"sortOrder"`
}

func menuNavigationProjection(entries []store.MenuEntry) []menuNavItem {
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].SortOrder != entries[j].SortOrder {
			return entries[i].SortOrder < entries[j].SortOrder
		}
		return entries[i].MenuKey < entries[j].MenuKey
	})
	out := make([]menuNavItem, 0, len(entries))
	for _, entry := range entries {
		out = append(out, menuNavItem{DirectoryType: entry.DirectoryType, MenuKey: entry.MenuKey, NodeType: entry.NodeType, ParentKey: entry.ParentKey, Name: entry.Name, Icon: entry.Icon, RouteKey: entry.RouteKey, PageType: entry.PageType, SortOrder: entry.SortOrder})
	}
	return out
}
func mapMenuEntries(entries map[string]store.MenuEntry) []store.MenuEntry {
	out := make([]store.MenuEntry, 0, len(entries))
	for _, entry := range entries {
		out = append(out, entry)
	}
	return out
}

func (s *Server) saveMenuDirectoryEntry(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in store.MenuEntryInput
	if !decodeJSON(w, r, &in) {
		return
	}
	in.DirectoryType, in.MenuKey = r.PathValue("directoryType"), r.PathValue("menuKey")
	if in.ExpectedRevision != nil && *in.ExpectedRevision > 0 {
		header, ok := requestExpectedRevision(r)
		if !ok || header != *in.ExpectedRevision {
			writeError(w, r, 428, "revision_required", "更新菜单需要匹配的 X-KY-Expected-Revision")
			return
		}
	}
	entry, err := s.store.SaveMenuEntry(r.Context(), in, wc.UserID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "menu_directory.saved", "menu", entry.MenuKey, map[string]any{"directoryType": entry.DirectoryType, "revision": entry.Revision})
	writeData(w, r, entry)
}

func (s *Server) setMenuDirectoryStatus(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in struct {
		Status string `json:"status"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	revision, ok := requestExpectedRevision(r)
	if !ok {
		writeError(w, r, 428, "revision_required", "更新菜单状态需要 X-KY-Expected-Revision")
		return
	}
	directory, key := r.PathValue("directoryType"), r.PathValue("menuKey")
	if err := s.store.UpdateMenuStatus(r.Context(), directory, key, in.Status, wc.UserID, revision); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "menu_directory.status_changed", "menu", key, map[string]any{"directoryType": directory, "status": in.Status, "revision": revision + 1})
	writeData(w, r, map[string]any{"directoryType": directory, "menuKey": key, "status": in.Status, "revision": revision + 1})
}

func (s *Server) getMenuWebViewConfig(w http.ResponseWriter, r *http.Request, wc wsContext) {
	directory, key := r.PathValue("directoryType"), r.PathValue("menuKey")
	entry, err := s.store.GetMenuEntry(r.Context(), directory, key)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	if entry.NodeType != "leaf" || entry.PageType != "webview" {
		writeError(w, r, 404, "not_found", "WebView 菜单不存在")
		return
	}
	scope := r.URL.Query().Get("scope")
	var config store.MenuWebViewConfig
	if scope == "" {
		config, err = s.store.GetMenuWebViewConfig(r.Context(), directory, key, wc.WorkspaceType, wc.WorkspaceID)
	} else if scope == "common" || scope == "workspace" {
		config, err = s.store.GetMenuWebViewConfigAtScope(r.Context(), directory, key, scope, wc.WorkspaceType, wc.WorkspaceID)
	} else {
		writeError(w, r, 400, "validation_error", "配置范围无效")
		return
	}
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, config)
}

func (s *Server) saveMenuWebViewConfig(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in struct {
		ConfigScope string `json:"configScope"`
		store.MenuWebViewConfigInput
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.ConfigScope != "common" && in.ConfigScope != "workspace" {
		writeError(w, r, 400, "validation_error", "configScope 无效")
		return
	}
	if in.ConfigScope == "common" && wc.WorkspaceType != "platform" {
		writeError(w, r, 403, "permission_denied", "只有平台工作区可维护通用配置")
		return
	}
	revision, ok := requestExpectedRevision(r)
	if in.ExpectedRevision != nil && *in.ExpectedRevision > 0 && (!ok || revision != *in.ExpectedRevision) {
		writeError(w, r, 428, "revision_required", "更新配置需要匹配的 X-KY-Expected-Revision")
		return
	}
	if in.ExpectedRevision == nil && ok {
		in.ExpectedRevision = &revision
	}
	config, err := s.store.SaveMenuWebViewConfig(r.Context(), r.PathValue("directoryType"), r.PathValue("menuKey"), wc.WorkspaceType, wc.WorkspaceID, in.ConfigScope, in.MenuWebViewConfigInput, wc.UserID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "menu_webview_config.saved", "menu", config.MenuKey, map[string]any{"directoryType": config.DirectoryType, "scope": config.ConfigScope, "revision": config.Revision})
	writeData(w, r, config)
}

func (s *Server) resolveMenuWebView(w http.ResponseWriter, r *http.Request, wc wsContext) {
	directory, key := r.PathValue("directoryType"), r.PathValue("menuKey")
	if !store.ValidMenuDirectoryType(directory) {
		writeError(w, r, 400, "validation_error", "菜单目录无效")
		return
	}
	entries, err := s.store.ListMenuDirectory(r.Context(), directory, wc.WorkspaceType, false)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	byKey := make(map[string]store.MenuEntry, len(entries))
	for _, entry := range entries {
		byKey[entry.MenuKey] = entry
	}
	entry, ok := byKey[key]
	if !ok || entry.NodeType != "leaf" || entry.PageType != "webview" || !menuAncestorsEnabled(entry, byKey) {
		writeError(w, r, 404, "not_found", "菜单不存在或未启用")
		return
	}
	permissions, err := s.store.EffectivePermissions(r.Context(), wc.MembershipID)
	if err != nil {
		writeError(w, r, 503, "authorization_unavailable", "菜单授权暂不可用")
		return
	}
	if !containsCode(permissions.MenuKeys, entry.PermissionCode) {
		writeError(w, r, 404, "not_found", "菜单不存在或不可访问")
		return
	}
	config, err := s.store.GetMenuWebViewConfig(r.Context(), directory, key, wc.WorkspaceType, wc.WorkspaceID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{"page": entry, "config": config})
}

func containsCode(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
func menuAncestorsEnabled(entry store.MenuEntry, entries map[string]store.MenuEntry) bool {
	seen := map[string]bool{}
	parent := entry.ParentKey
	for parent != nil && *parent != "" {
		if seen[*parent] {
			return false
		}
		seen[*parent] = true
		p, ok := entries[*parent]
		if !ok || p.NodeType != "group" || p.Status != "active" {
			return false
		}
		parent = p.ParentKey
	}
	return true
}
