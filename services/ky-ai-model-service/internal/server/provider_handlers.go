package server

import (
	"net/http"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-ai-model-service/internal/crypto"
	"github.com/Kysion/KyaiCRM/services/ky-ai-model-service/internal/store"
)

// publicProvider strips secret material and adds display-only masking.
func publicProvider(p store.Provider) store.Provider {
	p.APIKeyEncrypted = ""
	p.APIKeyMasked = ""
	if p.HasAPIKey {
		p.APIKeyMasked = "***"
	}
	return p
}

func (s *Server) listProviders(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, pageSize := parsePage(r)
	q := r.URL.Query()
	items, total, err := s.store.ListProviders(r.Context(), q.Get("status"), q.Get("type"), page, pageSize)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	out := make([]store.Provider, 0, len(items))
	for _, p := range items {
		out = append(out, publicProvider(p))
	}
	writeList(w, r, out, store.Page{Page: page, PageSize: pageSize, Total: total})
}

type providerCreateInput struct {
	Name         string `json:"name"`
	ProviderType string `json:"providerType"`
	BaseURL      string `json:"baseUrl"`
	APIKey       string `json:"apiKey"`
	Status       string `json:"status"`
	Remark       string `json:"remark"`
}

func (s *Server) createProvider(w http.ResponseWriter, r *http.Request, wc wsContext) {
	if s.cipher == nil {
		writeError(w, r, http.StatusServiceUnavailable, "service_unavailable", "AI 加密密钥未配置")
		return
	}
	var in providerCreateInput
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.ProviderType = strings.TrimSpace(in.ProviderType)
	if in.Name == "" || in.ProviderType == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "name 和 providerType 不能为空")
		return
	}
	status := in.Status
	if !validStatus(status, "enabled", "disabled") {
		status = "enabled"
	}
	encrypted := ""
	if in.APIKey != "" {
		ct, err := s.cipher.Encrypt(in.APIKey)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "internal_error", "API Key 加密失败")
			return
		}
		encrypted = ct
	}
	p := store.Provider{
		ID: newID("provider"), Name: in.Name, ProviderType: in.ProviderType, BaseURL: in.BaseURL,
		APIKeyEncrypted: encrypted, Status: status, Remark: in.Remark,
	}
	if err := s.store.CreateProvider(r.Context(), p, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "ai_provider.created", "ai_provider", p.ID, map[string]any{"providerType": p.ProviderType})
	created, err := s.store.GetProvider(r.Context(), p.ID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, publicProvider(created))
}

type providerUpdateInput struct {
	Name    string  `json:"name"`
	BaseURL string  `json:"baseUrl"`
	Remark  string  `json:"remark"`
	APIKey  *string `json:"apiKey"`
}

func (s *Server) updateProvider(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in providerUpdateInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "name 不能为空")
		return
	}
	encrypted := ""
	if in.APIKey != nil && *in.APIKey != "" {
		if s.cipher == nil {
			writeError(w, r, http.StatusServiceUnavailable, "service_unavailable", "AI 加密密钥未配置")
			return
		}
		ct, err := s.cipher.Encrypt(*in.APIKey)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "internal_error", "API Key 加密失败")
			return
		}
		encrypted = ct
	}
	if err := s.store.UpdateProvider(r.Context(), r.PathValue("id"), strings.TrimSpace(in.Name), in.BaseURL, in.Remark, encrypted, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "ai_provider.updated", "ai_provider", r.PathValue("id"), nil)
	updated, err := s.store.GetProvider(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, publicProvider(updated))
}

type statusInput struct {
	Status string `json:"status"`
}

func (s *Server) updateProviderStatus(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in statusInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if !validStatus(in.Status, "enabled", "disabled") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "status 非法")
		return
	}
	if in.Status == "disabled" {
		// Cascade: disabling a provider disables its models and clears any
		// platform default-model setting pointing at them (one transaction).
		modelsDisabled, defaultsCleared, err := s.store.DisableProviderCascade(r.Context(), r.PathValue("id"), wc.UserID)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		s.audit(r.Context(), r, wc, "ai_provider.status_changed", "ai_provider", r.PathValue("id"),
			map[string]any{"status": in.Status, "modelsDisabled": modelsDisabled, "defaultsCleared": defaultsCleared})
		writeData(w, r, map[string]any{"id": r.PathValue("id"), "status": in.Status, "modelsDisabled": modelsDisabled, "defaultsCleared": defaultsCleared})
		return
	}
	// Enable: provider only; models are not auto-re-enabled.
	if err := s.store.UpdateProviderStatus(r.Context(), r.PathValue("id"), in.Status, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "ai_provider.status_changed", "ai_provider", r.PathValue("id"), map[string]any{"status": in.Status})
	writeData(w, r, map[string]any{"id": r.PathValue("id"), "status": in.Status})
}

type rotateKeyInput struct {
	APIKey string `json:"apiKey"`
}

// rotateProviderAPIKey re-encrypts a new API key for the provider. Dedicated
// endpoint/permission/audit action for key rotation; the response carries only
// a masked key and never the plaintext or ciphertext.
func (s *Server) rotateProviderAPIKey(w http.ResponseWriter, r *http.Request, wc wsContext) {
	if s.cipher == nil {
		writeError(w, r, http.StatusServiceUnavailable, "service_unavailable", "AI 加密密钥未配置")
		return
	}
	var in rotateKeyInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.APIKey) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "apiKey 不能为空")
		return
	}
	if _, err := s.store.GetProvider(r.Context(), r.PathValue("id")); err != nil {
		writeStoreError(w, r, err)
		return
	}
	ct, err := s.cipher.Encrypt(in.APIKey)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "internal_error", "API Key 加密失败")
		return
	}
	if err := s.store.RotateProviderAPIKey(r.Context(), r.PathValue("id"), ct, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	// Audit carries no key material (plaintext or masked), per audit policy.
	s.audit(r.Context(), r, wc, "ai_provider.api_key_rotated", "ai_provider", r.PathValue("id"), nil)
	writeData(w, r, map[string]any{"id": r.PathValue("id"), "apiKeyMasked": crypto.Mask(in.APIKey)})
}
