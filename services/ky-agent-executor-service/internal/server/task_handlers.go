package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/accessclient"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
)

var (
	publicTaskStreamPollInterval      = time.Second
	publicTaskStreamHeartbeatInterval = 15 * time.Second
)

func (s *Server) listPublicTasks(w http.ResponseWriter, r *http.Request, actor actorContext) {
	page, pageSize, ok := publicTaskPage(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "task list query is invalid")
		return
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	taskType := strings.TrimSpace(r.URL.Query().Get("taskType"))
	executorID := strings.TrimSpace(r.URL.Query().Get("executorId"))
	if (status != "" && !validTaskStatus(status)) ||
		(taskType != "" && !validTaskType(taskType)) ||
		(executorID != "" && !validOpaqueID(executorID)) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "task list filter is invalid")
		return
	}
	items, total, err := s.control.ListPublicTasks(r.Context(), store.PublicTaskFilter{
		WorkspaceType: actor.WorkspaceType, WorkspaceID: actor.WorkspaceID,
		Status: status, TaskType: taskType, ExecutorID: executorID,
		Page: page, PageSize: pageSize,
	})
	if err != nil {
		s.writeTaskStoreError(w, r, err)
		return
	}
	writeData(w, r, http.StatusOK, map[string]any{
		"items":      items,
		"pagination": map[string]any{"page": page, "pageSize": pageSize, "total": total},
	})
}

func (s *Server) getPublicTask(w http.ResponseWriter, r *http.Request, actor actorContext) {
	item, ok := s.publicTaskFromPath(w, r, actor)
	if !ok {
		return
	}
	writeData(w, r, http.StatusOK, item)
}

func (s *Server) listPublicTaskEvents(w http.ResponseWriter, r *http.Request, actor actorContext) {
	taskID := r.PathValue("taskId")
	if !validOpaqueID(taskID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "taskId is invalid")
		return
	}
	after, limit, ok := authorizationCursor(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "invalid_event_cursor", "event cursor is invalid")
		return
	}
	_, err := s.control.GetPublicTask(r.Context(), taskID, actor.WorkspaceType, actor.WorkspaceID)
	if err != nil {
		s.writeTaskStoreError(w, r, err)
		return
	}
	items, err := s.control.ListPublicTaskEvents(r.Context(), taskID, actor.WorkspaceType, actor.WorkspaceID, after, limit+1)
	if err != nil {
		s.writeTaskStoreError(w, r, err)
		return
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	nextSequence := after
	if len(items) > 0 {
		nextSequence = items[len(items)-1].Sequence
	}
	history := make([]map[string]any, 0, len(items))
	for _, item := range items {
		history = append(history, map[string]any{
			"sequence": item.Sequence, "event": item.EventType,
			"occurredAt": item.OccurredAt, "data": publicTaskEventData(taskID, item),
		})
	}
	writeData(w, r, http.StatusOK, map[string]any{
		"items": history, "nextSequence": nextSequence, "hasMore": hasMore,
	})
}

func (s *Server) streamPublicTaskEvents(w http.ResponseWriter, r *http.Request, actor actorContext) {
	taskID := r.PathValue("taskId")
	if !validOpaqueID(taskID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "taskId is invalid")
		return
	}
	after, ok := publicTaskStreamCursor(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "invalid_event_cursor", "event cursor is invalid")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, r, http.StatusNotImplemented, "stream_unavailable", "event stream is unavailable")
		return
	}
	task, err := s.control.GetPublicTask(r.Context(), taskID, actor.WorkspaceType, actor.WorkspaceID)
	if err != nil {
		s.writeTaskStoreError(w, r, err)
		return
	}
	prepareSSE(w)
	flusher.Flush()
	poll := time.NewTicker(publicTaskStreamPollInterval)
	defer poll.Stop()
	heartbeat := time.NewTicker(publicTaskStreamHeartbeatInterval)
	defer heartbeat.Stop()
	cursor := after
	for {
		for {
			items, err := s.control.ListPublicTaskEvents(r.Context(), taskID, actor.WorkspaceType, actor.WorkspaceID, cursor, 100)
			if err != nil {
				return
			}
			task, err = s.control.GetPublicTask(r.Context(), taskID, actor.WorkspaceType, actor.WorkspaceID)
			if err != nil {
				return
			}
			for _, item := range items {
				if !writeSSE(w, item.Sequence, item.EventType, publicTaskEventData(taskID, item)) {
					return
				}
				cursor = item.Sequence
			}
			if len(items) > 0 {
				flusher.Flush()
			}
			if len(items) < 100 {
				break
			}
		}
		if terminalTaskStatus(task.Status) && cursor >= task.CurrentSequence {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-poll.C:
		case <-heartbeat.C:
			if !s.taskStreamPermissionValid(r, actor) {
				writeConnectionClosed(w, store.TaskEventClosed, "taskId", taskID, "permission_revoked")
				flusher.Flush()
				return
			}
			if _, err := fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *Server) listPublicTaskTerminal(w http.ResponseWriter, r *http.Request, actor actorContext) {
	taskID := r.PathValue("taskId")
	if !validOpaqueID(taskID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "taskId is invalid")
		return
	}
	after, limit, ok := authorizationCursor(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "invalid_event_cursor", "event cursor is invalid")
		return
	}
	if _, err := s.control.GetPublicTask(r.Context(), taskID, actor.WorkspaceType, actor.WorkspaceID); err != nil {
		s.writeTaskStoreError(w, r, err)
		return
	}
	items, err := s.control.ListPublicTaskTerminal(r.Context(), taskID, actor.WorkspaceType, actor.WorkspaceID, after, limit+1)
	if err != nil {
		s.writeTaskStoreError(w, r, err)
		return
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	nextSequence := after
	if len(items) > 0 {
		nextSequence = items[len(items)-1].Sequence
	}
	writeData(w, r, http.StatusOK, map[string]any{
		"items": items, "nextSequence": nextSequence, "hasMore": hasMore,
	})
}

func (s *Server) streamPublicTaskTerminal(w http.ResponseWriter, r *http.Request, actor actorContext) {
	taskID := r.PathValue("taskId")
	if !validOpaqueID(taskID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "taskId is invalid")
		return
	}
	after, ok := publicTaskStreamCursor(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "invalid_event_cursor", "event cursor is invalid")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, r, http.StatusNotImplemented, "stream_unavailable", "terminal stream is unavailable")
		return
	}
	if _, err := s.control.GetPublicTask(r.Context(), taskID, actor.WorkspaceType, actor.WorkspaceID); err != nil {
		s.writeTaskStoreError(w, r, err)
		return
	}
	prepareSSE(w)
	flusher.Flush()
	poll := time.NewTicker(publicTaskStreamPollInterval)
	defer poll.Stop()
	heartbeat := time.NewTicker(publicTaskStreamHeartbeatInterval)
	defer heartbeat.Stop()
	cursor := after
	for {
		for {
			items, err := s.control.ListPublicTaskTerminal(r.Context(), taskID, actor.WorkspaceType, actor.WorkspaceID, cursor, 100)
			if err != nil {
				return
			}
			for _, item := range items {
				event, data := terminalSSEData(taskID, item)
				if !writeSSE(w, item.Sequence, event, data) {
					return
				}
				cursor = item.Sequence
			}
			if len(items) > 0 {
				flusher.Flush()
			}
			if len(items) < 100 {
				break
			}
		}
		closedSequence, err := s.control.PublicTaskTerminalClosedSequence(r.Context(), taskID, actor.WorkspaceType, actor.WorkspaceID)
		if err != nil {
			return
		}
		if closedSequence > 0 && cursor >= closedSequence {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-poll.C:
		case <-heartbeat.C:
			if !s.taskStreamPermissionValid(r, actor) {
				writeConnectionClosed(w, store.TaskTerminalClosed, "runId", taskID, "permission_revoked")
				flusher.Flush()
				return
			}
			if _, err := fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

type cancelPublicTaskBody struct {
	ExpectedRevision int64 `json:"expectedRevision"`
}

func (s *Server) cancelPublicTask(w http.ResponseWriter, r *http.Request, actor actorContext) {
	taskID := r.PathValue("taskId")
	if !validOpaqueID(taskID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "taskId is invalid")
		return
	}
	key, ok := idempotencyKey(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "idempotency_key_required", "a valid Idempotency-Key is required")
		return
	}
	var body cancelPublicTaskBody
	if !decodeStrictJSON(w, r, &body) {
		return
	}
	if body.ExpectedRevision < 1 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "task cancel request is invalid")
		return
	}
	canonical, _ := json.Marshal(body)
	item, transitioned, err := s.control.CancelPublicTask(r.Context(), store.CancelPublicTaskInput{
		TaskID: taskID, ActorID: actor.ActorID,
		WorkspaceType: actor.WorkspaceType, WorkspaceID: actor.WorkspaceID,
		ExpectedRevision:   body.ExpectedRevision,
		IdempotencyKeyHash: sha256Hex([]byte(key)), RequestHash: sha256Hex(canonical),
	})
	if err != nil {
		s.writeTaskStoreError(w, r, err)
		return
	}
	if transitioned && s.taskRuntime != nil {
		s.taskRuntime.Cancel(taskID)
	}
	writeData(w, r, http.StatusOK, item)
}

func (s *Server) publicTaskFromPath(w http.ResponseWriter, r *http.Request, actor actorContext) (store.PublicTaskProjection, bool) {
	taskID := r.PathValue("taskId")
	if !validOpaqueID(taskID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "taskId is invalid")
		return store.PublicTaskProjection{}, false
	}
	item, err := s.control.GetPublicTask(r.Context(), taskID, actor.WorkspaceType, actor.WorkspaceID)
	if err != nil {
		s.writeTaskStoreError(w, r, err)
		return store.PublicTaskProjection{}, false
	}
	return item, true
}

func publicTaskEventData(taskID string, item store.PublicTaskEventProjection) map[string]any {
	item.Payload = sanitizeSafeJSON(item.Payload)
	if item.EventType == store.TaskEventClosed {
		return map[string]any{"taskId": taskID, "sequence": item.Sequence, "reason": "terminal"}
	}
	return map[string]any{
		"taskId": taskID, "sequence": item.Sequence, "occurredAt": item.OccurredAt,
		"event": item, "state": item.Payload,
	}
}

func terminalSSEData(taskID string, item store.PublicTaskTerminalProjection) (string, map[string]any) {
	data := map[string]any{"runId": taskID, "sequence": item.Sequence, "kind": item.Kind}
	switch item.Kind {
	case "frame":
		data["encoding"], data["payload"], data["byteLength"] = item.Encoding, item.Payload, item.ByteLength
		return store.TaskTerminalANSIFrame, data
	case "terminal":
		data["status"] = item.Status
		return store.TaskTerminalTerminal, data
	default:
		data["reason"] = item.Reason
		return store.TaskTerminalClosed, data
	}
}

func publicTaskPage(r *http.Request) (int, int, bool) {
	page, pageSize := 1, 20
	var err error
	if value := r.URL.Query().Get("page"); value != "" {
		page, err = strconv.Atoi(value)
		if err != nil || page < 1 || page > 1_000_000 {
			return 0, 0, false
		}
	}
	if value := r.URL.Query().Get("pageSize"); value != "" {
		pageSize, err = strconv.Atoi(value)
		if err != nil || pageSize < 1 || pageSize > 100 {
			return 0, 0, false
		}
	}
	return page, pageSize, true
}

func publicTaskStreamCursor(r *http.Request) (int64, bool) {
	after, _, ok := authorizationCursor(r)
	values := r.Header.Values("Last-Event-ID")
	if len(values) == 0 {
		return after, ok
	}
	if len(values) != 1 {
		return 0, false
	}
	value := strings.TrimSpace(values[0])
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 0 || value == "" {
		return 0, false
	}
	return parsed, true
}

func prepareSSE(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
}

func writeSSE(w http.ResponseWriter, sequence int64, event string, data any) bool {
	encoded, err := json.Marshal(data)
	if err != nil {
		return false
	}
	_, err = fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", sequence, event, encoded)
	return err == nil
}

func writeConnectionClosed(w http.ResponseWriter, event, resourceKey, resourceID, reason string) {
	encoded, _ := json.Marshal(map[string]any{resourceKey: resourceID, "reason": reason})
	_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, encoded)
}

func (s *Server) taskStreamPermissionValid(r *http.Request, actor actorContext) bool {
	if s.authorizer == nil {
		return false
	}
	_, err := s.authorizer.Evaluate(r.Context(), requestID(r), accessclient.Request{
		ActorID: actor.ActorID, SessionID: actor.SessionID,
		WorkspaceType: actor.WorkspaceType, WorkspaceID: actor.WorkspaceID,
		RequiredAllPermissions: []string{"platform.ai_executor_tasks.view"},
	})
	return err == nil
}

func validTaskStatus(value string) bool {
	switch value {
	case "pending", "waiting_executor", "running", "waiting_user_scan", "completed", "failed", "cancelled", "timeout":
		return true
	default:
		return false
	}
}

func terminalTaskStatus(value string) bool {
	switch value {
	case "completed", "failed", "cancelled", "timeout":
		return true
	default:
		return false
	}
}

func validTaskType(value string) bool {
	switch value {
	case "credential_verify", "model_catalog_refresh", "readiness_check",
		"script_generate", "script_repair", "script_contract_test":
		return true
	default:
		return false
	}
}

func (s *Server) writeTaskStoreError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, r, http.StatusNotFound, "not_found", "task was not found")
	case errors.Is(err, store.ErrRevisionConflict):
		writeError(w, r, http.StatusConflict, "revision_conflict", "task revision changed")
	case errors.Is(err, store.ErrIdempotencyReuse):
		writeError(w, r, http.StatusConflict, "idempotency_key_reused", "Idempotency-Key was reused with another request")
	case errors.Is(err, store.ErrUnsafeProjection):
		writeError(w, r, http.StatusInternalServerError, "task_projection_unavailable", "task projection is unavailable")
	case errors.Is(err, store.ErrConflict):
		writeError(w, r, http.StatusConflict, "conflict", "task operation conflicts with current state")
	default:
		writeError(w, r, http.StatusInternalServerError, "task_operation_failed", "task operation failed")
	}
}
