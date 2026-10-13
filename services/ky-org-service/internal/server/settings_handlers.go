package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
)

type settingsBody struct {
	Settings map[string]json.RawMessage `json:"settings"`
}

var errInvalidSettingsPatch = errors.New("invalid settings patch")

func validateSettingsPatch(settings map[string]json.RawMessage) error {
	if len(settings) != 1 {
		return errInvalidSettingsPatch
	}
	raw, ok := settings["security"]
	if !ok {
		return errInvalidSettingsPatch
	}
	var security map[string]json.RawMessage
	if err := json.Unmarshal(raw, &security); err != nil || security == nil {
		return errInvalidSettingsPatch
	}
	raw, ok = security["mfaEnabled"]
	if !ok {
		return errInvalidSettingsPatch
	}
	var enabled bool
	if err := json.Unmarshal(raw, &enabled); err != nil {
		return errInvalidSettingsPatch
	}
	normalized := bytes.TrimSpace(raw)
	if !bytes.Equal(normalized, []byte("true")) && !bytes.Equal(normalized, []byte("false")) {
		return errInvalidSettingsPatch
	}
	return nil
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
	if err := validateSettingsPatch(in.Settings); err != nil {
		writeError(w, r, http.StatusBadRequest, "validation_error", "security.mfaEnabled 必须是布尔值")
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
	if err := validateSettingsPatch(in.Settings); err != nil {
		writeError(w, r, http.StatusBadRequest, "validation_error", "security.mfaEnabled 必须是布尔值")
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
