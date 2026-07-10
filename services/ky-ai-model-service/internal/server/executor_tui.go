package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-ai-model-service/internal/store"
	"github.com/coder/websocket"
	"github.com/creack/pty"
)

const defaultExecutorTerminalCols uint16 = 150
const defaultExecutorTerminalRows uint16 = 32
const codexProxyWebSocketReadLimit int64 = 64 * 1024 * 1024

type codexTUIRunResult struct {
	TimedOut bool
	Err      error
}

var (
	codexANSISequencePattern          = regexp.MustCompile(`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[()][A-Za-z0-9])`)
	codexRuntimeStatusPattern         = regexp.MustCompile(`(?i)(?:[•●]\s*)?(?:Working\s*\([^)\r\n]*\)(?:\s*·\s*(?:\d+\s+background terminals? running|/ps to view|/stop to close))*|Worked\s+for\s+[^·\r\n]+(?:\s*·\s*(?:\d+\s+background terminals? running|/ps to view|/stop to close))*|Worked\s*\([^)\r\n]*\))`)
	codexRuntimeStatusFragmentPattern = regexp.MustCompile(`(?i)(Working|Worked|esc to interrupt|background terminals? running|/ps to view|/stop to close)`)
)

func (s *Server) executeCodexTUIRun(ctx context.Context, task store.ExecutorTask, cfg store.ExecutorConfig, authProbe serverCodexAuthProbe, timeout time.Duration) codexTUIRunResult {
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	port, err := reserveLocalPort()
	if err != nil {
		return codexTUIRunResult{Err: err}
	}
	remoteURL := fmt.Sprintf("ws://127.0.0.1:%d", port)

	appCmd := exec.CommandContext(runCtx, s.cfg.CodexBinary, "app-server", "--listen", remoteURL)
	appCmd.Env = codexRuntimeEnv(authProbe.CodexHome)
	appStdout, err := appCmd.StdoutPipe()
	if err != nil {
		return codexTUIRunResult{Err: fmt.Errorf("创建 Codex app-server 输出管道失败: %w", err)}
	}
	appStderr, err := appCmd.StderrPipe()
	if err != nil {
		return codexTUIRunResult{Err: fmt.Errorf("创建 Codex app-server 错误管道失败: %w", err)}
	}
	if err = appCmd.Start(); err != nil {
		return codexTUIRunResult{Err: fmt.Errorf("启动 Codex app-server 失败: %w", err)}
	}
	defer stopProcess(appCmd)

	appLogDone := make(chan struct{}, 2)
	go s.pipeCodexProcessLog(ctx, task.ID, "codex.app_server.stdout", appStdout, appLogDone)
	go s.pipeCodexProcessLog(ctx, task.ID, "codex.app_server.stderr", appStderr, appLogDone)

	if err = waitCodexAppServerReady(runCtx, remoteURL); err != nil {
		return codexTUIRunResult{TimedOut: errors.Is(runCtx.Err(), context.DeadlineExceeded), Err: err}
	}

	rpcObserver := newCodexRPCObserver(s, task.ID)
	proxyURL, stopProxy, err := s.startCodexWebSocketProxy(runCtx, task.ID, remoteURL, rpcObserver)
	if err != nil {
		return codexTUIRunResult{Err: fmt.Errorf("启动 Codex app-server 代理失败: %w", err)}
	}
	defer stopProxy()

	_ = s.store.AppendExecutorEvent(ctx, task.ID, "codex.app_server.started", "info", "Codex app-server 已启动", map[string]any{
		"listen":     remoteURL,
		"proxy":      proxyURL,
		"codexHome":  authProbe.CodexHome,
		"codexRunId": task.ID,
	})
	_ = s.store.AppendExecutorTerminalFrame(ctx, task.ID, "\x1b[2J\x1b[H", map[string]any{
		"type": "terminal.clear",
	})

	contextPath, cleanupContext, err := writeCodexRepairContextFile(task)
	if err != nil {
		return codexTUIRunResult{Err: fmt.Errorf("准备 Codex 任务上下文失败: %w", err)}
	}
	defer cleanupContext()
	_ = s.store.AppendExecutorEvent(ctx, task.ID, "codex.context_prepared", "debug", "Codex 任务上下文文件已准备", map[string]any{
		"contextPath": contextPath,
	})

	prompt := buildCodexRepairPrompt(task, contextPath)
	tuiArgs := []string{
		"--remote", proxyURL,
		"--dangerously-bypass-approvals-and-sandbox",
		"-C", s.cfg.CodexWorkspace,
		prompt,
	}
	tuiCmd := exec.CommandContext(runCtx, s.cfg.CodexBinary, tuiArgs...)
	tuiCmd.Env = codexRuntimeEnv(authProbe.CodexHome)

	tty, err := pty.StartWithSize(tuiCmd, &pty.Winsize{Cols: defaultExecutorTerminalCols, Rows: defaultExecutorTerminalRows})
	if err != nil {
		return codexTUIRunResult{Err: fmt.Errorf("启动 Codex TUI PTY 失败: %w", err)}
	}
	defer func() { _ = tty.Close() }()
	unregisterPTY := s.registerExecutorPTY(task.ID, tty)
	defer unregisterPTY()

	_ = s.store.AppendExecutorEvent(ctx, task.ID, "codex.tui.started", "info", "Codex TUI 终端已接入", map[string]any{
		"remote":         proxyURL,
		"upstreamRemote": remoteURL,
		"cols":           defaultExecutorTerminalCols,
		"rows":           defaultExecutorTerminalRows,
	})

	readDone := make(chan error, 1)
	go s.pipeCodexPTYFrames(ctx, task.ID, tty, readDone)

	waitErr := tuiCmd.Wait()
	_ = tty.Close()
	readErr := <-readDone

	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		return codexTUIRunResult{TimedOut: true}
	}
	if waitErr != nil {
		return codexTUIRunResult{Err: waitErr}
	}
	if readErr != nil && !errors.Is(readErr, os.ErrClosed) {
		_ = s.store.AppendExecutorEvent(ctx, task.ID, "codex.terminal_read_error", "warning", "读取 Codex TUI 终端帧异常", map[string]any{
			"error": readErr.Error(),
		})
	}
	return codexTUIRunResult{}
}

type codexRPCObserver struct {
	mu        sync.Mutex
	seenUsage map[string]struct{}
	server    *Server
	taskID    string
}

type codexProxyBridgeError struct {
	direction string
	err       error
}

func newCodexRPCObserver(server *Server, taskID string) *codexRPCObserver {
	return &codexRPCObserver{
		seenUsage: map[string]struct{}{},
		server:    server,
		taskID:    taskID,
	}
}

func (s *Server) startCodexWebSocketProxy(ctx context.Context, taskID, upstreamURL string, observer *codexRPCObserver) (string, func(), error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	server := &http.Server{}
	server.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedSubprotocols := websocketSubprotocols(r.Header.Get("Sec-WebSocket-Protocol"))
		downstream, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true,
			Subprotocols:       requestedSubprotocols,
		})
		if err != nil {
			return
		}
		downstream.SetReadLimit(codexProxyWebSocketReadLimit)
		defer downstream.Close(websocket.StatusNormalClosure, "")

		upstream, _, err := websocket.Dial(ctx, upstreamURL, &websocket.DialOptions{
			Subprotocols: requestedSubprotocols,
		})
		if err != nil {
			_ = downstream.Close(websocket.StatusInternalError, "codex app-server unavailable")
			_ = s.store.AppendExecutorEvent(r.Context(), taskID, "codex.proxy_failed", "error", "Codex app-server 代理连接失败", map[string]any{
				"error": err.Error(),
			})
			return
		}
		upstream.SetReadLimit(codexProxyWebSocketReadLimit)
		defer upstream.Close(websocket.StatusNormalClosure, "")

		bridgeCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		errs := make(chan codexProxyBridgeError, 2)
		go s.proxyCodexWebSocketFrames(bridgeCtx, "tui_to_app_server", upstream, downstream, observer, errs)
		go s.proxyCodexWebSocketFrames(bridgeCtx, "app_server_to_tui", downstream, upstream, observer, errs)
		select {
		case <-ctx.Done():
		case bridgeErr := <-errs:
			if bridgeErr.err != nil && websocket.CloseStatus(bridgeErr.err) != websocket.StatusNormalClosure {
				_ = s.store.AppendExecutorEvent(context.Background(), taskID, "codex.proxy_closed", "debug", "Codex app-server 代理连接结束", map[string]any{
					"direction": bridgeErr.direction,
					"error":     bridgeErr.err.Error(),
					"status":    int(websocket.CloseStatus(bridgeErr.err)),
				})
			}
		}
		cancel()
	})

	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			_ = s.store.AppendExecutorEvent(context.Background(), taskID, "codex.proxy_failed", "error", "Codex app-server 代理异常退出", map[string]any{
				"error": err.Error(),
			})
		}
	}()

	proxyURL := fmt.Sprintf("ws://%s", listener.Addr().String())
	stop := func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
		_ = listener.Close()
	}
	return proxyURL, stop, nil
}

func (s *Server) proxyCodexWebSocketFrames(
	ctx context.Context,
	direction string,
	dst *websocket.Conn,
	src *websocket.Conn,
	observer *codexRPCObserver,
	errs chan<- codexProxyBridgeError,
) {
	for {
		messageType, payload, err := src.Read(ctx)
		if err != nil {
			errs <- codexProxyBridgeError{direction: direction, err: err}
			return
		}
		if observer != nil {
			observer.observe(ctx, direction, messageType, payload)
		}
		if err := dst.Write(ctx, messageType, payload); err != nil {
			errs <- codexProxyBridgeError{direction: direction, err: err}
			return
		}
	}
}

func websocketSubprotocols(value string) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	items := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			items = append(items, part)
		}
	}
	return items
}

func writeCodexRepairContextFile(task store.ExecutorTask) (string, func(), error) {
	body := strings.TrimSpace(string(task.ResultSummary))
	if body == "" {
		body = "{}"
	}
	dir := filepath.Join(os.TempDir(), "aicrm-codex-task-contexts")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", func() {}, err
	}
	path := filepath.Join(dir, task.ID+".json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		return "", func() {}, err
	}
	return path, func() { _ = os.Remove(path) }, nil
}

func (observer *codexRPCObserver) observe(ctx context.Context, direction string, messageType websocket.MessageType, payload []byte) {
	if observer == nil || observer.server == nil || len(payload) == 0 {
		return
	}
	if messageType != websocket.MessageText && messageType != websocket.MessageBinary {
		return
	}
	var decoded any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return
	}
	for _, usage := range collectCodexTokenUsages(decoded, 0) {
		body, _ := json.Marshal(usage)
		fingerprint := string(body)
		if fingerprint == "" || fingerprint == "{}" {
			continue
		}
		observer.mu.Lock()
		_, seen := observer.seenUsage[fingerprint]
		if !seen {
			observer.seenUsage[fingerprint] = struct{}{}
		}
		observer.mu.Unlock()
		if seen {
			continue
		}
		_ = observer.server.store.AppendExecutorEvent(ctx, observer.taskID, "codex.usage", "info", "Codex Token 用量更新", map[string]any{
			"direction": direction,
			"source":    "codex_app_server_jsonrpc",
			"usage":     usage,
		})
	}
}

func collectCodexTokenUsages(value any, depth int) []map[string]any {
	if value == nil || depth > 8 {
		return nil
	}
	switch typed := value.(type) {
	case []any:
		items := []map[string]any{}
		for _, item := range typed {
			items = append(items, collectCodexTokenUsages(item, depth+1)...)
		}
		return items
	case map[string]any:
		items := []map[string]any{}
		if usage, ok := normalizeCodexTokenUsage(typed); ok {
			items = append(items, usage)
		}
		preferredKeys := []string{"usage", "tokenUsage", "token_usage", "metrics", "message", "response", "event", "data", "result", "params", "payload", "item"}
		for _, key := range preferredKeys {
			if child, ok := typed[key]; ok {
				items = append(items, collectCodexTokenUsages(child, depth+1)...)
			}
		}
		return items
	default:
		return nil
	}
}

func normalizeCodexTokenUsage(value map[string]any) (map[string]any, bool) {
	inputDetails := mapFromAny(value["input_token_details"])
	if inputDetails == nil {
		inputDetails = mapFromAny(value["inputTokenDetails"])
	}
	if inputDetails == nil {
		inputDetails = mapFromAny(value["prompt_tokens_details"])
	}
	outputDetails := mapFromAny(value["output_token_details"])
	if outputDetails == nil {
		outputDetails = mapFromAny(value["outputTokenDetails"])
	}
	if outputDetails == nil {
		outputDetails = mapFromAny(value["completion_tokens_details"])
	}

	inputTokens := int64FromMap(value, "input_tokens", "inputTokens", "input_token_count", "prompt_tokens", "promptTokens")
	cachedInputTokens := int64FromMap(value, "cached_input_tokens", "cachedInputTokens")
	if cachedInputTokens == 0 && inputDetails != nil {
		cachedInputTokens = int64FromMap(inputDetails, "cached_tokens", "cache_read_input_tokens", "cachedInputTokens")
	}
	outputTokens := int64FromMap(value, "output_tokens", "outputTokens", "output_token_count", "completion_tokens", "completionTokens")
	reasoningOutputTokens := int64FromMap(value, "reasoning_output_tokens", "reasoningOutputTokens")
	if reasoningOutputTokens == 0 && outputDetails != nil {
		reasoningOutputTokens = int64FromMap(outputDetails, "reasoning_tokens", "reasoningTokens")
	}
	totalTokens := int64FromMap(value, "total_tokens", "totalTokens", "total_token_count")
	if totalTokens == 0 {
		totalTokens = inputTokens + outputTokens
	}
	if inputTokens+cachedInputTokens+outputTokens+reasoningOutputTokens+totalTokens <= 0 {
		return nil, false
	}
	return map[string]any{
		"cached_input_tokens":     cachedInputTokens,
		"input_tokens":            inputTokens,
		"output_tokens":           outputTokens,
		"reasoning_output_tokens": reasoningOutputTokens,
		"total_tokens":            totalTokens,
	}, true
}

func int64FromMap(value map[string]any, keys ...string) int64 {
	for _, key := range keys {
		if number, ok := int64FromAny(value[key]); ok {
			return number
		}
	}
	return 0
}

func int64FromAny(value any) (int64, bool) {
	switch typed := value.(type) {
	case int:
		return int64(typed), true
	case int64:
		return typed, true
	case float64:
		return int64(typed), true
	case json.Number:
		number, err := typed.Int64()
		if err == nil {
			return number, true
		}
		floatNumber, err := typed.Float64()
		if err == nil {
			return int64(floatNumber), true
		}
	case string:
		var number json.Number = json.Number(strings.TrimSpace(typed))
		parsed, err := number.Int64()
		if err == nil {
			return parsed, true
		}
	}
	return 0, false
}

func mapFromAny(value any) map[string]any {
	typed, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return typed
}

func (s *Server) registerExecutorPTY(taskID string, file *os.File) func() {
	s.executorPTYMu.Lock()
	s.executorPTY[taskID] = file
	s.executorPTYMu.Unlock()
	return func() {
		s.executorPTYMu.Lock()
		if s.executorPTY[taskID] == file {
			delete(s.executorPTY, taskID)
		}
		s.executorPTYMu.Unlock()
	}
}

func (s *Server) resizeExecutorPTY(taskID string, cols, rows int) bool {
	s.executorPTYMu.Lock()
	file := s.executorPTY[taskID]
	s.executorPTYMu.Unlock()
	if file == nil {
		return false
	}
	return pty.Setsize(file, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)}) == nil
}

func (s *Server) pipeCodexPTYFrames(ctx context.Context, taskID string, reader io.Reader, done chan<- error) {
	buf := make([]byte, 8192)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			payload := string(buf[:n])
			rawJSON := map[string]any{
				"type":      "terminal.frame",
				"byteCount": n,
			}
			if status, statusOnly := extractCodexRuntimeStatus(payload); status != nil {
				rawJSON["runtimeStatus"] = status
				rawJSON["runtimeStatusOnly"] = statusOnly
			}
			_ = s.store.AppendExecutorTerminalFrame(ctx, taskID, payload, rawJSON)
		}
		if err != nil {
			done <- err
			return
		}
	}
}

func extractCodexRuntimeStatus(payload string) (map[string]any, bool) {
	plain := normalizeTerminalStatusText(payload)
	if plain == "" {
		return nil, false
	}
	matches := codexRuntimeStatusPattern.FindAllString(plain, -1)
	if len(matches) == 0 {
		if !codexRuntimeStatusFragmentPattern.MatchString(plain) {
			return nil, false
		}
		text := normalizeCodexRuntimeStatusText(plain)
		if text == "" {
			return nil, true
		}
		lowerText := strings.ToLower(strings.TrimLeft(text, "•● "))
		active := strings.Contains(lowerText, "working") || !strings.Contains(lowerText, "worked")
		kind := "worked"
		if active {
			kind = "working"
		}
		return map[string]any{
			"text":   text,
			"kind":   kind,
			"active": active,
		}, true
	}
	text := normalizeCodexRuntimeStatusText(matches[len(matches)-1])
	if text == "" {
		return nil, false
	}
	lowerText := strings.ToLower(strings.TrimLeft(text, "•● "))
	active := strings.HasPrefix(lowerText, "working")
	kind := "worked"
	if active {
		kind = "working"
	}
	status := map[string]any{
		"text":   text,
		"kind":   kind,
		"active": active,
	}
	if meta := codexRuntimeStatusMeta(text); meta != "" {
		status["meta"] = meta
	}
	return status, codexRuntimeStatusOnly(plain, text) || codexRuntimeStatusFragmentPattern.MatchString(plain)
}

func normalizeTerminalStatusText(payload string) string {
	text := codexANSISequencePattern.ReplaceAllString(payload, " ")
	var builder strings.Builder
	builder.Grow(len(text))
	for _, r := range text {
		if r < 32 || r == 127 {
			builder.WriteByte(' ')
			continue
		}
		builder.WriteRune(r)
	}
	return strings.Join(strings.Fields(builder.String()), " ")
}

func normalizeCodexRuntimeStatusText(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	value = strings.TrimSpace(value)
	value = strings.Trim(value, "│┃ ")
	return value
}

func codexRuntimeStatusMeta(text string) string {
	start := strings.Index(text, "(")
	end := strings.LastIndex(text, ")")
	if start < 0 || end <= start {
		return ""
	}
	return strings.TrimSpace(text[start+1 : end])
}

func codexRuntimeStatusOnly(plain, text string) bool {
	remainder := strings.TrimSpace(strings.Replace(plain, text, "", 1))
	remainder = strings.Trim(remainder, "•●│┃-—_= ")
	return remainder == ""
}

func (s *Server) pipeCodexProcessLog(ctx context.Context, taskID, eventType string, reader io.Reader, done chan<- struct{}) {
	defer func() { done <- struct{}{} }()
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 16*1024), 256*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		_ = s.store.AppendExecutorEvent(ctx, taskID, eventType, "debug", truncate(line, 300), map[string]any{
			"line": truncate(line, 1000),
		})
	}
}

func reserveLocalPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	addr, ok := listener.Addr().(*net.TCPAddr)
	if !ok || addr.Port <= 0 {
		return 0, errors.New("无法分配 Codex app-server 本地端口")
	}
	return addr.Port, nil
}

func waitCodexAppServerReady(ctx context.Context, remoteURL string) error {
	healthURL := strings.Replace(remoteURL, "ws://", "http://", 1) + "/readyz"
	client := http.Client{Timeout: 500 * time.Millisecond}
	deadline := time.Now().Add(8 * time.Second)
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL, nil)
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		if time.Now().After(deadline) {
			if err != nil {
				return fmt.Errorf("等待 Codex app-server ready 超时: %w", err)
			}
			return errors.New("等待 Codex app-server ready 超时")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(150 * time.Millisecond):
		}
	}
}

func codexRuntimeEnv(codexHome string) []string {
	env := append([]string{}, os.Environ()...)
	env = append(env,
		"CODEX_HOME="+codexHome,
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	)
	return env
}

func stopProcess(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
}
