package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/store"
)

const aiModelRequestTimeout = 60 * time.Second

func (s *Server) generateLoginScriptWithAI(ctx context.Context, platform string, in store.LoginScriptGenerateInput) (store.GeneratedLoginScript, error) {
	if strings.TrimSpace(s.cfg.InternalToken) == "" {
		return store.GeneratedLoginScript{}, fmt.Errorf("内部服务令牌未配置")
	}
	base := strings.TrimRight(strings.TrimSpace(s.cfg.AIModelBaseURL), "/")
	if base == "" {
		return store.GeneratedLoginScript{}, fmt.Errorf("AI 模型服务地址未配置")
	}
	body, _ := json.Marshal(map[string]any{
		"platform":         platform,
		"purpose":          in.Purpose,
		"pageFingerprint":  in.PageFingerprint,
		"url":              in.URL,
		"title":            in.Title,
		"modelId":          in.ModelID,
		"generationReason": in.GenerationReason,
		"snapshot":         json.RawMessage(in.Snapshot),
	})
	reqCtx, cancel := context.WithTimeout(ctx, aiModelRequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, base+"/internal/v1/ai-models/login-script/generate", bytes.NewReader(body))
	if err != nil {
		return store.GeneratedLoginScript{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-KY-Internal-Token", s.cfg.InternalToken)

	resp, err := (&http.Client{Timeout: aiModelRequestTimeout}).Do(req)
	if err != nil {
		return store.GeneratedLoginScript{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return store.GeneratedLoginScript{}, errors.New(extractServiceError(raw, resp.StatusCode))
	}
	var env struct {
		Data store.GeneratedLoginScript `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return store.GeneratedLoginScript{}, err
	}
	if len(env.Data.DSL) == 0 {
		return store.GeneratedLoginScript{}, fmt.Errorf("AI 服务未返回脚本")
	}
	return env.Data, nil
}

func extractServiceError(raw []byte, status int) string {
	var env struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &env)
	if msg := strings.TrimSpace(env.Error.Message); msg != "" {
		return msg
	}
	body := strings.TrimSpace(string(raw))
	if body != "" {
		if len([]rune(body)) > 300 {
			return string([]rune(body)[:300])
		}
		return body
	}
	return fmt.Sprintf("AI 服务返回 HTTP %d", status)
}
