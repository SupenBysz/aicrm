package server

import (
	"net/http"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/store"
)

// --- accounts ---

func (s *Server) listEmailAccounts(w http.ResponseWriter, r *http.Request, wc wsContext) {
	items, err := s.store.ListEmailAccounts(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{"items": items})
}

type emailAccountInput struct {
	AccountName  string `json:"accountName"`
	ProviderKey  string `json:"providerKey"`
	Host         string `json:"host"`
	Port         int    `json:"port"`
	Encryption   string `json:"encryption"`
	Username     string `json:"username"`
	Password     string `json:"password"`
	FromEmail    string `json:"fromEmail"`
	FromName     string `json:"fromName"`
	ReplyToEmail string `json:"replyToEmail"`
	Status       string `json:"status"`
	Remark       string `json:"remark"`
}

func (in emailAccountInput) toAccount(id string) store.EmailAccount {
	provider := strings.TrimSpace(in.ProviderKey)
	if provider == "" {
		provider = "smtp"
	}
	enc := in.Encryption
	if enc != "none" && enc != "ssl" && enc != "tls" {
		enc = "ssl"
	}
	status := in.Status
	if status != "enabled" && status != "disabled" {
		status = "enabled"
	}
	port := in.Port
	if port == 0 {
		port = 465
	}
	return store.EmailAccount{
		ID: id, AccountName: strings.TrimSpace(in.AccountName), ProviderKey: provider, Host: strings.TrimSpace(in.Host),
		Port: port, Encryption: enc, Username: strings.TrimSpace(in.Username), FromEmail: strings.TrimSpace(in.FromEmail),
		FromName: strings.TrimSpace(in.FromName), ReplyToEmail: strings.TrimSpace(in.ReplyToEmail), Status: status, Remark: in.Remark,
	}
}

func (s *Server) createEmailAccount(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in emailAccountInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.AccountName) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "账号名称不能为空")
		return
	}
	enc, ok := s.encryptSecret(in.Password)
	if !ok {
		writeError(w, r, http.StatusServiceUnavailable, "secret_unconfigured", "密钥服务未启用,无法保存密码")
		return
	}
	id, err := s.store.CreateEmailAccount(r.Context(), in.toAccount(""), enc, wc.UserID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "email_account.created", "email_account", id, nil)
	acc, err := s.store.GetEmailAccount(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, acc)
}

func (s *Server) updateEmailAccount(w http.ResponseWriter, r *http.Request, wc wsContext) {
	id := r.PathValue("id")
	var in emailAccountInput
	if !decodeJSON(w, r, &in) {
		return
	}
	enc, ok := s.encryptSecret(in.Password)
	if !ok {
		writeError(w, r, http.StatusServiceUnavailable, "secret_unconfigured", "密钥服务未启用")
		return
	}
	if err := s.store.UpdateEmailAccount(r.Context(), in.toAccount(id), enc, wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "email_account.updated", "email_account", id, nil)
	acc, err := s.store.GetEmailAccount(r.Context(), id)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, acc)
}

func (s *Server) deleteEmailAccount(w http.ResponseWriter, r *http.Request, wc wsContext) {
	id := r.PathValue("id")
	if err := s.store.DeleteEmailAccount(r.Context(), id); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "email_account.deleted", "email_account", id, nil)
	writeData(w, r, map[string]any{"id": id, "deleted": true})
}

// --- identities ---

func (s *Server) listEmailIdentities(w http.ResponseWriter, r *http.Request, wc wsContext) {
	items, err := s.store.ListEmailIdentities(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{"items": items})
}

type emailIdentityInput struct {
	AccountID    string `json:"accountId"`
	IdentityName string `json:"identityName"`
	FromEmail    string `json:"fromEmail"`
	FromName     string `json:"fromName"`
	ReplyToEmail string `json:"replyToEmail"`
	Status       string `json:"status"`
	Remark       string `json:"remark"`
}

func (in emailIdentityInput) toIdentity(id string) store.EmailIdentity {
	status := in.Status
	if status != "enabled" && status != "disabled" {
		status = "enabled"
	}
	return store.EmailIdentity{
		ID: id, AccountID: in.AccountID, IdentityName: strings.TrimSpace(in.IdentityName), FromEmail: strings.TrimSpace(in.FromEmail),
		FromName: strings.TrimSpace(in.FromName), ReplyToEmail: strings.TrimSpace(in.ReplyToEmail), Status: status, Remark: in.Remark,
	}
}

func (s *Server) createEmailIdentity(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in emailIdentityInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.AccountID) == "" || strings.TrimSpace(in.IdentityName) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "所属账号和身份名称不能为空")
		return
	}
	id, err := s.store.CreateEmailIdentity(r.Context(), in.toIdentity(""), wc.UserID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "email_identity.created", "email_identity", id, nil)
	writeData(w, r, map[string]any{"id": id})
}

func (s *Server) updateEmailIdentity(w http.ResponseWriter, r *http.Request, wc wsContext) {
	id := r.PathValue("id")
	var in emailIdentityInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if err := s.store.UpdateEmailIdentity(r.Context(), in.toIdentity(id), wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "email_identity.updated", "email_identity", id, nil)
	writeData(w, r, map[string]any{"id": id})
}

func (s *Server) deleteEmailIdentity(w http.ResponseWriter, r *http.Request, wc wsContext) {
	id := r.PathValue("id")
	if err := s.store.DeleteEmailIdentity(r.Context(), id); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "email_identity.deleted", "email_identity", id, nil)
	writeData(w, r, map[string]any{"id": id, "deleted": true})
}

// --- templates ---

func (s *Server) listEmailTemplates(w http.ResponseWriter, r *http.Request, wc wsContext) {
	items, err := s.store.ListEmailTemplates(r.Context())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, map[string]any{"items": items})
}

type emailTemplateInput struct {
	AccountID       string `json:"accountId"`
	IdentityID      string `json:"identityId"`
	Scene           string `json:"scene"`
	Subject         string `json:"subject"`
	Body            string `json:"body"`
	CodeVariable    string `json:"codeVariable"`
	CodeTTLSeconds  int    `json:"codeTtlSeconds"`
	DailyLimit      int    `json:"dailyLimit"`
	IntervalSeconds int    `json:"intervalSeconds"`
	Status          string `json:"status"`
	Remark          string `json:"remark"`
}

func (in emailTemplateInput) toTemplate(id string) store.EmailTemplate {
	status := in.Status
	if status != "enabled" && status != "disabled" {
		status = "enabled"
	}
	codeVar := strings.TrimSpace(in.CodeVariable)
	if codeVar == "" {
		codeVar = "code"
	}
	return store.EmailTemplate{
		ID: id, AccountID: in.AccountID, IdentityID: strings.TrimSpace(in.IdentityID), Scene: strings.TrimSpace(in.Scene),
		Subject: in.Subject, Body: in.Body, CodeVariable: codeVar, CodeTTLSeconds: in.CodeTTLSeconds,
		DailyLimit: in.DailyLimit, IntervalSeconds: in.IntervalSeconds, Status: status, Remark: in.Remark,
	}
}

func (s *Server) createEmailTemplate(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in emailTemplateInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.AccountID) == "" || strings.TrimSpace(in.Scene) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "所属账号和场景不能为空")
		return
	}
	id, err := s.store.CreateEmailTemplate(r.Context(), in.toTemplate(""), wc.UserID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "email_template.created", "email_template", id, nil)
	writeData(w, r, map[string]any{"id": id})
}

func (s *Server) updateEmailTemplate(w http.ResponseWriter, r *http.Request, wc wsContext) {
	id := r.PathValue("id")
	var in emailTemplateInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if err := s.store.UpdateEmailTemplate(r.Context(), in.toTemplate(id), wc.UserID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "email_template.updated", "email_template", id, nil)
	writeData(w, r, map[string]any{"id": id})
}

func (s *Server) deleteEmailTemplate(w http.ResponseWriter, r *http.Request, wc wsContext) {
	id := r.PathValue("id")
	if err := s.store.DeleteEmailTemplate(r.Context(), id); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "email_template.deleted", "email_template", id, nil)
	writeData(w, r, map[string]any{"id": id, "deleted": true})
}
