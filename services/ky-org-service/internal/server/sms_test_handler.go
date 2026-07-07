package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-org-service/internal/store"
)

type smsTestInput struct {
	TemplateID  string `json:"templateId"`
	PhoneNumber string `json:"phoneNumber"`
}

type smsTestResult struct {
	OK           bool   `json:"ok"`
	LatencyMs    int64  `json:"latencyMs"`
	ErrorMessage string `json:"errorMessage,omitempty"`
}

// testSMSTemplate sends one real SMS via the template's account (aliyun) to verify
// the credential + signature + template chain. The verification code is a fixed test value.
func (s *Server) testSMSTemplate(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in smsTestInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.PhoneNumber) == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "请输入测试手机号")
		return
	}
	tpl, err := s.store.GetSMSTemplate(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	acc, err := s.store.GetSMSAccount(r.Context(), tpl.AccountID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	result := s.runSMSTest(r.Context(), acc, tpl, strings.TrimSpace(in.PhoneNumber))
	status := "failed"
	if result.OK {
		status = "success"
	}
	_ = s.store.RecordSMSTemplateTest(r.Context(), tpl.ID, status, result.ErrorMessage)
	_ = s.store.RecordSMSAccountTest(r.Context(), acc.ID, status, result.ErrorMessage)
	s.audit(r.Context(), r, wc, "sms_template.tested", "sms_template", tpl.ID, map[string]any{"ok": result.OK})
	writeData(w, r, result)
}

func (s *Server) runSMSTest(ctx context.Context, acc store.SMSAccount, tpl store.SMSTemplate, phone string) smsTestResult {
	if acc.Status != "enabled" {
		return smsTestResult{ErrorMessage: "短信账号已停用"}
	}
	if acc.AccessKeyID == "" || acc.SecretEncrypted == "" {
		return smsTestResult{ErrorMessage: "请先配置该账号的 AccessKey / Secret"}
	}
	if tpl.TemplateCode == "" {
		return smsTestResult{ErrorMessage: "请先为该场景模板配置阿里云模板 Code"}
	}
	if acc.ProviderKey != "aliyun" {
		return smsTestResult{ErrorMessage: "暂仅支持 aliyun 短信发送测试"}
	}
	if s.cipher == nil {
		return smsTestResult{ErrorMessage: "密钥服务未启用,无法测试"}
	}
	secret, err := s.cipher.Decrypt(acc.SecretEncrypted)
	if err != nil {
		return smsTestResult{ErrorMessage: "Secret 解密失败,请重新配置"}
	}
	// resolve signature: account default, else first enabled signature of the account.
	signName, err := s.resolveSMSSignName(ctx, acc)
	if err != nil {
		return smsTestResult{ErrorMessage: err.Error()}
	}

	codeVar := tpl.CodeVariable
	if codeVar == "" {
		codeVar = "code"
	}
	param, _ := json.Marshal(map[string]string{codeVar: "123456"})

	start := time.Now()
	err = aliyunSendSMS(ctx, acc.AccessKeyID, secret, acc.Region, phone, signName, tpl.TemplateCode, string(param))
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return smsTestResult{LatencyMs: latency, ErrorMessage: err.Error()}
	}
	return smsTestResult{OK: true, LatencyMs: latency}
}

func (s *Server) resolveSMSSignName(ctx context.Context, acc store.SMSAccount) (string, error) {
	sigs, err := s.store.ListSMSSignatures(ctx)
	if err != nil {
		return "", err
	}
	for _, sig := range sigs {
		if acc.DefaultSignatureID != "" && sig.ID == acc.DefaultSignatureID {
			return sig.SignatureName, nil
		}
	}
	for _, sig := range sigs {
		if sig.AccountID == acc.ID && sig.Status == "enabled" {
			return sig.SignatureName, nil
		}
	}
	return "", fmt.Errorf("该账号下没有可用的短信签名,请先配置签名")
}

// aliyunSendSMS sends one SMS via Aliyun dysmsapi (RPC, HMAC-SHA1 V1 signature, stdlib only).
func aliyunSendSMS(ctx context.Context, accessKeyID, accessKeySecret, region, phone, signName, templateCode, templateParam string) error {
	params := map[string]string{
		"AccessKeyId":      accessKeyID,
		"Action":           "SendSms",
		"Format":           "JSON",
		"RegionId":         defaultStr(region, "cn-hangzhou"),
		"SignatureMethod":  "HMAC-SHA1",
		"SignatureNonce":   newID("nonce"),
		"SignatureVersion": "1.0",
		"Timestamp":        time.Now().UTC().Format("2006-01-02T15:04:05Z"),
		"Version":          "2017-05-25",
		"PhoneNumbers":     phone,
		"SignName":         signName,
		"TemplateCode":     templateCode,
		"TemplateParam":    templateParam,
	}
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var canon strings.Builder
	for i, k := range keys {
		if i > 0 {
			canon.WriteString("&")
		}
		canon.WriteString(aliyunEncode(k))
		canon.WriteString("=")
		canon.WriteString(aliyunEncode(params[k]))
	}
	stringToSign := "GET&" + aliyunEncode("/") + "&" + aliyunEncode(canon.String())
	mac := hmac.New(sha1.New, []byte(accessKeySecret+"&"))
	mac.Write([]byte(stringToSign))
	signature := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	q := url.Values{}
	for k, v := range params {
		q.Set(k, v)
	}
	q.Set("Signature", signature)
	endpoint := "https://dysmsapi.aliyuncs.com/?" + q.Encode()

	reqCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return fmt.Errorf("请求构造失败:%s", err.Error())
	}
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("请求阿里云失败:%s", err.Error())
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var out struct {
		Code    string `json:"Code"`
		Message string `json:"Message"`
	}
	_ = json.Unmarshal(raw, &out)
	if out.Code == "OK" {
		return nil
	}
	if out.Message != "" {
		return fmt.Errorf("阿里云返回:%s(%s)", out.Message, out.Code)
	}
	return fmt.Errorf("阿里云返回 HTTP %d", resp.StatusCode)
}

// aliyunEncode implements Aliyun RPC percent-encoding (RFC3986 with +/*/%7E fixups).
func aliyunEncode(s string) string {
	e := url.QueryEscape(s)
	e = strings.ReplaceAll(e, "+", "%20")
	e = strings.ReplaceAll(e, "*", "%2A")
	e = strings.ReplaceAll(e, "%7E", "~")
	return e
}

func defaultStr(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}
