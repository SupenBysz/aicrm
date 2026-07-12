package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-ai-model-service/internal/store"
	"github.com/jackc/pgx/v5"
)

func (s *Server) getExecutorConfig(w http.ResponseWriter, r *http.Request, wc wsContext) {
	setLegacyExecutorAuthorizationHeaders(w)
	item, err := s.store.GetExecutorConfig(r.Context(), "codex")
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, toLegacyExecutorConfigProjection(item))
}

func (s *Server) listExecutors(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, pageSize := parsePage(r)
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	runtimeType := strings.TrimSpace(r.URL.Query().Get("runtimeType"))
	executorType := strings.TrimSpace(r.URL.Query().Get("executorType"))
	items, total, err := s.store.ListExecutorConfigs(r.Context(), status, runtimeType, executorType, page, pageSize)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeList(w, r, toLegacyExecutorConfigProjections(items), store.Page{Page: page, PageSize: pageSize, Total: total})
}

func (s *Server) createExecutor(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in store.ExecutorConfigInput
	if !decodeJSON(w, r, &in) {
		return
	}
	normalizeExecutorConfigInput(&in)
	if !validExecutorConfigInput(in) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "执行器参数无效")
		return
	}
	item, err := s.store.CreateExecutorConfig(r.Context(), in, wc.UserID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "ai_executor.created", "ai_executor", item.ID, map[string]any{
		"executorType": item.ExecutorType,
		"runtimeType":  item.RuntimeType,
	})
	writeData(w, r, toLegacyExecutorConfigProjection(item))
}

func (s *Server) getExecutor(w http.ResponseWriter, r *http.Request, wc wsContext) {
	item, err := s.store.GetExecutorConfigByID(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, toLegacyExecutorConfigProjection(item))
}

func (s *Server) updateExecutor(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in store.ExecutorConfigInput
	if !decodeJSON(w, r, &in) {
		return
	}
	normalizeExecutorConfigInput(&in)
	if !validExecutorConfigInput(in) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "执行器参数无效")
		return
	}
	item, err := s.store.UpdateExecutorConfig(r.Context(), r.PathValue("id"), in, wc.UserID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "ai_executor.updated", "ai_executor", item.ID, map[string]any{
		"executorType": item.ExecutorType,
		"runtimeType":  item.RuntimeType,
	})
	writeData(w, r, toLegacyExecutorConfigProjection(item))
}

func (s *Server) updateExecutorConfig(w http.ResponseWriter, r *http.Request, wc wsContext) {
	setLegacyExecutorAuthorizationHeaders(w)
	writeError(w, r, http.StatusGone, "legacy_endpoint_gone", "旧版 Codex 执行器配置写接口已停用")
}

func (s *Server) authorizeExecutor(w http.ResponseWriter, r *http.Request, wc wsContext) {
	setLegacyExecutorAuthorizationHeaders(w)
	if legacyExecutorAuthorizationBodyPresent(r) {
		writeError(w, r, http.StatusUpgradeRequired, "desktop_bridge_upgrade_required", "旧版执行器授权请求已停用，请升级到可信授权桥")
		return
	}
	writeError(w, r, http.StatusServiceUnavailable, "executor_authorization_unavailable", "可信执行器授权服务尚未启用")
}

func setLegacyExecutorAuthorizationHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Deprecation", "true")
}

func legacyExecutorAuthorizationBodyPresent(r *http.Request) bool {
	if r.Body == nil || r.Body == http.NoBody {
		return false
	}
	var firstByte [1]byte
	n, err := r.Body.Read(firstByte[:])
	return n > 0 || (err != nil && !errors.Is(err, io.EOF))
}

func (s *Server) syncExecutorAuthStatus(w http.ResponseWriter, r *http.Request, wc wsContext) {
	setLegacyExecutorAuthorizationHeaders(w)
	writeError(w, r, http.StatusGone, "legacy_endpoint_gone", "旧版执行器授权状态同步接口已停用")
}

func (s *Server) listExecutorTasks(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, pageSize := parsePage(r)
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	executorType := strings.TrimSpace(r.URL.Query().Get("executorType"))
	items, total, err := s.store.ListExecutorTasks(r.Context(), wc.WorkspaceType, wc.WorkspaceID, status, executorType, page, pageSize)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeList(w, r, items, store.Page{Page: page, PageSize: pageSize, Total: total})
}

func (s *Server) listExecutorRuns(w http.ResponseWriter, r *http.Request, wc wsContext) {
	page, pageSize := parsePage(r)
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	executorType := strings.TrimSpace(r.URL.Query().Get("executorType"))
	items, total, err := s.store.ListExecutorTasks(r.Context(), wc.WorkspaceType, wc.WorkspaceID, status, executorType, page, pageSize)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	out := make([]executorRunPayload, 0, len(items))
	for _, item := range items {
		out = append(out, toExecutorRun(item))
	}
	writeList(w, r, out, store.Page{Page: page, PageSize: pageSize, Total: total})
}

func (s *Server) createExecutorTask(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in store.ExecutorTaskInput
	if !decodeJSON(w, r, &in) {
		return
	}
	normalizeExecutorTaskInput(&in)
	if !validExecutorTaskInput(in) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "执行器任务参数无效")
		return
	}
	item, err := s.store.CreateExecutorTask(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.UserID, in)
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			writeError(w, r, http.StatusConflict, "executor_disabled", "执行器未启用或自动修复未开启")
			return
		}
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "ai_executor_task.created", "ai_executor_task", item.ID, map[string]any{
		"executorType":  item.ExecutorType,
		"purpose":       item.Purpose,
		"triggerReason": item.TriggerReason,
	})
	writeData(w, r, item)
}

func (s *Server) createExecutorRun(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in store.ExecutorTaskInput
	if !decodeJSON(w, r, &in) {
		return
	}
	normalizeExecutorTaskInput(&in)
	if !validExecutorTaskInput(in) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "执行器运行参数无效")
		return
	}
	item, err := s.store.CreateExecutorTask(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.UserID, in)
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			writeError(w, r, http.StatusConflict, "executor_disabled", "执行器未启用或自动修复未开启")
			return
		}
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "ai_executor_run.created", "ai_executor_run", item.ID, map[string]any{
		"executorType":  item.ExecutorType,
		"purpose":       item.Purpose,
		"triggerReason": item.TriggerReason,
	})
	writeData(w, r, toExecutorRun(item))
}

func (s *Server) getExecutorTask(w http.ResponseWriter, r *http.Request, wc wsContext) {
	item, err := s.store.GetExecutorTask(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, item)
}

func (s *Server) getExecutorRun(w http.ResponseWriter, r *http.Request, wc wsContext) {
	item, err := s.store.GetExecutorTask(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, toExecutorRun(item))
}

func (s *Server) cancelExecutorTask(w http.ResponseWriter, r *http.Request, wc wsContext) {
	item, err := s.store.CancelExecutorTask(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), wc.UserID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "ai_executor_task.cancelled", "ai_executor_task", item.ID, nil)
	writeData(w, r, item)
}

func (s *Server) cancelExecutorRun(w http.ResponseWriter, r *http.Request, wc wsContext) {
	item, err := s.store.CancelExecutorTask(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), wc.UserID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "ai_executor_run.cancelled", "ai_executor_run", item.ID, nil)
	writeData(w, r, toExecutorRun(item))
}

func (s *Server) interruptExecutorRun(w http.ResponseWriter, r *http.Request, wc wsContext) {
	item, err := s.store.CancelExecutorTask(r.Context(), wc.WorkspaceType, wc.WorkspaceID, r.PathValue("id"), wc.UserID)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	_ = s.store.AppendExecutorEvent(r.Context(), item.ID, "run.interrupted", "warning", "执行器运行已中断", map[string]any{"actorUserId": wc.UserID})
	s.audit(r.Context(), r, wc, "ai_executor_run.interrupted", "ai_executor_run", item.ID, nil)
	writeData(w, r, toExecutorRun(item))
}

func (s *Server) listExecutorTaskEvents(w http.ResponseWriter, r *http.Request, wc wsContext) {
	taskID := r.PathValue("id")
	if _, err := s.store.GetExecutorTask(r.Context(), wc.WorkspaceType, wc.WorkspaceID, taskID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	items, err := s.store.ListExecutorTaskEvents(r.Context(), taskID, parseInt64Default(r.URL.Query().Get("after"), 0), parseIntDefault(r.URL.Query().Get("limit"), 200))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, items)
}

func (s *Server) listExecutorRunEvents(w http.ResponseWriter, r *http.Request, wc wsContext) {
	runID := r.PathValue("id")
	if _, err := s.store.GetExecutorTask(r.Context(), wc.WorkspaceType, wc.WorkspaceID, runID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	items, err := s.store.ListExecutorTaskEvents(r.Context(), runID, parseInt64Default(r.URL.Query().Get("after"), 0), parseIntDefault(r.URL.Query().Get("limit"), 200))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	out := make([]executorRunEventPayload, 0, len(items))
	for _, item := range items {
		out = append(out, toExecutorRunEvent(item))
	}
	writeData(w, r, out)
}

func (s *Server) listExecutorTaskRawLogs(w http.ResponseWriter, r *http.Request, wc wsContext) {
	taskID := r.PathValue("id")
	if _, err := s.store.GetExecutorTask(r.Context(), wc.WorkspaceType, wc.WorkspaceID, taskID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	items, err := s.store.ListExecutorTaskRawLogs(r.Context(), taskID, parseInt64Default(r.URL.Query().Get("after"), 0), parseIntDefault(r.URL.Query().Get("limit"), 200))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, items)
}

func (s *Server) listExecutorTerminalFrames(w http.ResponseWriter, r *http.Request, wc wsContext) {
	runID := r.PathValue("id")
	if _, err := s.store.GetExecutorTask(r.Context(), wc.WorkspaceType, wc.WorkspaceID, runID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	items, err := s.store.ListExecutorTaskRawLogs(r.Context(), runID, parseInt64Default(r.URL.Query().Get("afterFrame"), 0), parseIntDefault(r.URL.Query().Get("limit"), 200))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	out := make([]executorTerminalFramePayload, 0, len(items))
	for _, item := range items {
		out = append(out, toExecutorTerminalFrame(item))
	}
	writeData(w, r, out)
}

func (s *Server) streamExecutorTaskEvents(w http.ResponseWriter, r *http.Request, wc wsContext) {
	taskID := r.PathValue("id")
	if _, err := s.store.GetExecutorTask(r.Context(), wc.WorkspaceType, wc.WorkspaceID, taskID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.streamSSEFromNotify(w, r, taskID, "event", parseInt64Default(r.URL.Query().Get("after"), 0), func(after int64) ([]sseItem, error) {
		items, err := s.store.ListExecutorTaskEvents(r.Context(), taskID, after, 200)
		if err != nil {
			return nil, err
		}
		out := make([]sseItem, 0, len(items))
		for _, item := range items {
			out = append(out, sseItem{Sequence: item.Sequence, Event: item.EventType, Data: item})
		}
		return out, nil
	})
}

func (s *Server) streamExecutorRunEvents(w http.ResponseWriter, r *http.Request, wc wsContext) {
	runID := r.PathValue("id")
	if _, err := s.store.GetExecutorTask(r.Context(), wc.WorkspaceType, wc.WorkspaceID, runID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.streamSSEFromNotify(w, r, runID, "event", parseInt64Default(r.URL.Query().Get("after"), 0), func(after int64) ([]sseItem, error) {
		items, err := s.store.ListExecutorTaskEvents(r.Context(), runID, after, 200)
		if err != nil {
			return nil, err
		}
		out := make([]sseItem, 0, len(items))
		for _, item := range items {
			out = append(out, sseItem{Sequence: item.Sequence, Event: item.EventType, Data: toExecutorRunEvent(item)})
		}
		return out, nil
	})
}

func (s *Server) streamExecutorTaskTerminal(w http.ResponseWriter, r *http.Request, wc wsContext) {
	taskID := r.PathValue("id")
	if _, err := s.store.GetExecutorTask(r.Context(), wc.WorkspaceType, wc.WorkspaceID, taskID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.streamSSEFromNotify(w, r, taskID, "terminal", parseInt64Default(r.URL.Query().Get("after"), 0), func(after int64) ([]sseItem, error) {
		items, err := s.store.ListExecutorTaskRawLogs(r.Context(), taskID, after, 200)
		if err != nil {
			return nil, err
		}
		out := make([]sseItem, 0, len(items))
		for _, item := range items {
			out = append(out, sseItem{Sequence: item.Sequence, Event: "terminal.line", Data: item})
		}
		return out, nil
	})
}

func (s *Server) streamExecutorTerminalFrames(w http.ResponseWriter, r *http.Request, wc wsContext) {
	runID := r.PathValue("id")
	if _, err := s.store.GetExecutorTask(r.Context(), wc.WorkspaceType, wc.WorkspaceID, runID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	after := parseInt64Default(r.URL.Query().Get("afterFrame"), 0)
	s.streamSSEFromNotify(w, r, runID, "terminal", after, func(after int64) ([]sseItem, error) {
		items, err := s.store.ListExecutorTaskRawLogs(r.Context(), runID, after, 200)
		if err != nil {
			return nil, err
		}
		out := make([]sseItem, 0, len(items))
		for _, item := range items {
			frame := toExecutorTerminalFrame(item)
			out = append(out, sseItem{Sequence: frame.FrameSeq, Event: "terminal.frame", Data: frame})
		}
		return out, nil
	})
}

type terminalResizeInput struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

func (s *Server) resizeExecutorTerminal(w http.ResponseWriter, r *http.Request, wc wsContext) {
	runID := r.PathValue("id")
	if _, err := s.store.GetExecutorTask(r.Context(), wc.WorkspaceType, wc.WorkspaceID, runID); err != nil {
		writeStoreError(w, r, err)
		return
	}
	var in terminalResizeInput
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.Cols < 20 || in.Cols > 300 || in.Rows < 5 || in.Rows > 120 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "终端尺寸参数无效")
		return
	}
	liveResized := s.resizeExecutorPTY(runID, in.Cols, in.Rows)
	payload := map[string]any{"cols": in.Cols, "rows": in.Rows}
	if liveResized {
		payload["liveResized"] = true
	}
	_ = s.store.AppendExecutorEvent(r.Context(), runID, "terminal.resized", "info", "终端尺寸已更新", payload)
	writeData(w, r, map[string]any{
		"runId":       runID,
		"cols":        in.Cols,
		"rows":        in.Rows,
		"accepted":    true,
		"liveResized": liveResized,
	})
}

type sseItem struct {
	Sequence int64
	Event    string
	Data     any
}

func (s *Server) streamSSEFromNotify(w http.ResponseWriter, r *http.Request, taskID, streamKind string, after int64, load func(after int64) ([]sseItem, error)) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, r, http.StatusInternalServerError, "stream_unavailable", "当前连接不支持事件流")
		return
	}
	if strings.TrimSpace(s.cfg.DatabaseURL) == "" {
		writeError(w, r, http.StatusInternalServerError, "stream_unavailable", "事件流数据库连接未配置")
		return
	}

	connectCtx, cancelConnect := context.WithTimeout(r.Context(), 5*time.Second)
	conn, err := pgx.Connect(connectCtx, s.cfg.DatabaseURL)
	cancelConnect()
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "stream_unavailable", "事件流监听连接失败")
		return
	}
	if _, err = conn.Exec(r.Context(), `LISTEN `+store.ExecutorStreamNotifyChannel); err != nil {
		_ = conn.Close(context.Background())
		writeError(w, r, http.StatusInternalServerError, "stream_unavailable", "事件流监听启动失败")
		return
	}
	waitCtx, cancelWait := context.WithCancel(r.Context())
	waitDone := make(chan struct{})
	defer func() {
		cancelWait()
		select {
		case <-waitDone:
		case <-time.After(500 * time.Millisecond):
		}
		_ = conn.Close(context.Background())
	}()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	flushBacklog := func() bool {
		for {
			items, err := load(after)
			if err != nil {
				writeSSE(w, "error", map[string]any{"message": "事件流读取失败"})
				flusher.Flush()
				return false
			}
			for _, item := range items {
				writeSSE(w, item.Event, item.Data)
				if item.Sequence > after {
					after = item.Sequence
				}
			}
			flusher.Flush()
			if len(items) < 200 {
				return true
			}
		}
	}

	if !flushBacklog() {
		return
	}

	notifyCh := make(chan string, 64)
	errCh := make(chan error, 1)
	go func() {
		defer close(waitDone)
		for {
			notification, err := conn.WaitForNotification(waitCtx)
			if err != nil {
				select {
				case errCh <- err:
				default:
				}
				return
			}
			select {
			case notifyCh <- notification.Payload:
			case <-waitCtx.Done():
				return
			}
		}
	}()

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	safetyBackfill := time.NewTicker(30 * time.Second)
	defer safetyBackfill.Stop()

	for {
		select {
		case payload := <-notifyCh:
			shouldFlush := executorStreamNotificationMatches(payload, taskID, streamKind)
			for i := 0; i < 128; i++ {
				select {
				case payload = <-notifyCh:
					if executorStreamNotificationMatches(payload, taskID, streamKind) {
						shouldFlush = true
					}
				default:
					i = 128
				}
			}
			if shouldFlush && !flushBacklog() {
				return
			}
		case <-safetyBackfill.C:
			if !flushBacklog() {
				return
			}
		case <-heartbeat.C:
			writeSSE(w, "stream.heartbeat", map[string]any{"after": after})
			flusher.Flush()
		case err := <-errCh:
			if errors.Is(err, context.Canceled) || errors.Is(err, http.ErrAbortHandler) || r.Context().Err() != nil {
				return
			}
			writeSSE(w, "error", map[string]any{"message": "事件流监听中断"})
			flusher.Flush()
			return
		case <-r.Context().Done():
			return
		}
	}
}

func executorStreamNotificationMatches(payload, taskID, streamKind string) bool {
	if payload == taskID {
		return true
	}
	var item struct {
		TaskID string `json:"taskId"`
		Kind   string `json:"kind"`
	}
	if err := json.Unmarshal([]byte(payload), &item); err != nil {
		return false
	}
	if item.TaskID != taskID {
		return false
	}
	return item.Kind == "" || item.Kind == "all" || item.Kind == streamKind
}

type executorRunPayload struct {
	store.ExecutorTask
	RunID    string `json:"runId"`
	ThreadID string `json:"threadId,omitempty"`
}

type executorRunEventPayload struct {
	store.ExecutorTaskEvent
	RunID string `json:"runId"`
}

type executorTerminalFramePayload struct {
	ID        string          `json:"id"`
	RunID     string          `json:"runId"`
	TaskID    string          `json:"taskId"`
	FrameSeq  int64           `json:"frameSeq"`
	Sequence  int64           `json:"sequence"`
	Encoding  string          `json:"encoding"`
	Payload   string          `json:"payload"`
	ByteLen   int             `json:"byteLength"`
	Source    string          `json:"source"`
	Direction string          `json:"direction"`
	RawJSON   json.RawMessage `json:"rawJson"`
	CreatedAt time.Time       `json:"createdAt"`
}

func toExecutorRun(item store.ExecutorTask) executorRunPayload {
	return executorRunPayload{
		ExecutorTask: item,
		RunID:        item.ID,
		ThreadID:     item.CodexThreadID,
	}
}

func toExecutorRunEvent(item store.ExecutorTaskEvent) executorRunEventPayload {
	return executorRunEventPayload{
		ExecutorTaskEvent: item,
		RunID:             item.TaskID,
	}
}

func toExecutorTerminalFrame(item store.ExecutorTaskRawLog) executorTerminalFramePayload {
	payload := item.RawText
	if item.TerminalLine != "" {
		payload = item.TerminalLine
		if !strings.HasSuffix(payload, "\n") {
			payload += "\r\n"
		}
	}
	if payload == "" && len(item.RawJSON) > 0 {
		payload = string(item.RawJSON)
		if !strings.HasSuffix(payload, "\n") {
			payload += "\r\n"
		}
	}
	return executorTerminalFramePayload{
		ID:        item.ID,
		RunID:     item.TaskID,
		TaskID:    item.TaskID,
		FrameSeq:  item.Sequence,
		Sequence:  item.Sequence,
		Encoding:  "utf8",
		Payload:   payload,
		ByteLen:   len([]byte(payload)),
		Source:    item.Source,
		Direction: item.Direction,
		RawJSON:   item.RawJSON,
		CreatedAt: item.CreatedAt,
	}
}

func writeSSE(w http.ResponseWriter, event string, data any) {
	body, _ := json.Marshal(data)
	_, _ = fmt.Fprintf(w, "event: %s\n", event)
	_, _ = fmt.Fprintf(w, "data: %s\n\n", body)
}

func normalizeExecutorConfigInput(in *store.ExecutorConfigInput) {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		in.Name = "Codex 执行器"
	}
	in.ExecutorType = strings.TrimSpace(in.ExecutorType)
	if in.ExecutorType == "" {
		in.ExecutorType = "codex"
	}
	in.RuntimeType = strings.TrimSpace(in.RuntimeType)
	if in.RuntimeType == "" {
		in.RuntimeType = "desktop"
	}
	in.Status = strings.TrimSpace(in.Status)
	if in.Status == "" {
		in.Status = "enabled"
	}
	if in.Priority <= 0 {
		in.Priority = 100
	}
	in.AppServerListen = "stdio://"
	in.Remark = strings.TrimSpace(in.Remark)
	if in.TriggerFailureCount < 1 {
		in.TriggerFailureCount = 1
	}
	if in.MaxAttempts < 1 {
		in.MaxAttempts = 2
	}
	if in.TaskTimeoutSeconds < 30 {
		in.TaskTimeoutSeconds = 180
	}
	if in.MaxConcurrency < 1 {
		in.MaxConcurrency = 1
	}
}

func validExecutorConfigInput(in store.ExecutorConfigInput) bool {
	return in.Name != "" &&
		validStatus(in.ExecutorType, "codex") &&
		validStatus(in.RuntimeType, "desktop", "server", "remote") &&
		validStatus(in.Status, "enabled", "disabled")
}

func normalizeExecutorTaskInput(in *store.ExecutorTaskInput) {
	in.ExecutorID = strings.TrimSpace(in.ExecutorID)
	in.ExecutorType = strings.TrimSpace(in.ExecutorType)
	if in.ExecutorType == "" {
		in.ExecutorType = "codex"
	}
	in.TaskType = strings.TrimSpace(in.TaskType)
	if in.TaskType == "" {
		in.TaskType = "script_repair"
	}
	in.Purpose = strings.TrimSpace(in.Purpose)
	in.TriggerReason = strings.TrimSpace(in.TriggerReason)
	in.TargetType = strings.TrimSpace(in.TargetType)
	in.TargetID = strings.TrimSpace(in.TargetID)
	in.WebSpaceID = strings.TrimSpace(in.WebSpaceID)
	in.ScriptID = strings.TrimSpace(in.ScriptID)
	in.ScriptVersionID = strings.TrimSpace(in.ScriptVersionID)
}

func validExecutorTaskInput(in store.ExecutorTaskInput) bool {
	if !validStatus(in.ExecutorType, "codex") || !validStatus(in.TaskType, "script_repair") {
		return false
	}
	if in.Purpose != "" && !validStatus(in.Purpose, "qr_login_prepare", "qr_login_refresh", "account_detect", "session_check") {
		return false
	}
	return in.TriggerReason != ""
}

func parseIntDefault(value string, fallback int) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		return fallback
	}
	return parsed
}

func parseInt64Default(value string, fallback int64) int64 {
	parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil {
		return fallback
	}
	return parsed
}
