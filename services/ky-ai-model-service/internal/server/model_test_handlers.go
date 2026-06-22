package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Model connectivity test. AI scope stays limited to provider/model configuration:
// this endpoint only validates that the configured credential + Base URL + model key
// + protocol actually reach the upstream provider. It performs a single, minimal
// request and never persists the prompt/response. All Phase-1 providers use the
// OpenAI-compatible protocol (chat/completions, embeddings), so one adapter covers all.

type modelTestInput struct {
	Prompt string `json:"prompt"`
}

type modelTestResult struct {
	OK           bool   `json:"ok"`
	LatencyMs    int64  `json:"latencyMs"`
	HTTPStatus   int    `json:"httpStatus"`
	SampleOutput string `json:"sampleOutput"`
	PromptTokens int    `json:"promptTokens"`
	TotalTokens  int    `json:"totalTokens"`
	ErrorCode    string `json:"errorCode,omitempty"`
	ErrorMessage string `json:"errorMessage,omitempty"`
}

const (
	defaultTestPrompt   = "你好，请用一句话介绍你自己。"
	modelTestTimeout    = 20 * time.Second
	sampleOutputMaxRune = 600
	testMaxTokens       = 256
)

func (s *Server) testModel(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in modelTestInput
	if r.ContentLength != 0 {
		if !decodeJSON(w, r, &in) {
			return
		}
	}
	prompt := strings.TrimSpace(in.Prompt)
	if prompt == "" {
		prompt = defaultTestPrompt
	}

	if s.cipher == nil {
		writeError(w, r, http.StatusServiceUnavailable, "ai_secret_unconfigured", "密钥服务未启用，无法测试")
		return
	}

	m, err := s.store.GetModel(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	if m.Status != "enabled" {
		writeData(w, r, modelTestResult{ErrorCode: "model_disabled", ErrorMessage: "模型已停用，无法测试"})
		return
	}
	p, err := s.store.GetProvider(r.Context(), m.ProviderID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	if p.Status != "enabled" {
		writeData(w, r, modelTestResult{ErrorCode: "provider_disabled", ErrorMessage: "供应商已停用，无法测试"})
		return
	}
	if p.APIKeyEncrypted == "" {
		writeData(w, r, modelTestResult{ErrorCode: "api_key_missing", ErrorMessage: "供应商未配置 API 密钥，请先在供应商管理中配置后再测试"})
		return
	}
	apiKey, err := s.cipher.Decrypt(p.APIKeyEncrypted)
	if err != nil {
		writeData(w, r, modelTestResult{ErrorCode: "api_key_invalid", ErrorMessage: "API 密钥解密失败，请重新配置密钥"})
		return
	}

	result := probeModel(r.Context(), p.BaseURL, apiKey, m.ModelKey, m.ModelType, prompt)
	// Audit the attempt — outcome only, never the credential / prompt / response.
	s.audit(r.Context(), r, wc, "ai_model.tested", "ai_model", m.ID, map[string]any{
		"ok": result.OK, "latencyMs": result.LatencyMs, "modelType": m.ModelType, "errorCode": result.ErrorCode,
	})
	writeData(w, r, result)
}

// probeModel issues one OpenAI-compatible request and reports a structured result.
// It never returns a non-2xx as an HTTP error to our own client — provider-side
// failures are part of the test result the operator wants to see.
func probeModel(ctx context.Context, baseURL, apiKey, modelKey, modelType, prompt string) modelTestResult {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if base == "" {
		return modelTestResult{ErrorCode: "base_url_missing", ErrorMessage: "供应商未配置 Base URL，无法测试"}
	}

	var url string
	var payload map[string]any
	if modelType == "embedding" {
		url = base + "/embeddings"
		payload = map[string]any{"model": modelKey, "input": prompt}
	} else {
		url = base + "/chat/completions"
		payload = map[string]any{
			"model":      modelKey,
			"messages":   []map[string]string{{"role": "user", "content": prompt}},
			"max_tokens": testMaxTokens,
			"stream":     false,
		}
	}
	body, _ := json.Marshal(payload)

	reqCtx, cancel := context.WithTimeout(ctx, modelTestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return modelTestResult{ErrorCode: "request_build_failed", ErrorMessage: "请求构造失败：" + err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: modelTestTimeout}
	start := time.Now()
	resp, err := client.Do(req)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		code, msg := "network_error", "请求供应商失败："+err.Error()
		if reqCtx.Err() == context.DeadlineExceeded {
			code, msg = "timeout", fmt.Sprintf("请求超时（>%s）", modelTestTimeout)
		}
		return modelTestResult{LatencyMs: latency, ErrorCode: code, ErrorMessage: msg}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return modelTestResult{
			LatencyMs: latency, HTTPStatus: resp.StatusCode,
			ErrorCode: "provider_error", ErrorMessage: extractProviderError(raw, resp.StatusCode),
		}
	}

	sample, promptTokens, totalTokens := parseOpenAIResponse(raw, modelType)
	return modelTestResult{
		OK: true, LatencyMs: latency, HTTPStatus: resp.StatusCode,
		SampleOutput: sample, PromptTokens: promptTokens, TotalTokens: totalTokens,
	}
}

func extractProviderError(raw []byte, status int) string {
	var env struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(raw, &env)
	if msg := strings.TrimSpace(env.Error.Message); msg != "" {
		return msg
	}
	if msg := strings.TrimSpace(env.Message); msg != "" {
		return msg
	}
	if body := strings.TrimSpace(string(raw)); body != "" {
		return truncateRunes(body, sampleOutputMaxRune)
	}
	return fmt.Sprintf("供应商返回 HTTP %d", status)
}

func parseOpenAIResponse(raw []byte, modelType string) (sample string, promptTokens, totalTokens int) {
	var env struct {
		Choices []struct {
			Message struct {
				Content          string `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
				Reasoning        string `json:"reasoning"`
			} `json:"message"`
		} `json:"choices"`
		Data []struct {
			Embedding []float64 `json:"embedding"`
		} `json:"data"`
		Usage struct {
			PromptTokens int `json:"prompt_tokens"`
			TotalTokens  int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return truncateRunes(strings.TrimSpace(string(raw)), sampleOutputMaxRune), 0, 0
	}
	promptTokens, totalTokens = env.Usage.PromptTokens, env.Usage.TotalTokens
	if modelType == "embedding" {
		if len(env.Data) > 0 {
			return fmt.Sprintf("成功返回 %d 维向量", len(env.Data[0].Embedding)), promptTokens, totalTokens
		}
		return "嵌入接口返回成功。", promptTokens, totalTokens
	}
	if len(env.Choices) > 0 {
		msg := env.Choices[0].Message
		// Reasoning models (e.g. GLM, DeepSeek-R1) often put the answer in
		// reasoning_content / reasoning and leave content empty — fall back to those.
		for _, candidate := range []string{msg.Content, msg.ReasoningContent, msg.Reasoning} {
			if text := strings.TrimSpace(candidate); text != "" {
				return truncateRunes(text, sampleOutputMaxRune), promptTokens, totalTokens
			}
		}
	}
	return "模型返回成功，但响应内容为空。", promptTokens, totalTokens
}

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}
