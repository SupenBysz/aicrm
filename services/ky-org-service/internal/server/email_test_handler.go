package server

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/smtp"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/store"
)

type emailTestInput struct {
	TemplateID string `json:"templateId"`
	ToEmail    string `json:"toEmail"`
}

type emailTestResult struct {
	OK           bool   `json:"ok"`
	LatencyMs    int64  `json:"latencyMs"`
	ErrorMessage string `json:"errorMessage,omitempty"`
}

func (s *Server) testEmailTemplate(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in emailTestInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.ToEmail) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "请输入测试收件邮箱")
		return
	}
	tpl, err := s.store.GetEmailTemplate(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	acc, err := s.store.GetEmailAccount(r.Context(), tpl.AccountID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	result := s.runEmailTest(r.Context(), acc, tpl, strings.TrimSpace(in.ToEmail))
	status := "failed"
	if result.OK {
		status = "success"
	}
	_ = s.store.RecordEmailTemplateTest(r.Context(), tpl.ID, status, result.ErrorMessage)
	_ = s.store.RecordEmailAccountTest(r.Context(), acc.ID, status, result.ErrorMessage)
	s.audit(r.Context(), r, wc, "email_template.tested", "email_template", tpl.ID, map[string]any{"ok": result.OK})
	writeData(w, r, result)
}

func (s *Server) runEmailTest(ctx context.Context, acc store.EmailAccount, tpl store.EmailTemplate, to string) emailTestResult {
	if acc.Status != "enabled" {
		return emailTestResult{ErrorMessage: "邮件账号已停用"}
	}
	if acc.Host == "" || acc.Username == "" || acc.PasswordEncrypted == "" {
		return emailTestResult{ErrorMessage: "请先配置 SMTP Host / 用户名 / 密码"}
	}
	if s.cipher == nil {
		return emailTestResult{ErrorMessage: "密钥服务未启用,无法测试"}
	}
	password, err := s.cipher.Decrypt(acc.PasswordEncrypted)
	if err != nil {
		return emailTestResult{ErrorMessage: "密码解密失败,请重新配置"}
	}

	fromEmail := acc.FromEmail
	fromName := acc.FromName
	for _, id := range []string{tpl.IdentityID} {
		if id == "" {
			continue
		}
		ids, _ := s.store.ListEmailIdentities(ctx)
		for _, idn := range ids {
			if idn.ID == id {
				if idn.FromEmail != "" {
					fromEmail = idn.FromEmail
				}
				if idn.FromName != "" {
					fromName = idn.FromName
				}
			}
		}
	}
	if fromEmail == "" {
		fromEmail = acc.Username
	}
	subject := defaultStr(tpl.Subject, "KyaiCRM 测试邮件")
	body := defaultStr(tpl.Body, "这是一封来自 KyaiCRM 的测试邮件。验证码:123456")

	start := time.Now()
	err = sendSMTP(acc, password, fromEmail, fromName, to, subject, body)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return emailTestResult{LatencyMs: latency, ErrorMessage: err.Error()}
	}
	return emailTestResult{OK: true, LatencyMs: latency}
}

func sendSMTP(acc store.EmailAccount, password, fromEmail, fromName, to, subject, body string) error {
	addr := fmt.Sprintf("%s:%d", acc.Host, acc.Port)
	auth := smtp.PlainAuth("", acc.Username, password, acc.Host)
	from := fromEmail
	if fromName != "" {
		from = fmt.Sprintf("%s <%s>", fromName, fromEmail)
	}
	msg := []byte("From: " + from + "\r\n" +
		"To: " + to + "\r\n" +
		"Subject: " + subject + "\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: text/plain; charset=UTF-8\r\n\r\n" +
		body + "\r\n")

	if acc.Encryption == "ssl" {
		// Implicit TLS (e.g. port 465).
		conn, err := tls.DialWithDialer(&net.Dialer{Timeout: 15 * time.Second}, "tcp", addr, &tls.Config{ServerName: acc.Host})
		if err != nil {
			return fmt.Errorf("TLS 连接失败:%s", err.Error())
		}
		defer conn.Close()
		c, err := smtp.NewClient(conn, acc.Host)
		if err != nil {
			return fmt.Errorf("SMTP 握手失败:%s", err.Error())
		}
		defer c.Close()
		return deliverSMTP(c, auth, fromEmail, to, msg)
	}

	// Plain or STARTTLS (e.g. port 587/25).
	c, err := smtp.Dial(addr)
	if err != nil {
		return fmt.Errorf("连接失败:%s", err.Error())
	}
	defer c.Close()
	if acc.Encryption == "tls" {
		if err := c.StartTLS(&tls.Config{ServerName: acc.Host}); err != nil {
			return fmt.Errorf("STARTTLS 失败:%s", err.Error())
		}
	}
	return deliverSMTP(c, auth, fromEmail, to, msg)
}

func deliverSMTP(c *smtp.Client, auth smtp.Auth, from, to string, msg []byte) error {
	if err := c.Auth(auth); err != nil {
		return fmt.Errorf("认证失败:%s", err.Error())
	}
	if err := c.Mail(from); err != nil {
		return fmt.Errorf("发件人设置失败:%s", err.Error())
	}
	if err := c.Rcpt(to); err != nil {
		return fmt.Errorf("收件人设置失败:%s", err.Error())
	}
	wc, err := c.Data()
	if err != nil {
		return fmt.Errorf("数据通道失败:%s", err.Error())
	}
	if _, err := wc.Write(msg); err != nil {
		return fmt.Errorf("写入失败:%s", err.Error())
	}
	if err := wc.Close(); err != nil {
		return fmt.Errorf("发送失败:%s", err.Error())
	}
	_ = c.Quit()
	return nil
}
