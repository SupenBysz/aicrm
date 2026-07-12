package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type loginScriptGenerateInput struct {
	Platform         string          `json:"platform"`
	Purpose          string          `json:"purpose"`
	PageFingerprint  string          `json:"pageFingerprint"`
	URL              string          `json:"url"`
	Title            string          `json:"title"`
	ModelID          string          `json:"modelId"`
	GenerationReason string          `json:"generationReason"`
	Snapshot         json.RawMessage `json:"snapshot"`
}

type loginScriptGenerateResult struct {
	ModelID          string          `json:"modelId"`
	ModelType        string          `json:"modelType"`
	DSL              json.RawMessage `json:"dsl"`
	PromptTokens     int             `json:"promptTokens"`
	CompletionTokens int             `json:"completionTokens"`
	TotalTokens      int             `json:"totalTokens"`
	UsageSource      string          `json:"usageSource"`
	GenerationReason string          `json:"generationReason"`
}

const (
	loginScriptGenerateTimeout = 45 * time.Second
	loginScriptMaxTokens       = 1600
)

func (s *Server) internalGenerateLoginScript(w http.ResponseWriter, r *http.Request) {
	if s.cfg.InternalToken == "" || r.Header.Get("X-KY-Internal-Token") != s.cfg.InternalToken {
		writeError(w, r, http.StatusUnauthorized, "unauthorized", "内部服务令牌无效")
		return
	}
	if s.store == nil {
		writeError(w, r, http.StatusServiceUnavailable, "service_unavailable", "数据库未连接")
		return
	}
	if s.cipher == nil {
		writeError(w, r, http.StatusServiceUnavailable, "ai_secret_unconfigured", "密钥服务未启用")
		return
	}
	var in loginScriptGenerateInput
	if !decodeJSON(w, r, &in) {
		return
	}
	normalizeLoginScriptGenerateInput(&in)
	if !validStatus(in.Platform, "douyin", "kuaishou", "xiaohongshu") || !validLoginScriptPurpose(in.Purpose) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "平台或脚本用途无效")
		return
	}
	if len(in.Snapshot) == 0 || len(in.Snapshot) > 2_500_000 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "页面快照无效")
		return
	}

	modelID, err := s.resolveGenerationModelID(r.Context(), in.ModelID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	if modelID == "" {
		writeError(w, r, http.StatusServiceUnavailable, "service_unavailable", "未配置可用默认多模态或对话模型")
		return
	}
	m, err := s.store.GetModel(r.Context(), modelID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	if m.Status != "enabled" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "指定模型未启用")
		return
	}
	p, err := s.store.GetProvider(r.Context(), m.ProviderID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	if p.Status != "enabled" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "指定模型供应商未启用")
		return
	}
	if p.APIKeyEncrypted == "" {
		writeError(w, r, http.StatusServiceUnavailable, "service_unavailable", "指定模型供应商未配置 API 密钥")
		return
	}
	apiKey, err := s.cipher.Decrypt(p.APIKeyEncrypted)
	if err != nil {
		writeError(w, r, http.StatusServiceUnavailable, "service_unavailable", "模型供应商密钥解密失败")
		return
	}

	result, err := generateLoginScriptWithModel(r.Context(), p.BaseURL, apiKey, m.ModelKey, m.ModelType, in)
	if err != nil {
		writeError(w, r, http.StatusBadGateway, "provider_error", err.Error())
		return
	}
	result.ModelID = m.ID
	result.ModelType = m.ModelType
	if result.GenerationReason == "" {
		result.GenerationReason = in.GenerationReason
	}
	writeData(w, r, result)
}

func (s *Server) resolveGenerationModelID(ctx context.Context, requested string) (string, error) {
	if requested != "" {
		return requested, nil
	}
	settings, err := s.store.GetDefaultModels(ctx)
	if err != nil {
		return "", err
	}
	if id := strings.TrimSpace(settings["default_multimodal_model"]); id != "" {
		return id, nil
	}
	return strings.TrimSpace(settings["default_chat_model"]), nil
}

func normalizeLoginScriptGenerateInput(in *loginScriptGenerateInput) {
	in.Platform = strings.TrimSpace(in.Platform)
	in.Purpose = strings.TrimSpace(in.Purpose)
	in.PageFingerprint = strings.TrimSpace(in.PageFingerprint)
	in.URL = strings.TrimSpace(in.URL)
	in.Title = strings.TrimSpace(in.Title)
	in.ModelID = strings.TrimSpace(in.ModelID)
	in.GenerationReason = strings.TrimSpace(in.GenerationReason)
	if in.Purpose == "" {
		in.Purpose = "qr_login_prepare"
	}
	if in.GenerationReason == "" {
		in.GenerationReason = defaultLoginScriptGenerationReason(in.Purpose)
	}
}

func validLoginScriptPurpose(value string) bool {
	return validStatus(value, "qr_login_prepare", "qr_login_refresh", "account_detect", "session_check")
}

func defaultLoginScriptGenerationReason(purpose string) string {
	if purpose == "qr_login_refresh" {
		return "refresh_script_missing"
	}
	if purpose == "account_detect" {
		return "detect_script_missing"
	}
	return "no_active_script"
}

func generateLoginScriptWithModel(ctx context.Context, baseURL, apiKey, modelKey, modelType string, in loginScriptGenerateInput) (loginScriptGenerateResult, error) {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if base == "" {
		return loginScriptGenerateResult{}, fmt.Errorf("供应商未配置 Base URL")
	}
	prompt := loginScriptPrompt(in)
	payload := map[string]any{
		"model":       modelKey,
		"messages":    buildLoginScriptMessages(prompt, modelType, in.Snapshot),
		"max_tokens":  loginScriptMaxTokens,
		"temperature": 0.1,
		"stream":      false,
	}
	body, _ := json.Marshal(payload)
	reqCtx, cancel := context.WithTimeout(ctx, loginScriptGenerateTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, base+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return loginScriptGenerateResult{}, fmt.Errorf("请求构造失败：%w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := (&http.Client{Timeout: loginScriptGenerateTimeout}).Do(req)
	if err != nil {
		if reqCtx.Err() == context.DeadlineExceeded {
			return loginScriptGenerateResult{}, fmt.Errorf("请求超时")
		}
		return loginScriptGenerateResult{}, fmt.Errorf("请求供应商失败：%w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return loginScriptGenerateResult{}, errors.New(extractProviderError(raw, resp.StatusCode))
	}
	content, promptTokens, completionTokens, totalTokens := parseChatCompletionContent(raw)
	dsl, err := extractJSONDSL(content, in.Purpose)
	if err != nil {
		return loginScriptGenerateResult{}, err
	}
	usageSource := "provider"
	if totalTokens == 0 {
		usageSource = "estimated"
		promptTokens, completionTokens = estimateTokens(prompt), estimateTokens(content)
		totalTokens = promptTokens + completionTokens
	}
	return loginScriptGenerateResult{
		DSL:              dsl,
		PromptTokens:     promptTokens,
		CompletionTokens: completionTokens,
		TotalTokens:      totalTokens,
		UsageSource:      usageSource,
	}, nil
}

func buildLoginScriptMessages(prompt, modelType string, snapshot json.RawMessage) []map[string]any {
	if modelType == "vision" && os.Getenv("AICRM_ALLOW_AI_LOGIN_SCREENSHOTS") == "1" {
		imageURL := snapshotImageURL(snapshot)
		if imageURL != "" {
			return []map[string]any{
				{
					"role": "user",
					"content": []map[string]any{
						{"type": "text", "text": prompt},
						{"type": "image_url", "image_url": map[string]any{"url": imageURL}},
					},
				},
			}
		}
	}
	return []map[string]any{{"role": "user", "content": prompt}}
}

func loginScriptPrompt(in loginScriptGenerateInput) string {
	snapshot := stripSnapshotImage(in.Snapshot)
	return fmt.Sprintf(`你是 AiCRM Desktop 受控浏览器登录脚本生成器。

目标：为 %s 平台生成用途为 %s 的受限 DSL JSON。

硬性规则：
- 只能输出 JSON，不要 Markdown，不要解释。
- JSON 必须形如 {"version":1,"purpose":"%s","steps":[...]}。
- 只允许动作：clickText、clickSelector、wait、waitForElement、captureElement、readText、navigateAllowedUrl。
- 字段名必须严格使用 DSL 约定：wait 使用 {"action":"wait","ms":1000}，不要使用 duration；waitForElement/clickSelector/clickText/captureElement 使用 timeoutMs，不能使用 timeout。
- 不得读取或请求 Cookie、Token、localStorage、sessionStorage、IndexedDB、密码、验证码或其他登录凭据。
- 不得生成 readStorage 或 readIndexedDB 动作；账号身份只能来自可见页面文本、稳定主页 URL 或平台公开账号字段。
- 不允许生成任意 JavaScript。
- 如果是 qr_login_prepare，最终必须尽量 captureElement，并将 resultKey 设置为 "qrCodeDataUrl"。
- 如果是 qr_login_refresh，必须先寻找“刷新二维码/二维码已失效/重新获取/reload/refresh”等可见入口并点击，等待二维码更新后 captureElement，resultKey 设置为 "qrCodeDataUrl"。
- 优先使用快照里 stableKey 非空的元素。stableKey 是页面公开且唯一的稳定元素键；将它写入步骤的 elementKey 字段。可同时保留同一元素的 selector 作为受控兜底。
- 稳定键优先级为 data-testid/data-test/data-e2e/data-qa/data-cy、id、name、aria-label；严禁使用 el_序号、CSS class 哈希、:nth-of-type、坐标作为首选定位。
- 只有 stableKey 不存在或验证失败时，才使用快照中真实存在的 selector；不要虚构 selector。
- 如果已有二维码候选 stableKey，优先直接 waitForElement + captureElement；只有页面不是扫码登录模式时才先 clickText 切换“扫码登录”。
- 如果是 account_detect，目标是让页面进入已登录账号主页或可识别账号身份的页面，并通过 readText 读取账号身份相关数据。
- account_detect 的 resultKey 优先使用 "identityKey"、"platformUid"、"displayName"、"nickname"、"avatarUrl"、"homeUrl"、"profileText" 这些约定名称。
- 不要把 sessionid、token、csrf、passport、ticket、cookie 等会话凭据作为 identityKey 或 platformUid；identityKey 必须是账号稳定标识，例如 uid/userId/secUid/profileUrl 中的账号 ID。
- account_detect 不需要 captureElement，也不要截取头像或二维码。
- 如果需要切换扫码登录，优先 clickText 使用页面上已有的“扫码登录/二维码/扫码”等文本。
- elementKey 必须来自页面快照中的 stableKey；selector 必须来自页面快照中的 selector，不能虚构。

页面信息：
URL: %s
Title: %s
Fingerprint: %s
GenerationReason: %s

脱敏页面快照 JSON：
%s`, in.Platform, in.Purpose, in.Purpose, in.URL, in.Title, in.PageFingerprint, in.GenerationReason, string(snapshot))
}

func stripSnapshotImage(raw json.RawMessage) json.RawMessage {
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		return json.RawMessage(`{}`)
	}
	value = sanitizeLoginScriptSnapshot(value)
	out, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return out
}

func sanitizeLoginScriptSnapshot(value map[string]any) map[string]any {
	blocked := map[string]struct{}{
		"authorization": {}, "browserpartition": {}, "cookie": {}, "cookies": {},
		"credential": {}, "credentials": {}, "indexeddb": {}, "localstorage": {},
		"password": {}, "screenshotdataurl": {}, "secret": {}, "sensitivecontext": {},
		"sessionid": {}, "sessionstorage": {}, "storage": {}, "token": {}, "tokens": {}, "uidtt": {},
	}
	var sanitize func(any, int) any
	sanitize = func(input any, depth int) any {
		if depth > 12 {
			return nil
		}
		switch typed := input.(type) {
		case map[string]any:
			out := make(map[string]any, len(typed))
			for key, child := range typed {
				normalized := strings.ToLower(strings.NewReplacer("_", "", "-", "", ".", "").Replace(strings.TrimSpace(key)))
				if _, denied := blocked[normalized]; denied || strings.Contains(normalized, "accesstoken") || strings.Contains(normalized, "refreshtoken") {
					continue
				}
				if item := sanitize(child, depth+1); item != nil {
					out[key] = item
				}
			}
			return out
		case []any:
			out := make([]any, 0, len(typed))
			for _, child := range typed {
				if item := sanitize(child, depth+1); item != nil {
					out = append(out, item)
				}
			}
			return out
		case string, bool, float64, nil:
			return typed
		default:
			return nil
		}
	}
	output, _ := sanitize(value, 0).(map[string]any)
	if output == nil {
		return map[string]any{}
	}
	return output
}

func snapshotImageURL(raw json.RawMessage) string {
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	url, _ := value["screenshotDataUrl"].(string)
	if strings.HasPrefix(url, "data:image/") {
		return url
	}
	return ""
}

func parseChatCompletionContent(raw []byte) (content string, promptTokens, completionTokens, totalTokens int) {
	var env struct {
		Choices []struct {
			Message struct {
				Content          string `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
				Reasoning        string `json:"reasoning"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
	}
	_ = json.Unmarshal(raw, &env)
	if len(env.Choices) > 0 {
		msg := env.Choices[0].Message
		for _, candidate := range []string{msg.Content, msg.ReasoningContent, msg.Reasoning} {
			if text := strings.TrimSpace(candidate); text != "" {
				content = text
				break
			}
		}
	}
	return content, env.Usage.PromptTokens, env.Usage.CompletionTokens, env.Usage.TotalTokens
}

func extractJSONDSL(content string, expectedPurpose string) (json.RawMessage, error) {
	text := strings.TrimSpace(content)
	text = strings.TrimPrefix(text, "```json")
	text = strings.TrimPrefix(text, "```")
	text = strings.TrimSuffix(text, "```")
	text = strings.TrimSpace(text)
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end < start {
		return nil, fmt.Errorf("模型未返回 JSON 脚本")
	}
	raw := []byte(text[start : end+1])
	var value struct {
		Version int               `json:"version"`
		Purpose string            `json:"purpose"`
		Steps   []json.RawMessage `json:"steps"`
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("模型返回 JSON 无法解析")
	}
	if value.Version != 1 || value.Purpose == "" || len(value.Steps) == 0 {
		return nil, fmt.Errorf("模型返回脚本结构无效")
	}
	if value.Purpose != expectedPurpose {
		return nil, fmt.Errorf("模型返回脚本用途不匹配")
	}
	for _, rawStep := range value.Steps {
		var step struct {
			Action string `json:"action"`
		}
		if err := json.Unmarshal(rawStep, &step); err != nil || strings.TrimSpace(step.Action) == "" {
			return nil, fmt.Errorf("模型返回脚本步骤无效")
		}
		if step.Action == "readStorage" || step.Action == "readIndexedDB" {
			return nil, fmt.Errorf("模型返回脚本包含禁止的敏感读取动作")
		}
		if !validGeneratedLoginScriptAction(step.Action) {
			return nil, fmt.Errorf("模型返回脚本包含不支持的动作")
		}
	}
	return raw, nil
}

func validGeneratedLoginScriptAction(action string) bool {
	switch action {
	case "clickText", "clickSelector", "wait", "waitForElement", "captureElement", "readText", "navigateAllowedUrl":
		return true
	default:
		return false
	}
}

func estimateTokens(text string) int {
	runes := []rune(text)
	if len(runes) == 0 {
		return 0
	}
	return len(runes)/3 + 1
}
