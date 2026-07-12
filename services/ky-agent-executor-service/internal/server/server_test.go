package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
)

type fakeReader struct {
	pingErr       error
	executor      store.ExecutorProjection
	task          store.TaskProjection
	result        store.TaskResultProjection
	executorCalls int
	taskCalls     int
	resultCalls   int
}

func (f *fakeReader) Ping(context.Context) error { return f.pingErr }

func (f *fakeReader) Executor(_ context.Context, _ string) (store.ExecutorProjection, error) {
	f.executorCalls++
	if f.executor.ID == "" {
		return store.ExecutorProjection{}, store.ErrNotFound
	}
	return f.executor, nil
}

func (f *fakeReader) Task(_ context.Context, _ string) (store.TaskProjection, error) {
	f.taskCalls++
	if f.task.ID == "" {
		return store.TaskProjection{}, store.ErrNotFound
	}
	return f.task, nil
}

func (f *fakeReader) TaskResult(_ context.Context, _ string) (store.TaskResultProjection, error) {
	f.resultCalls++
	if f.result.TaskID == "" {
		return store.TaskResultProjection{}, store.ErrNotFound
	}
	return f.result, nil
}

func testServer(reader *fakeReader) *Server {
	return newWithReader(config.Config{
		HTTPAddr:      "127.0.0.1:18087",
		InternalToken: "test-internal-token",
	}, reader)
}

func internalRequest(method, path, body string) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("X-KY-Internal-Token", "test-internal-token")
	request.Header.Set("X-KY-Request-Id", "req-test-1")
	return request
}

func TestReadyzAlwaysAdvertisesShadowReadOnly(t *testing.T) {
	server := testServer(&fakeReader{})
	recorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("readyz status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	for _, expected := range []string{`"mode":"shadow_read_only"`, `"writeEnabled":false`, `"scriptMaintenanceReady":false`} {
		if !strings.Contains(body, expected) {
			t.Fatalf("readyz missing %s: %s", expected, body)
		}
	}
}

func TestInternalRoutesRequireTokenAndRequestID(t *testing.T) {
	server := testServer(&fakeReader{})
	mux := server.buildMux()

	request := httptest.NewRequest(http.MethodGet, "/internal/v1/executor-tasks/task_1", nil)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("missing token status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "/internal/v1/executor-tasks/task_1", nil)
	request.Header.Set("X-KY-Internal-Token", "test-internal-token")
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "request_id_required") {
		t.Fatalf("missing request id status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	request = internalRequest(http.MethodGet, "/internal/v1/executor-tasks/task_1", "")
	request.Header.Set("X-KY-Workspace-Type", "platform")
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "internal_header_forbidden") {
		t.Fatalf("workspace override status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestCanonicalWritesAreRegisteredButNeverTouchStore(t *testing.T) {
	reader := &fakeReader{}
	mux := testServer(reader).buildMux()
	tests := []struct {
		path string
		body string
	}{
		{"/internal/v1/executor-bindings/resolve", `{not-json`},
		{"/internal/v1/executor-tasks", `{"requestedTaskId":"run_1"}`},
		{"/internal/v1/executor-tasks/run_1/cancel", `{"reason":"test"}`},
	}
	for _, test := range tests {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, internalRequest(http.MethodPost, test.path, test.body))
		if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), "shadow_read_only") {
			t.Fatalf("%s status=%d body=%s", test.path, recorder.Code, recorder.Body.String())
		}
	}
	if reader.executorCalls != 0 || reader.taskCalls != 0 || reader.resultCalls != 0 {
		t.Fatalf("write rejection touched reader: %#v", reader)
	}
}

func TestTaskAndResultAreDedicatedSafeProjections(t *testing.T) {
	reader := &fakeReader{
		task: store.TaskProjection{
			ID: "run_1", WorkspaceType: "agency", WorkspaceID: "agency_1",
			TaskType: "script_repair", ScriptPurpose: "qr_login_prepare",
			Status: "completed", Revision: 2, CurrentSequence: 8,
			FailureCode: "bad code containing raw output", CreatedAt: "2026-07-12T00:00:00Z",
			UpdatedAt: "2026-07-12T00:00:01Z",
		},
		result: store.TaskResultProjection{
			TaskID: "run_1", Status: "completed", Revision: 2,
			SafeResult: json.RawMessage(`{
				"candidateDsl":{"steps":[{"method":"getByKey","key":"login_button"}]},
				"token":"must-not-leak",
				"nested":{"codexHome":"/secret/home","summary":"safe"}
			}`),
		},
	}
	mux := testServer(reader).buildMux()

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, internalRequest(http.MethodGet, "/internal/v1/executor-tasks/run_1", ""))
	if recorder.Code != http.StatusOK {
		t.Fatalf("task status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"failureCode":"unsafe_code_redacted"`) {
		t.Fatalf("unsafe failure code was not redacted: %s", recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, internalRequest(http.MethodGet, "/internal/v1/executor-tasks/run_1/result", ""))
	if recorder.Code != http.StatusOK {
		t.Fatalf("result status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	body, err := io.ReadAll(recorder.Result().Body)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, forbidden := range []string{"must-not-leak", "codexHome", "/secret/home", `"token"`} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("result leaked %q: %s", forbidden, text)
		}
	}
	for _, expected := range []string{"candidateDsl", "getByKey", "login_button", `"summary":"safe"`} {
		if !strings.Contains(text, expected) {
			t.Fatalf("result lost safe field %q: %s", expected, text)
		}
	}
}

func TestExecutorShadowIsNeverEligible(t *testing.T) {
	ready := true
	reader := &fakeReader{executor: store.ExecutorProjection{
		ID: "aiexec_platform_codex", Name: "Codex", ExecutorType: "codex",
		RuntimeType: "server", Status: "enabled", CredentialStatus: "authorized",
		ReadinessStatus: "ready", ScriptMaintenanceReady: ready, WriteEnabled: ready,
		ReadinessReasonCode: "unsafe reason with spaces", UpdatedAt: "2026-07-12T00:00:00Z",
	}}
	// The store implementation hard-codes both booleans false.  A test double
	// cannot bypass the HTTP phase boundary either.
	reader.executor.ScriptMaintenanceReady = false
	reader.executor.WriteEnabled = false
	recorder := httptest.NewRecorder()
	testServer(reader).buildMux().ServeHTTP(recorder, internalRequest(http.MethodGet, "/internal/v1/shadow/executors/aiexec_platform_codex", ""))
	if recorder.Code != http.StatusOK {
		t.Fatalf("executor status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	for _, expected := range []string{`"scriptMaintenanceReady":false`, `"writeEnabled":false`, `"readinessReasonCode":"unsafe_code_redacted"`} {
		if !strings.Contains(body, expected) {
			t.Fatalf("executor projection missing %s: %s", expected, body)
		}
	}
}

func TestP1DoesNotExposeMatrixContextSnapshotIntake(t *testing.T) {
	request := internalRequest(http.MethodGet, "/internal/v1/matrix-account-script-context-snapshots/snapshot_1", "")
	request.Header.Set("X-KY-Executor-Task-Id", "run_1")
	recorder := httptest.NewRecorder()
	testServer(&fakeReader{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("P1 unexpectedly registered Matrix context intake: %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestReadErrorsDoNotLeakDriverDetails(t *testing.T) {
	reader := &errorReader{err: errors.New("postgresql://secret@host/db /credential/path")}
	recorder := httptest.NewRecorder()
	newWithReader(config.Config{HTTPAddr: "127.0.0.1:18087", InternalToken: "test-internal-token"}, reader).
		buildMux().ServeHTTP(recorder, internalRequest(http.MethodGet, "/internal/v1/executor-tasks/run_1", ""))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("unexpected status: %d", recorder.Code)
	}
	for _, forbidden := range []string{"secret@host", "/credential/path", "postgresql://"} {
		if strings.Contains(recorder.Body.String(), forbidden) {
			t.Fatalf("error leaked %q: %s", forbidden, recorder.Body.String())
		}
	}
}

type errorReader struct{ err error }

func (e *errorReader) Ping(context.Context) error { return nil }
func (e *errorReader) Executor(context.Context, string) (store.ExecutorProjection, error) {
	return store.ExecutorProjection{}, e.err
}
func (e *errorReader) Task(context.Context, string) (store.TaskProjection, error) {
	return store.TaskProjection{}, e.err
}
func (e *errorReader) TaskResult(context.Context, string) (store.TaskResultProjection, error) {
	return store.TaskResultProjection{}, e.err
}
