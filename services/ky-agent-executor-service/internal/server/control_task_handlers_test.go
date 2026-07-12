package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
)

func TestServerControlCommandsCreateFrozenPendingTasks(t *testing.T) {
	tests := []struct {
		name       string
		path       string
		body       string
		taskType   string
		credential *int64
		catalog    *int64
	}{
		{
			name: "catalog", path: "/api/v1/ai-executors/aiexec_1/model-catalog/refresh",
			body:     `{"expectedExecutorRevision":7,"expectedCatalogRevision":3}`,
			taskType: "model_catalog_refresh", catalog: int64Pointer(3),
		},
		{
			name: "readiness", path: "/api/v1/ai-executors/aiexec_1/readiness/check",
			body:     `{"expectedExecutorRevision":7,"expectedCredentialRevision":2,"expectedCatalogRevision":3}`,
			taskType: "readiness_check", credential: int64Pointer(2), catalog: int64Pointer(3),
		},
		{
			name: "credential", path: "/api/v1/ai-executors/aiexec_1/credential/verify",
			body:     `{"expectedExecutorRevision":7,"expectedCredentialRevision":2}`,
			taskType: "credential_verify", credential: int64Pointer(2),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			control := &fakeControl{}
			runtime := &fakeTaskRuntime{}
			server := controlTestServer(control, &fakeAuthorizer{})
			server.taskRuntime = runtime
			request := publicRequest(t, http.MethodPost, test.path, test.body)
			request.Header.Set("Idempotency-Key", "control-task-0001")
			recorder := httptest.NewRecorder()
			server.buildMux().ServeHTTP(recorder, request)
			if recorder.Code != http.StatusAccepted {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			input := control.controlTask
			if input.TaskType != test.taskType || input.ExecutorID != "aiexec_1" ||
				input.ExpectedExecutorRevision != 7 || input.ActorID != "user_1" ||
				input.WorkspaceType != "platform" || input.WorkspaceID != "platform_root" ||
				input.IdempotencyKeyHash == "" || input.RequestHash == "" || input.ID == "" {
				t.Fatalf("input=%#v", input)
			}
			if !sameOptionalRevision(input.ExpectedCredentialRevision, test.credential) ||
				!sameOptionalRevision(input.ExpectedCatalogRevision, test.catalog) {
				t.Fatalf("revisions input=%#v expected credential=%v catalog=%v", input, test.credential, test.catalog)
			}
			if runtime.wakeCalls != 1 || !strings.Contains(recorder.Body.String(), `"status":"pending"`) {
				t.Fatalf("runtime=%#v body=%s", runtime, recorder.Body.String())
			}
		})
	}
}

func TestServerControlCommandsAreStrictAndFailClosedForDesktop(t *testing.T) {
	control := &fakeControl{}
	request := publicRequest(t, http.MethodPost, "/api/v1/ai-executors/aiexec_1/readiness/check",
		`{"expectedExecutorRevision":7,"expectedCredentialRevision":2,"expectedCatalogRevision":3,"authorized":true}`)
	request.Header.Set("Idempotency-Key", "control-task-0002")
	recorder := httptest.NewRecorder()
	controlTestServer(control, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || control.controlTask.ID != "" {
		t.Fatalf("trust field status=%d body=%s input=%#v", recorder.Code, recorder.Body.String(), control.controlTask)
	}

	control.controlTaskErr = store.ErrExecutorRuntimeUnsupported
	request = publicRequest(t, http.MethodPost, "/api/v1/ai-executors/aiexec_1/credential/verify",
		`{"expectedExecutorRevision":7,"expectedCredentialRevision":2}`)
	request.Header.Set("Idempotency-Key", "control-task-0003")
	recorder = httptest.NewRecorder()
	controlTestServer(control, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnprocessableEntity || !strings.Contains(recorder.Body.String(), "executor_runtime_unsupported") {
		t.Fatalf("desktop fail-closed status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestServerControlCommandRequiresUpdatePermission(t *testing.T) {
	authorizer := &fakeAuthorizer{}
	request := publicRequest(t, http.MethodPost, "/api/v1/ai-executors/aiexec_1/model-catalog/refresh",
		`{"expectedExecutorRevision":7,"expectedCatalogRevision":3}`)
	request.Header.Set("Idempotency-Key", "control-task-0004")
	recorder := httptest.NewRecorder()
	controlTestServer(&fakeControl{}, authorizer).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if len(authorizer.request.RequiredAllPermissions) != 1 ||
		authorizer.request.RequiredAllPermissions[0] != "platform.ai_executors.update" {
		t.Fatalf("decision=%#v", authorizer.request)
	}
}

func sameOptionalRevision(actual, expected *int64) bool {
	if actual == nil || expected == nil {
		return actual == nil && expected == nil
	}
	return *actual == *expected
}

type fakeTaskRuntime struct {
	wakeCalls   int
	cancelCalls []string
}

func (f *fakeTaskRuntime) Wake() { f.wakeCalls++ }
func (f *fakeTaskRuntime) Cancel(taskID string) {
	f.cancelCalls = append(f.cancelCalls, taskID)
}
