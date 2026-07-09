package server

import (
	"net/http"

	"github.com/Kysion/KyaiCRM/services/ky-ai-model-service/internal/store"
)

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request, wc wsContext) {
	m, err := s.store.GetDefaultModels(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{
		"defaultChatModelId":       orNil(m["default_chat_model"]),
		"defaultSummaryModelId":    orNil(m["default_summary_model"]),
		"defaultEmbeddingModelId":  orNil(m["default_embedding_model"]),
		"defaultMultimodalModelId": orNil(m["default_multimodal_model"]),
	})
}

func orNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

type settingsInput struct {
	DefaultChatModelID       *string `json:"defaultChatModelId"`
	DefaultSummaryModelID    *string `json:"defaultSummaryModelId"`
	DefaultEmbeddingModelID  *string `json:"defaultEmbeddingModelId"`
	DefaultMultimodalModelID *string `json:"defaultMultimodalModelId"`
}

func (s *Server) updateSettings(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in settingsInput
	if !decodeJSON(w, r, &in) {
		return
	}
	// Each present field is applied; nil means "leave unchanged", empty means clear.
	type change struct {
		settingKey   string
		value        *string
		requiredType string
	}
	changes := []change{
		{"default_chat_model", in.DefaultChatModelID, "text_generation"},
		{"default_summary_model", in.DefaultSummaryModelID, "text_generation"},
		{"default_embedding_model", in.DefaultEmbeddingModelID, "embedding"},
		{"default_multimodal_model", in.DefaultMultimodalModelID, "vision"},
	}
	for _, c := range changes {
		if c.value == nil {
			continue
		}
		modelID := *c.value
		if modelID != "" {
			modelType, status, err := s.store.ModelForDefault(r.Context(), modelID)
			if err == store.ErrNotFound {
				writeError(w, r, http.StatusBadRequest, "validation_error", c.settingKey+" 指向的模型不存在")
				return
			}
			if err != nil {
				writeError(w, r, http.StatusInternalServerError, "internal_error", "模型校验失败")
				return
			}
			if status != "enabled" {
				writeError(w, r, http.StatusBadRequest, "validation_error", c.settingKey+" 指向的模型未启用")
				return
			}
			if modelType != c.requiredType {
				writeError(w, r, http.StatusBadRequest, "validation_error", c.settingKey+" 模型类型必须为 "+c.requiredType)
				return
			}
		}
		if err := s.store.SetDefaultModel(r.Context(), c.settingKey, modelID, wc.UserID); err != nil {
			writeStoreError(w, r, err)
			return
		}
	}
	s.audit(r.Context(), r, wc, "ai_model_settings.updated", "ai_model_setting", "platform_root", nil)
	s.getSettings(w, r, wc)
}
