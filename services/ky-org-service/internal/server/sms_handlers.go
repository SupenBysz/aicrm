package server

import (
	"net/http"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/store"
)

// --- accounts ---

func (s *Server) listSMSAccounts(w http.ResponseWriter, r *http.Request, wc wsContext) {
	items, err := s.store.ListSMSAccounts(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{"items": items})
}

type smsAccountInput struct {
	AccountName        string `json:"accountName"`
	ProviderKey        string `json:"providerKey"`
	Region             string `json:"region"`
	AccessKeyID        string `json:"accessKeyId"`
	AccessKeySecret    string `json:"accessKeySecret"`
	DefaultSignatureID string `json:"defaultSignatureId"`
	Status             string `json:"status"`
	Remark             string `json:"remark"`
}

func (in smsAccountInput) toAccount(id string) store.SMSAccount {
	provider := strings.TrimSpace(in.ProviderKey)
	if provider == "" {
		provider = "aliyun"
	}
	status := in.Status
	if status != "enabled" && status != "disabled" {
		status = "enabled"
	}
	return store.SMSAccount{
		ID: id, AccountName: strings.TrimSpace(in.AccountName), ProviderKey: provider,
		Region: strings.TrimSpace(in.Region), AccessKeyID: strings.TrimSpace(in.AccessKeyID),
		DefaultSignatureID: strings.TrimSpace(in.DefaultSignatureID), Status: status, Remark: in.Remark,
	}
}

func (s *Server) encryptSecret(plain string) (string, bool) {
	if strings.TrimSpace(plain) == "" {
		return "", true
	}
	if s.cipher == nil {
		return "", false
	}
	enc, err := s.cipher.Encrypt(strings.TrimSpace(plain))
	if err != nil {
		return "", false
	}
	return enc, true
}

func (s *Server) createSMSAccount(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in smsAccountInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.AccountName) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "账号名称不能为空")
		return
	}
	enc, ok := s.encryptSecret(in.AccessKeySecret)
	if !ok {
		writeError(w, r, http.StatusServiceUnavailable, "secret_unconfigured", "密钥服务未启用,无法保存密钥")
		return
	}
	id, err := s.store.CreateSMSAccount(r.Context(), in.toAccount(""), enc, wc.UserID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "sms_account.created", "sms_account", id, nil)
	acc, err := s.store.GetSMSAccount(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, acc)
}

func (s *Server) updateSMSAccount(w http.ResponseWriter, r *http.Request, wc wsContext) {
	id := r.PathValue("id")
	var in smsAccountInput
	if !decodeJSON(w, r, &in) {
		return
	}
	enc, ok := s.encryptSecret(in.AccessKeySecret)
	if !ok {
		writeError(w, r, http.StatusServiceUnavailable, "secret_unconfigured", "密钥服务未启用")
		return
	}
	if err := s.store.UpdateSMSAccount(r.Context(), in.toAccount(id), enc, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "sms_account.updated", "sms_account", id, nil)
	acc, err := s.store.GetSMSAccount(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, acc)
}

func (s *Server) deleteSMSAccount(w http.ResponseWriter, r *http.Request, wc wsContext) {
	id := r.PathValue("id")
	if err := s.store.DeleteSMSAccount(r.Context(), id); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "sms_account.deleted", "sms_account", id, nil)
	writeData(w, r, map[string]any{"id": id, "deleted": true})
}

// --- signatures ---

func (s *Server) listSMSSignatures(w http.ResponseWriter, r *http.Request, wc wsContext) {
	items, err := s.store.ListSMSSignatures(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{"items": items})
}

type smsSignatureInput struct {
	AccountID     string `json:"accountId"`
	SignatureName string `json:"signatureName"`
	Status        string `json:"status"`
	Remark        string `json:"remark"`
}

func (s *Server) createSMSSignature(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in smsSignatureInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.AccountID) == "" || strings.TrimSpace(in.SignatureName) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "所属账号和签名名称不能为空")
		return
	}
	status := in.Status
	if status != "enabled" && status != "disabled" {
		status = "enabled"
	}
	id, err := s.store.CreateSMSSignature(r.Context(), store.SMSSignature{AccountID: in.AccountID, SignatureName: strings.TrimSpace(in.SignatureName), Status: status, Remark: in.Remark}, wc.UserID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "sms_signature.created", "sms_signature", id, nil)
	writeData(w, r, map[string]any{"id": id})
}

func (s *Server) updateSMSSignature(w http.ResponseWriter, r *http.Request, wc wsContext) {
	id := r.PathValue("id")
	var in smsSignatureInput
	if !decodeJSON(w, r, &in) {
		return
	}
	status := in.Status
	if status != "enabled" && status != "disabled" {
		status = "enabled"
	}
	if err := s.store.UpdateSMSSignature(r.Context(), store.SMSSignature{ID: id, SignatureName: strings.TrimSpace(in.SignatureName), Status: status, Remark: in.Remark}, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "sms_signature.updated", "sms_signature", id, nil)
	writeData(w, r, map[string]any{"id": id})
}

func (s *Server) deleteSMSSignature(w http.ResponseWriter, r *http.Request, wc wsContext) {
	id := r.PathValue("id")
	if err := s.store.DeleteSMSSignature(r.Context(), id); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "sms_signature.deleted", "sms_signature", id, nil)
	writeData(w, r, map[string]any{"id": id, "deleted": true})
}

// --- templates ---

func (s *Server) listSMSTemplates(w http.ResponseWriter, r *http.Request, wc wsContext) {
	items, err := s.store.ListSMSTemplates(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{"items": items})
}

type smsTemplateInput struct {
	AccountID       string `json:"accountId"`
	Scene           string `json:"scene"`
	TemplateCode    string `json:"templateCode"`
	CodeVariable    string `json:"codeVariable"`
	CodeTTLSeconds  int    `json:"codeTtlSeconds"`
	DailyLimit      int    `json:"dailyLimit"`
	IntervalSeconds int    `json:"intervalSeconds"`
	Status          string `json:"status"`
	Remark          string `json:"remark"`
}

func (in smsTemplateInput) toTemplate(id string) store.SMSTemplate {
	status := in.Status
	if status != "enabled" && status != "disabled" {
		status = "enabled"
	}
	codeVar := strings.TrimSpace(in.CodeVariable)
	if codeVar == "" {
		codeVar = "code"
	}
	return store.SMSTemplate{
		ID: id, AccountID: in.AccountID, Scene: strings.TrimSpace(in.Scene), TemplateCode: strings.TrimSpace(in.TemplateCode),
		CodeVariable: codeVar, CodeTTLSeconds: in.CodeTTLSeconds, DailyLimit: in.DailyLimit, IntervalSeconds: in.IntervalSeconds,
		Status: status, Remark: in.Remark,
	}
}

func (s *Server) createSMSTemplate(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in smsTemplateInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.AccountID) == "" || strings.TrimSpace(in.Scene) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "所属账号和场景不能为空")
		return
	}
	id, err := s.store.CreateSMSTemplate(r.Context(), in.toTemplate(""), wc.UserID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "sms_template.created", "sms_template", id, nil)
	writeData(w, r, map[string]any{"id": id})
}

func (s *Server) updateSMSTemplate(w http.ResponseWriter, r *http.Request, wc wsContext) {
	id := r.PathValue("id")
	var in smsTemplateInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if err := s.store.UpdateSMSTemplate(r.Context(), in.toTemplate(id), wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "sms_template.updated", "sms_template", id, nil)
	writeData(w, r, map[string]any{"id": id})
}

func (s *Server) deleteSMSTemplate(w http.ResponseWriter, r *http.Request, wc wsContext) {
	id := r.PathValue("id")
	if err := s.store.DeleteSMSTemplate(r.Context(), id); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "sms_template.deleted", "sms_template", id, nil)
	writeData(w, r, map[string]any{"id": id, "deleted": true})
}
