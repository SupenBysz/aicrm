package server

import (
	"net/http"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-membership-service/internal/store"
)

func (s *Server) listAnnouncements(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, pageSize := parsePage(r)
	var (
		items []store.Announcement
		total int64
		err   error
	)
	if wc.WorkspaceType == "platform" {
		items, total, err = s.store.ListAnnouncementsPlatform(r.Context(), r.URL.Query().Get("status"), page, pageSize)
	} else {
		items, total, err = s.store.ListAnnouncementsForWorkspace(r.Context(), wc.WorkspaceType, wc.WorkspaceID, page, pageSize)
	}
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeList(w, r, items, store.Page{Page: page, PageSize: pageSize, Total: total})
}

type announcementInput struct {
	Title       string   `json:"title"`
	Content     string   `json:"content"`
	TargetScope string   `json:"targetScope"`
	TargetIDs   []string `json:"targetIds"`
}

// scopeNeedsTargets reports whether a target scope requires an explicit id list.
// The "指定" scopes do; "all" and the whole-type broadcasts (*_all) do not.
func scopeNeedsTargets(scope string) bool {
	return scope == "agency" || scope == "enterprise" || scope == "user"
}

func (s *Server) createAnnouncement(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in announcementInput
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Title = strings.TrimSpace(in.Title)
	in.Content = strings.TrimSpace(in.Content)
	if in.Title == "" || in.Content == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "title 和 content 不能为空")
		return
	}
	if !validStatus(in.TargetScope, "all", "agency", "enterprise", "user", "agency_all", "enterprise_all", "user_all") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "targetScope 非法")
		return
	}
	// Only the "指定" scopes require an explicit id list; "全部/全部X" broadcast scopes do not.
	if scopeNeedsTargets(in.TargetScope) && len(in.TargetIDs) == 0 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "该 targetScope 需要 targetIds")
		return
	}
	id, err := s.store.CreateAnnouncement(r.Context(), store.Announcement{Title: in.Title, Content: in.Content, TargetScope: in.TargetScope, TargetIDs: in.TargetIDs}, wc.UserID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "announcement.created", "announcement", id, map[string]any{"targetScope": in.TargetScope})
	created, err := s.store.GetAnnouncement(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, created)
}

func (s *Server) updateAnnouncement(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in announcementInput
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Title = strings.TrimSpace(in.Title)
	in.Content = strings.TrimSpace(in.Content)
	if in.Title == "" || in.Content == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "title 和 content 不能为空")
		return
	}
	if !validStatus(in.TargetScope, "all", "agency", "enterprise", "user", "agency_all", "enterprise_all", "user_all") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "targetScope 非法")
		return
	}
	// Only the "指定" scopes require an explicit id list; "全部/全部X" broadcast scopes do not.
	if scopeNeedsTargets(in.TargetScope) && len(in.TargetIDs) == 0 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "该 targetScope 需要 targetIds")
		return
	}
	id := r.PathValue("id")
	if err := s.store.UpdateAnnouncement(r.Context(), store.Announcement{ID: id, Title: in.Title, Content: in.Content, TargetScope: in.TargetScope, TargetIDs: in.TargetIDs}); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "announcement.updated", "announcement", id, map[string]any{"targetScope": in.TargetScope})
	updated, err := s.store.GetAnnouncement(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, updated)
}

func (s *Server) deleteAnnouncement(w http.ResponseWriter, r *http.Request, wc wsContext) {
	id := r.PathValue("id")
	if err := s.store.DeleteAnnouncement(r.Context(), id); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "announcement.deleted", "announcement", id, nil)
	writeData(w, r, map[string]any{"id": id, "deleted": true})
}

func (s *Server) publishAnnouncement(w http.ResponseWriter, r *http.Request, wc wsContext) {
	id := r.PathValue("id")
	generated, err := s.store.PublishAnnouncement(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "announcement.published", "announcement", id, map[string]any{"notificationsGenerated": generated})
	writeData(w, r, map[string]any{"id": id, "status": "published", "notificationsGenerated": generated})
}
