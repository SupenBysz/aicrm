package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-ai-model-service/internal/store"
)

const codexAuthProbeToken = "AICRM_CODEX_AUTH_OK"
const codexAuthProbePrompt = "只输出 " + codexAuthProbeToken + "，不要输出其他内容。"

func (s *Server) runExecutorWorker(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	sem := make(chan struct{}, 1)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		select {
		case sem <- struct{}{}:
		default:
			continue
		}

		task, ok, err := s.store.ClaimNextExecutorTask(ctx)
		if err != nil {
			<-sem
			log.Printf("codex executor worker claim failed: %v", err)
			continue
		}
		if !ok {
			<-sem
			continue
		}

		go func() {
			defer func() { <-sem }()
			s.executeCodexTask(ctx, task)
		}()
	}
}

func (s *Server) executeCodexTask(ctx context.Context, task store.ExecutorTask) {
	cfg, err := s.store.GetExecutorConfigByID(ctx, task.ExecutorID)
	if err != nil {
		s.failCodexTask(ctx, task.ID, "读取 Codex 执行器配置失败", err)
		return
	}
	if cfg.RuntimeType != "server" {
		_ = s.store.AppendExecutorEvent(ctx, task.ID, "executor.waiting", "warning", "任务等待客户端或远程执行器消费", map[string]any{
			"executorId":  cfg.ID,
			"runtimeType": cfg.RuntimeType,
		})
		return
	}
	authProbe := s.detectServerCodexAuthorization(ctx, cfg)
	if !authProbe.Authorized {
		_ = s.syncServerCodexAuthProbe(ctx, cfg.ID, authProbe)
		if authProbe.AuthStatus == "error" {
			s.failCodexTask(ctx, task.ID, "Codex 执行器真实执行探针失败", errors.New(authProbe.StatusText))
			return
		}
		s.failCodexTask(ctx, task.ID, "Codex 执行器未通过真实执行探针，请完成授权", nil)
		return
	}
	_ = s.syncServerCodexAuthProbe(ctx, cfg.ID, authProbe)

	timeout := time.Duration(cfg.TaskTimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 180 * time.Second
	}

	_ = s.store.AppendExecutorEvent(ctx, task.ID, "codex.starting", "info", "正在启动 Codex 执行器", map[string]any{
		"workspace": s.cfg.CodexWorkspace,
		"binary":    s.cfg.CodexBinary,
		"codexHome": authProbe.CodexHome,
	})
	_ = s.store.AppendExecutorRawLog(ctx, task.ID, "executor", "internal", "starting codex executor", map[string]any{
		"workspace": s.cfg.CodexWorkspace,
		"binary":    s.cfg.CodexBinary,
		"codexHome": authProbe.CodexHome,
	}, "正在启动 Codex 执行器")

	result := s.executeCodexTUIRun(ctx, task, cfg, authProbe, timeout)
	if result.TimedOut {
		_ = s.store.AppendExecutorEvent(ctx, task.ID, "codex.timeout", "error", "Codex 执行超时", map[string]any{"timeoutSeconds": cfg.TaskTimeoutSeconds})
		_ = s.store.AppendExecutorTerminalFrame(ctx, task.ID, "\r\n[AiCRM] Codex 执行超时\r\n", map[string]any{"type": "codex.timeout"})
		_ = s.store.CompleteExecutorTask(ctx, task.ID, "timeout", "Codex 执行超时")
		return
	}
	if result.Err != nil {
		s.failCodexTask(ctx, task.ID, "Codex TUI 执行失败", result.Err)
		return
	}

	_ = s.store.AppendExecutorEvent(ctx, task.ID, "codex.completed", "success", "Codex 复检已完成", map[string]any{})
	_ = s.store.AppendExecutorTerminalFrame(ctx, task.ID, "\r\n[AiCRM] Codex 复检已完成\r\n", map[string]any{"type": "codex.completed"})
	_ = s.store.CompleteExecutorTask(ctx, task.ID, "completed", "")
}

func (s *Server) pipeCodexOutput(ctx context.Context, taskID string, reader io.Reader, stderr bool, done chan<- struct{}) {
	defer func() { done <- struct{}{} }()
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		source := "codex"
		level := "info"
		direction := "out"
		if stderr {
			source = "executor"
			level = "warning"
		}
		rawJSON := map[string]any(nil)
		if !stderr {
			if parsed := parseJSONLine(line); parsed != nil {
				rawJSON = parsed
				message := codexEventMessage(parsed)
				if message != "" {
					_ = s.store.AppendExecutorEvent(ctx, taskID, "codex.output", level, message, parsed)
				}
				if threadID := stringFromMap(parsed, "session_id", "conversation_id", "thread_id"); threadID != "" {
					_ = s.store.UpdateExecutorTaskThread(ctx, taskID, threadID)
				}
			}
		}
		_ = s.store.AppendExecutorRawLog(ctx, taskID, source, direction, line, rawJSON, line)
	}
	if err := scanner.Err(); err != nil {
		_ = s.store.AppendExecutorEvent(ctx, taskID, "codex.stream_error", "warning", "读取 Codex 输出失败", map[string]any{"error": err.Error()})
	}
}

func (s *Server) failCodexTask(ctx context.Context, taskID, message string, err error) {
	detail := ""
	if err != nil {
		detail = err.Error()
	}
	_ = s.store.AppendExecutorEvent(ctx, taskID, "codex.failed", "error", message, map[string]any{"error": detail})
	_ = s.store.AppendExecutorRawLog(ctx, taskID, "executor", "internal", detail, map[string]any{"error": detail}, message)
	_ = s.store.CompleteExecutorTask(ctx, taskID, "failed", strings.TrimSpace(message+" "+detail))
}

func buildCodexRepairPrompt(task store.ExecutorTask) string {
	summary := strings.TrimSpace(string(task.ResultSummary))
	if len(summary) > 30000 {
		summary = summary[:30000] + "\n...<truncated>"
	}
	return fmt.Sprintf(`你是 AiCRM 的 Codex 执行器，负责复检矩阵账号 Web 登录脚本任务。

任务目标：
1. 根据任务上下文判断为什么脚本没有达到预期标识。
2. 输出可执行的修复建议或 DSL 脚本调整方案。
3. 如果上下文不足，明确说明还需要哪些浏览器调试通道数据。

当前限制：
- 本轮先作为后端执行器联调，不要修改仓库文件，不要执行部署命令。
- 不要编造已经修复成功；无法确认时输出待补充的调试数据。
- 输出中请包含：失败原因、建议脚本步骤、需要保存的新脚本版本说明。

任务 ID：%s
执行器 ID：%s
任务类型：%s
平台脚本用途：%s
触发原因：%s
Web 空间 ID：%s
脚本 ID：%s
脚本版本 ID：%s

任务上下文 JSON：
%s
`, task.ID, task.ExecutorID, task.TaskType, task.Purpose, task.TriggerReason, task.WebSpaceID, task.ScriptID, task.ScriptVersionID, summary)
}

func parseJSONLine(line string) map[string]any {
	var value map[string]any
	if err := json.Unmarshal([]byte(line), &value); err != nil {
		return nil
	}
	return value
}

func codexEventMessage(value map[string]any) string {
	eventType := stringFromMap(value, "type", "event")
	if eventType == "" {
		return "Codex 输出事件"
	}
	if message := stringFromMap(value, "message", "text", "summary"); message != "" {
		return eventType + ": " + truncate(message, 160)
	}
	return "Codex 事件：" + eventType
}

func stringFromMap(value map[string]any, keys ...string) string {
	for _, key := range keys {
		if raw, ok := value[key]; ok {
			if text, ok := raw.(string); ok {
				return strings.TrimSpace(text)
			}
		}
	}
	return ""
}

func truncate(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "..."
}

type serverCodexAuthProbe struct {
	CodexHome    string
	Source       string
	Authorized   bool
	AuthStatus   string
	AccountLabel string
	CodexVersion string
	StatusText   string
	ExitStatus   int
	CheckedAt    time.Time
}

func (s *Server) detectServerCodexAuthorization(ctx context.Context, cfg store.ExecutorConfig) serverCodexAuthProbe {
	candidates := s.serverCodexHomeCandidates(cfg)
	version := s.codexVersion(ctx)
	probes := make([]serverCodexAuthProbe, 0, len(candidates))
	for _, candidate := range candidates {
		probe := s.probeServerCodexHome(ctx, candidate.CodexHome, candidate.Source)
		probe.CodexVersion = version
		probes = append(probes, probe)
		if probe.Authorized {
			return probe
		}
	}
	if len(probes) > 0 {
		return probes[0]
	}
	return serverCodexAuthProbe{
		CodexHome:    serverCodexHome(cfg.ID),
		Source:       "executor",
		CodexVersion: version,
		CheckedAt:    time.Now(),
	}
}

func (s *Server) serverCodexHomeCandidates(cfg store.ExecutorConfig) []serverCodexAuthProbe {
	items := []serverCodexAuthProbe{}
	add := func(home, source string) {
		home = strings.TrimSpace(home)
		if home == "" {
			return
		}
		for _, item := range items {
			if item.CodexHome == home {
				return
			}
		}
		items = append(items, serverCodexAuthProbe{CodexHome: home, Source: source})
	}

	add(codexHomeFromCapabilities(cfg.Capabilities), "configured")
	add(serverCodexHome(cfg.ID), "executor")
	add(os.Getenv("CODEX_HOME"), "env")
	if home, err := os.UserHomeDir(); err == nil {
		add(filepath.Join(home, ".codex"), "default")
	}
	add("/root/.codex", "default")
	return items
}

func (s *Server) probeServerCodexHome(ctx context.Context, codexHome, source string) serverCodexAuthProbe {
	checkedAt := time.Now()
	probeWorkspace := codexAuthProbeWorkspace()
	statusCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(
		statusCtx,
		s.cfg.CodexBinary,
		"exec",
		"--json",
		"--ephemeral",
		"--ignore-rules",
		"--skip-git-repo-check",
		"-C",
		probeWorkspace,
		"-",
	)
	cmd.Env = append(os.Environ(), "CODEX_HOME="+codexHome)
	cmd.Stdin = strings.NewReader(codexAuthProbePrompt)
	output, err := cmd.CombinedOutput()
	statusText := strings.TrimSpace(string(output))
	exitStatus := 0
	if err != nil {
		exitStatus = 1
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitStatus = exitErr.ExitCode()
		}
	}
	authorized := err == nil && strings.Contains(statusText, codexAuthProbeToken)
	authStatus := "error"
	if authorized {
		authStatus = "authorized"
	} else if isCodexAuthorizationFailure(statusText) {
		authStatus = "not_authorized"
	}
	return serverCodexAuthProbe{
		CodexHome:    codexHome,
		Source:       source,
		Authorized:   authorized,
		AuthStatus:   authStatus,
		AccountLabel: s.codexAccountLabel(ctx, codexHome),
		StatusText:   statusText,
		ExitStatus:   exitStatus,
		CheckedAt:    checkedAt,
	}
}

func (s *Server) syncServerCodexAuthProbe(ctx context.Context, executorID string, probe serverCodexAuthProbe) error {
	status := probe.AuthStatus
	if status == "" {
		status = "not_authorized"
	}
	accountLabel := ""
	if probe.Authorized {
		status = "authorized"
		accountLabel = probe.AccountLabel
	}
	capabilities, _ := json.Marshal(map[string]any{
		"codexHome":  probe.CodexHome,
		"authProbe":  status,
		"authProof":  "codex_exec",
		"authSource": probe.Source,
		"exitStatus": probe.ExitStatus,
		"statusText": truncate(probe.StatusText, 500),
		"checkedAt":  probe.CheckedAt.Format(time.RFC3339Nano),
	})
	_, err := s.store.UpdateExecutorAuthStatus(ctx, executorID, status, "device_auth", accountLabel, "", probe.CodexVersion, capabilities)
	return err
}

func (s *Server) codexVersion(ctx context.Context) string {
	versionCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(versionCtx, s.cfg.CodexBinary, "--version").CombinedOutput()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func (s *Server) codexAccountLabel(ctx context.Context, codexHome string) string {
	statusCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(statusCtx, s.cfg.CodexBinary, "login", "status")
	cmd.Env = append(os.Environ(), "CODEX_HOME="+codexHome)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return ""
	}
	return parseCodexAccountLabel(string(output))
}

func codexHomeFromCapabilities(capabilities json.RawMessage) string {
	if len(capabilities) == 0 {
		return ""
	}
	var payload map[string]any
	if err := json.Unmarshal(capabilities, &payload); err != nil {
		return ""
	}
	if value, ok := payload["codexHome"].(string); ok {
		return strings.TrimSpace(value)
	}
	return ""
}

func parseCodexAccountLabel(statusText string) string {
	statusText = strings.TrimSpace(statusText)
	if statusText == "" {
		return ""
	}
	lower := strings.ToLower(statusText)
	const prefix = "logged in using "
	if index := strings.LastIndex(lower, prefix); index >= 0 {
		return strings.TrimSpace(statusText[index+len(prefix):])
	}
	lines := strings.Split(statusText, "\n")
	return strings.TrimSpace(lines[0])
}

func isCodexAuthorizationFailure(value string) bool {
	lower := strings.ToLower(value)
	return strings.Contains(lower, "not logged in") ||
		strings.Contains(lower, "login required") ||
		strings.Contains(lower, "unauthorized") ||
		strings.Contains(lower, "authentication") ||
		strings.Contains(lower, "auth") ||
		strings.Contains(value, "未登录") ||
		strings.Contains(value, "未授权") ||
		strings.Contains(value, "认证") ||
		strings.Contains(value, "登录")
}

func codexAuthProbeWorkspace() string {
	workspace := filepath.Join(os.TempDir(), "aicrm-codex-auth-probe")
	_ = os.MkdirAll(workspace, 0o755)
	return workspace
}

func serverCodexHome(executorID string) string {
	if executorID == "" {
		executorID = "aiexec_platform_codex"
	}
	return "/data/kyai_crm/codex-executors/" + executorID
}
