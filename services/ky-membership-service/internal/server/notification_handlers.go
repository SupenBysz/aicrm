package server

import (
	"net/http"

	"github.com/Kysion/KyaiCRM/services/ky-membership-service/internal/store"
)

func (s *Server) listNotifications(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, pageSize := parsePage(r)
	q := r.URL.Query()
	items, total, err := s.store.ListNotifications(r.Context(), wc.UserID, wc.WorkspaceType, wc.WorkspaceID, q.Get("read"), q.Get("type"), page, pageSize)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeList(w, r, items, store.Page{Page: page, PageSize: pageSize, Total: total})
}

func (s *Server) notificationUnreadCount(w http.ResponseWriter, r *http.Request, wc wsContext) {
	count, err := s.store.UnreadCount(r.Context(), wc.UserID, wc.WorkspaceType, wc.WorkspaceID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{"count": count})
}

func (s *Server) markNotificationRead(w http.ResponseWriter, r *http.Request, wc wsContext) {
	if err := s.store.MarkNotificationRead(r.Context(), r.PathValue("id"), wc.UserID, wc.WorkspaceType, wc.WorkspaceID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{"id": r.PathValue("id"), "read": true})
}

func (s *Server) markAllNotificationsRead(w http.ResponseWriter, r *http.Request, wc wsContext) {
	n, err := s.store.MarkAllRead(r.Context(), wc.UserID, wc.WorkspaceType, wc.WorkspaceID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{"markedCount": n})
}
