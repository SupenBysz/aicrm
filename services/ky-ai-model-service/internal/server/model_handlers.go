package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-ai-model-service/internal/store"
)

func (s *Server) listModels(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, pageSize := parsePage(r)
	q := r.URL.Query()
	items, total, err := s.store.ListModels(r.Context(), q.Get("providerId"), q.Get("modelType"), q.Get("status"), page, pageSize)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeList(w, r, items, store.Page{Page: page, PageSize: pageSize, Total: total})
}

type modelCreateInput struct {
	ProviderID        string          `json:"providerId"`
	Name              string          `json:"name"`
	ModelKey          string          `json:"modelKey"`
	ModelType         string          `json:"modelType"`
	ContextLength     int             `json:"contextLength"`
	DefaultParameters json.RawMessage `json:"defaultParameters"`
	Status            string          `json:"status"`
	Remark            string          `json:"remark"`
}

// phase1ModelType reports whether the model type is enabled in Phase 1.
func phase1ModelType(t string) bool {
	return t == "text_generation" || t == "embedding"
}

func (s *Server) createModel(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in modelCreateInput
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.ModelKey = strings.TrimSpace(in.ModelKey)
	in.ProviderID = strings.TrimSpace(in.ProviderID)
	if in.Name == "" || in.ModelKey == "" || in.ProviderID == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "providerId、name、modelKey 不能为空")
		return
	}
	if !phase1ModelType(in.ModelType) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "第一阶段仅支持 text_generation / embedding")
		return
	}
	enabled, err := s.store.ProviderEnabled(r.Context(), in.ProviderID)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "供应商校验失败")
		return
	}
	if !enabled {
		writeError(w, r, http.StatusBadRequest, "validation_error", "providerId 不存在或已停用")
		return
	}
	status := in.Status
	if !validStatus(status, "enabled", "disabled") {
		status = "enabled"
	}
	m := store.Model{
		ID: newID("model"), ProviderID: in.ProviderID, Name: in.Name, ModelKey: in.ModelKey,
		ModelType: in.ModelType, ContextLength: in.ContextLength, DefaultParameters: in.DefaultParameters,
		Status: status, Remark: in.Remark,
	}
	if err := s.store.CreateModel(r.Context(), m, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "ai_model.created", "ai_model", m.ID, map[string]any{"modelType": m.ModelType})
	created, err := s.store.GetModel(r.Context(), m.ID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, created)
}

type modelUpdateInput struct {
	Name              string          `json:"name"`
	ContextLength     int             `json:"contextLength"`
	DefaultParameters json.RawMessage `json:"defaultParameters"`
	Remark            string          `json:"remark"`
}

func (s *Server) updateModel(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in modelUpdateInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "name 不能为空")
		return
	}
	if err := s.store.UpdateModel(r.Context(), r.PathValue("id"), strings.TrimSpace(in.Name), in.ContextLength, in.DefaultParameters, in.Remark, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "ai_model.updated", "ai_model", r.PathValue("id"), nil)
	updated, err := s.store.GetModel(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, updated)
}

func (s *Server) updateModelStatus(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in statusInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if !validStatus(in.Status, "enabled", "disabled") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "status 非法")
		return
	}
	if in.Status == "enabled" {
		// Cannot enable a model whose provider is disabled.
		m, err := s.store.GetModel(r.Context(), r.PathValue("id"))
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		enabled, err := s.store.ProviderEnabled(r.Context(), m.ProviderID)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "internal_error", "供应商校验失败")
			return
		}
		if !enabled {
			writeError(w, r, http.StatusBadRequest, "validation_error", "供应商已停用，无法启用其模型")
			return
		}
	}
	if err := s.store.UpdateModelStatus(r.Context(), r.PathValue("id"), in.Status, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "ai_model.status_changed", "ai_model", r.PathValue("id"), map[string]any{"status": in.Status})
	writeData(w, r, map[string]any{"id": r.PathValue("id"), "status": in.Status})
}
