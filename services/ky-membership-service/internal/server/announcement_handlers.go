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
	if !validStatus(in.TargetScope, "all", "agency", "enterprise", "user") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "targetScope 非法")
		return
	}
	if in.TargetScope != "all" && len(in.TargetIDs) == 0 {
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
