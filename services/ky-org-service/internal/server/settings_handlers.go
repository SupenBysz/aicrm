package server

import (
	"encoding/json"
	"net/http"
)

type settingsBody struct {
	Settings map[string]json.RawMessage `json:"settings"`
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request, wc wsContext) {
	m, err := s.store.GetSettings(r.Context(), wc.WorkspaceType, wc.WorkspaceID, "")
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{"settings": m})
}

func (s *Server) updateSettings(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in settingsBody
	if !decodeJSON(w, r, &in) {
		return
	}
	if len(in.Settings) == 0 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "settings 不能为空")
		return
	}
	if err := s.store.UpsertSettings(r.Context(), wc.WorkspaceType, wc.WorkspaceID, in.Settings, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "settings.updated", "settings", wc.WorkspaceID, nil)
	m, err := s.store.GetSettings(r.Context(), wc.WorkspaceType, wc.WorkspaceID, "")
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{"settings": m})
}

func (s *Server) getPlatformSettings(w http.ResponseWriter, r *http.Request, wc wsContext) {
	section := r.URL.Query().Get("section")
	m, err := s.store.GetSettings(r.Context(), "platform", "platform_root", section)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{"settings": m})
}

func (s *Server) updatePlatformSettings(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in settingsBody
	if !decodeJSON(w, r, &in) {
		return
	}
	if len(in.Settings) == 0 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "settings 不能为空")
		return
	}
	if err := s.store.UpsertSettings(r.Context(), "platform", "platform_root", in.Settings, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "system_settings.updated", "settings", "platform_root", nil)
	m, err := s.store.GetSettings(r.Context(), "platform", "platform_root", "")
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{"settings": m})
}

func (s *Server) listDictionaries(w http.ResponseWriter, r *http.Request, wc wsContext) {
	items, err := s.store.ListDictionaries(r.Context(), r.URL.Query().Get("code"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, items)
}
