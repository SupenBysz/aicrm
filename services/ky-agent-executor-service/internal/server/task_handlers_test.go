package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/accessclient"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
)

func TestPublicTaskHistoryUsesCanonicalEnvelope(t *testing.T) {
	control := terminalTaskControl()
	recorder := httptest.NewRecorder()
	controlTestServer(control, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder,
		publicRequest(t, http.MethodGet, "/api/v1/ai-executor-tasks/task_1/events?after=0&limit=2", ""))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	for _, expected := range []string{
		`"nextSequence":2`, `"hasMore":true`, `"event":"executor.task.terminal"`,
		`"state":{"status":"pending"}`,
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("history missing %s: %s", expected, body)
		}
	}
	if strings.Contains(body, `"task":`) {
		t.Fatalf("history replay used the latest task snapshot as an event-time snapshot: %s", body)
	}
}

func TestPublicTaskEventSSELastEventIDWinsAndReplaysTerminalClosed(t *testing.T) {
	control := terminalTaskControl()
	request := publicRequest(t, http.MethodGet, "/api/v1/ai-executor-tasks/task_1/events-stream?after=0", "")
	request.Header.Set("Last-Event-ID", "1")
	recorder := httptest.NewRecorder()
	controlTestServer(control, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	if strings.Contains(body, "id: 1\n") {
		t.Fatalf("query cursor overrode Last-Event-ID: %s", body)
	}
	for _, expected := range []string{
		"id: 2\nevent: executor.task.terminal",
		"id: 3\nevent: executor.task.stream.closed",
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("SSE missing %q: %s", expected, body)
		}
	}
}

func TestPublicTaskSSERejectsRepeatedLastEventID(t *testing.T) {
	request := publicRequest(t, http.MethodGet, "/api/v1/ai-executor-tasks/task_1/events-stream?after=0", "")
	request.Header.Add("Last-Event-ID", "1")
	request.Header.Add("Last-Event-ID", "2")
	recorder := httptest.NewRecorder()
	controlTestServer(terminalTaskControl(), &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "invalid_event_cursor") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestPublicTaskTerminalSSEReplaysPersistentTerminalAndClosed(t *testing.T) {
	control := terminalTaskControl()
	request := publicRequest(t, http.MethodGet, "/api/v1/ai-executor-tasks/task_1/terminal-stream?after=10", "")
	recorder := httptest.NewRecorder()
	controlTestServer(control, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	for _, expected := range []string{
		"id: 11\nevent: executor.task.ansi-frame",
		"id: 12\nevent: executor.task.terminal",
		"id: 13\nevent: executor.task.stream-closed",
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("terminal SSE missing %q: %s", expected, body)
		}
	}
}

func TestPublicTaskSSEHeartbeatIsFifteenSecondsAndRechecksAccess(t *testing.T) {
	if publicTaskStreamHeartbeatInterval != 15*time.Second {
		t.Fatalf("heartbeat interval=%s", publicTaskStreamHeartbeatInterval)
	}
	originalHeartbeat, originalPoll := publicTaskStreamHeartbeatInterval, publicTaskStreamPollInterval
	publicTaskStreamHeartbeatInterval = 5 * time.Millisecond
	publicTaskStreamPollInterval = time.Hour
	defer func() {
		publicTaskStreamHeartbeatInterval = originalHeartbeat
		publicTaskStreamPollInterval = originalPoll
	}()

	control := &fakeControl{task: store.PublicTaskProjection{
		ID: "task_1", WorkspaceType: "platform", WorkspaceID: "platform_root",
		Status: "running", Revision: 2, CurrentSequence: 1,
	}}
	authorizer := &denyAfterInitialAuthorizer{}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	request := publicRequest(t, http.MethodGet, "/api/v1/ai-executor-tasks/task_1/events-stream?after=1", "").WithContext(ctx)
	writer := newSSETestWriter()
	done := make(chan struct{})
	go func() {
		controlTestServer(control, authorizer).buildMux().ServeHTTP(writer, request)
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("SSE did not close after access was revoked")
	}
	body := writer.String()
	if !strings.Contains(body, "event: executor.task.stream.closed") ||
		!strings.Contains(body, `"taskId":"task_1"`) ||
		!strings.Contains(body, `"reason":"permission_revoked"`) {
		t.Fatalf("connection close missing: %s", body)
	}
	if strings.Contains(body, `"runId":`) {
		t.Fatalf("event stream used the terminal-stream resource envelope: %s", body)
	}
	if strings.Contains(body, "id:") {
		t.Fatalf("connection-level close must not have an id: %s", body)
	}
	if authorizer.Calls() < 2 {
		t.Fatalf("membership/session/workspace access was not rechecked: calls=%d", authorizer.Calls())
	}
}

func TestTaskConnectionClosedUsesStreamSpecificNamespace(t *testing.T) {
	tests := []struct {
		event       string
		resourceKey string
		want        string
		forbidden   string
	}{
		{store.TaskEventClosed, "taskId", `"taskId":"task_1"`, `"runId":`},
		{store.TaskTerminalClosed, "runId", `"runId":"task_1"`, `"taskId":`},
	}
	for _, test := range tests {
		recorder := httptest.NewRecorder()
		writeConnectionClosed(recorder, test.event, test.resourceKey, "task_1", "permission_revoked")
		body := recorder.Body.String()
		if !strings.Contains(body, "event: "+test.event) || !strings.Contains(body, test.want) ||
			strings.Contains(body, test.forbidden) || strings.Contains(body, "id:") {
			t.Fatalf("event=%s body=%s", test.event, body)
		}
	}
}

func TestPublicTaskSSEWritesHeartbeatWithoutBusinessID(t *testing.T) {
	originalHeartbeat, originalPoll := publicTaskStreamHeartbeatInterval, publicTaskStreamPollInterval
	publicTaskStreamHeartbeatInterval = 5 * time.Millisecond
	publicTaskStreamPollInterval = time.Hour
	defer func() {
		publicTaskStreamHeartbeatInterval = originalHeartbeat
		publicTaskStreamPollInterval = originalPoll
	}()
	control := &fakeControl{task: store.PublicTaskProjection{
		ID: "task_1", WorkspaceType: "platform", WorkspaceID: "platform_root",
		Status: "running", Revision: 2, CurrentSequence: 1,
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	request := publicRequest(t, http.MethodGet, "/api/v1/ai-executor-tasks/task_1/events-stream?after=1", "").WithContext(ctx)
	writer := newSSETestWriter()
	done := make(chan struct{})
	go func() {
		controlTestServer(control, &fakeAuthorizer{}).buildMux().ServeHTTP(writer, request)
		close(done)
	}()
	<-done
	body := writer.String()
	if !strings.Contains(body, ": heartbeat\n\n") {
		t.Fatalf("heartbeat was not emitted: %s", body)
	}
	if strings.Contains(body, "id:") {
		t.Fatalf("heartbeat must not advance the persistent cursor: %s", body)
	}
}

func TestCancelPublicTaskRequiresRevisionAndIdempotency(t *testing.T) {
	control := &fakeControl{task: store.PublicTaskProjection{
		ID: "task_1", WorkspaceType: "platform", WorkspaceID: "platform_root",
		Status: "running", Revision: 4, CurrentSequence: 2,
	}}
	request := publicRequest(t, http.MethodPost, "/api/v1/ai-executor-tasks/task_1/cancel", `{"expectedRevision":4}`)
	request.Header.Set("Idempotency-Key", "cancel-task-0001")
	recorder := httptest.NewRecorder()
	controlTestServer(control, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || control.taskCancel.ExpectedRevision != 4 ||
		control.taskCancel.IdempotencyKeyHash == "" || control.taskCancel.RequestHash == "" {
		t.Fatalf("cancel=%#v status=%d body=%s", control.taskCancel, recorder.Code, recorder.Body.String())
	}
	if control.task.Status != "cancelled" || control.task.CurrentSequence != 5 {
		t.Fatalf("task did not become terminal: %#v", control.task)
	}
}

func terminalTaskControl() *fakeControl {
	payload := base64.StdEncoding.EncodeToString([]byte("Task completed"))
	return &fakeControl{
		task: store.PublicTaskProjection{
			ID: "task_1", WorkspaceType: "platform", WorkspaceID: "platform_root",
			ExecutorID: "aiexec_1", ExecutorType: "codex", TaskType: "readiness_check",
			Status: "completed", Revision: 3, CurrentSequence: 3,
		},
		taskEvents: []store.PublicTaskEventProjection{
			{ID: "event_1", TaskID: "task_1", Sequence: 1, EventType: store.TaskEventChanged, Level: "info", Payload: []byte(`{"status":"pending"}`), OccurredAt: "2026-07-12T00:00:00Z"},
			{ID: "event_2", TaskID: "task_1", Sequence: 2, EventType: store.TaskEventTerminal, Level: "success", Payload: []byte(`{"status":"completed"}`), OccurredAt: "2026-07-12T00:00:01Z"},
			{ID: "event_3", TaskID: "task_1", Sequence: 3, EventType: store.TaskEventClosed, Level: "info", Payload: []byte(`{"reason":"terminal"}`), OccurredAt: "2026-07-12T00:00:02Z"},
		},
		terminal: []store.PublicTaskTerminalProjection{
			{Sequence: 11, Kind: "frame", Encoding: "base64", Payload: payload, ByteLength: len("Task completed")},
			{Sequence: 12, Kind: "terminal", Status: "completed"},
			{Sequence: 13, Kind: "closed", Reason: "terminal"},
		},
	}
}

type denyAfterInitialAuthorizer struct {
	mu    sync.Mutex
	calls int
}

func (a *denyAfterInitialAuthorizer) Evaluate(_ context.Context, _ string, request accessclient.Request) (accessclient.Decision, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls++
	if a.calls > 1 {
		return accessclient.Decision{}, accessclient.ErrDenied
	}
	return accessclient.Decision{
		Allowed: true, ActorID: request.ActorID, MembershipID: "membership_1",
		WorkspaceType: request.WorkspaceType, WorkspaceID: request.WorkspaceID,
		GrantedRequiredPermissions: request.RequiredAllPermissions,
	}, nil
}

func (a *denyAfterInitialAuthorizer) Calls() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.calls
}

type sseTestWriter struct {
	mu     sync.Mutex
	header http.Header
	status int
	body   bytes.Buffer
}

func newSSETestWriter() *sseTestWriter {
	return &sseTestWriter{header: make(http.Header)}
}

func (w *sseTestWriter) Header() http.Header { return w.header }

func (w *sseTestWriter) WriteHeader(status int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.status == 0 {
		w.status = status
	}
}

func (w *sseTestWriter) Write(value []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.body.Write(value)
}

func (w *sseTestWriter) Flush() {}

func (w *sseTestWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.body.String()
}
