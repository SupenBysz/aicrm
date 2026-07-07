package server

import (
	"net/http"
	"strings"
)

func (s *Server) listNotificationTemplates(w http.ResponseWriter, r *http.Request, wc wsContext) {
	items, err := s.store.ListNotificationTemplates(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{"items": items})
}

type notificationTemplateInput struct {
	TemplateName string `json:"templateName"`
	Title        string `json:"title"`
	Content      string `json:"content"`
	Description  string `json:"description"`
}

func (s *Server) updateNotificationTemplate(w http.ResponseWriter, r *http.Request, wc wsContext) {
	key := r.PathValue("key")
	var in notificationTemplateInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.TemplateName) == "" || strings.TrimSpace(in.Title) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "模板名称和标题不能为空")
		return
	}
	if err := s.store.UpdateNotificationTemplate(r.Context(), key, strings.TrimSpace(in.TemplateName), strings.TrimSpace(in.Title), in.Content, strings.TrimSpace(in.Description), wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "notification_template.updated", "notification_template", key, nil)
	t, err := s.store.GetNotificationTemplate(r.Context(), key)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, t)
}

type notificationTemplateStatusInput struct {
	Enabled bool `json:"enabled"`
}

func (s *Server) updateNotificationTemplateStatus(w http.ResponseWriter, r *http.Request, wc wsContext) {
	key := r.PathValue("key")
	var in notificationTemplateStatusInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if err := s.store.UpdateNotificationTemplateStatus(r.Context(), key, in.Enabled, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "notification_template.status_changed", "notification_template", key, map[string]any{"enabled": in.Enabled})
	writeData(w, r, map[string]any{"templateKey": key, "enabled": in.Enabled})
}

func (s *Server) resetNotificationTemplate(w http.ResponseWriter, r *http.Request, wc wsContext) {
	key := r.PathValue("key")
	if err := s.store.ResetNotificationTemplate(r.Context(), key, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "notification_template.reset", "notification_template", key, nil)
	t, err := s.store.GetNotificationTemplate(r.Context(), key)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, t)
}
