package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/accessclient"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/shared/auth"
)

type fakeControl struct {
	created       store.CreateExecutorInput
	patched       store.ExecutorPatch
	authCreated   store.CreateAuthorizationSessionInput
	session       store.AuthorizationSessionProjection
	events        []store.AuthorizationEventProjection
	eventAfter    int64
	eventLimit    int
	cancelInput   store.CancelAuthorizationInput
	cancelErr     error
	task          store.PublicTaskProjection
	taskEvents    []store.PublicTaskEventProjection
	terminal      []store.PublicTaskTerminalProjection
	taskCancel    store.CancelPublicTaskInput
	taskCancelErr error
}

func (f *fakeControl) Ping(context.Context) error { return nil }
func (f *fakeControl) ListExecutors(context.Context, string, string) ([]store.ExecutorControlProjection, error) {
	return []store.ExecutorControlProjection{{ID: "aiexec_1", ScriptMaintenanceReady: false}}, nil
}
func (f *fakeControl) GetExecutor(context.Context, string, string, string) (store.ExecutorControlProjection, error) {
	return store.ExecutorControlProjection{ID: "aiexec_1"}, nil
}
func (f *fakeControl) CreateExecutor(_ context.Context, input store.CreateExecutorInput, _, _ string) (store.ExecutorControlProjection, error) {
	f.created = input
	return store.ExecutorControlProjection{ID: input.ID, Name: input.Name, ConfigRevision: 1}, nil
}
func (f *fakeControl) PatchExecutor(_ context.Context, _ string, patch store.ExecutorPatch, _, _ string) (store.ExecutorControlProjection, error) {
	f.patched = patch
	return store.ExecutorControlProjection{ID: "aiexec_1", DefaultModelKey: patch.DefaultModelKey, ConfigRevision: patch.ExpectedRevision + 1}, nil
}
func (f *fakeControl) ListModels(context.Context, string, bool) ([]store.ModelProjection, error) {
	return []store.ModelProjection{}, nil
}
func (f *fakeControl) ListWorkspaceGrants(context.Context, string) ([]store.WorkspaceGrantProjection, error) {
	return []store.WorkspaceGrantProjection{}, nil
}
func (f *fakeControl) PutWorkspaceGrant(context.Context, string, string, string, string, string, int64) (store.WorkspaceGrantProjection, error) {
	return store.WorkspaceGrantProjection{ID: "grant_1", Status: "enabled"}, nil
}
func (f *fakeControl) DeleteWorkspaceGrant(context.Context, string, string, string, string, int64) (store.WorkspaceGrantProjection, error) {
	return store.WorkspaceGrantProjection{ID: "grant_1", Status: "disabled"}, nil
}
func (f *fakeControl) CreateAuthorizationSession(_ context.Context, input store.CreateAuthorizationSessionInput) (store.CreateAuthorizationSessionResult, error) {
	f.authCreated = input
	f.session = store.AuthorizationSessionProjection{ID: input.ID, ExecutorID: input.ExecutorID, RuntimeType: "server", FlowType: "device_code", Intent: input.Intent, Status: "starting", Revision: 1, Sequence: 1, RequestedBy: input.ActorID, SessionDeadlineAt: input.Deadline.UTC().Format(time.RFC3339Nano)}
	return store.CreateAuthorizationSessionResult{Session: f.session, Created: true}, nil
}
func (f *fakeControl) GetCurrentAuthorizationSession(context.Context, string) (store.AuthorizationSessionProjection, error) {
	if f.session.ID == "" {
		return store.AuthorizationSessionProjection{}, store.ErrNotFound
	}
	return f.session, nil
}
func (f *fakeControl) GetAuthorizationSession(context.Context, string) (store.AuthorizationSessionProjection, error) {
	if f.session.ID == "" {
		return store.AuthorizationSessionProjection{}, store.ErrNotFound
	}
	return f.session, nil
}
func (f *fakeControl) ListAuthorizationEvents(_ context.Context, _ string, after int64, limit int) ([]store.AuthorizationEventProjection, error) {
	f.eventAfter, f.eventLimit = after, limit
	items := make([]store.AuthorizationEventProjection, 0, limit)
	for _, item := range f.events {
		if item.Sequence > after {
			items = append(items, item)
		}
		if len(items) == limit {
			break
		}
	}
	return items, nil
}
func (f *fakeControl) CancelAuthorizationSession(_ context.Context, input store.CancelAuthorizationInput) (store.AuthorizationSessionProjection, bool, error) {
	f.cancelInput = input
	if f.cancelErr != nil {
		return store.AuthorizationSessionProjection{}, false, f.cancelErr
	}
	f.session.Status = "cancelled"
	f.session.Revision++
	return f.session, true, nil
}
func (f *fakeControl) RecordAuthorizationReopen(context.Context, string, string, string, string) error {
	return nil
}
func (f *fakeControl) FailAuthorizationSession(_ context.Context, id, _ string, status, code string) (store.AuthorizationSessionProjection, error) {
	f.session.ID = id
	f.session.Status = status
	f.session.Failure = &store.SessionFailure{Code: code}
	return f.session, nil
}
func (f *fakeControl) RecoverInterruptedAuthorizationSessions(context.Context, string) ([]store.AuthorizationRecoveryItem, error) {
	return nil, nil
}
func (f *fakeControl) ListPublicTasks(context.Context, store.PublicTaskFilter) ([]store.PublicTaskProjection, int64, error) {
	if f.task.ID == "" {
		return []store.PublicTaskProjection{}, 0, nil
	}
	return []store.PublicTaskProjection{f.task}, 1, nil
}
func (f *fakeControl) GetPublicTask(context.Context, string, string, string) (store.PublicTaskProjection, error) {
	if f.task.ID == "" {
		return store.PublicTaskProjection{}, store.ErrNotFound
	}
	return f.task, nil
}
func (f *fakeControl) ListPublicTaskEvents(_ context.Context, _ string, _, _ string, after int64, limit int) ([]store.PublicTaskEventProjection, error) {
	items := make([]store.PublicTaskEventProjection, 0, limit)
	for _, item := range f.taskEvents {
		if item.Sequence > after {
			items = append(items, item)
		}
		if len(items) == limit {
			break
		}
	}
	return items, nil
}
func (f *fakeControl) ListPublicTaskTerminal(_ context.Context, _ string, _, _ string, after int64, limit int) ([]store.PublicTaskTerminalProjection, error) {
	items := make([]store.PublicTaskTerminalProjection, 0, limit)
	for _, item := range f.terminal {
		if item.Sequence > after {
			items = append(items, item)
		}
		if len(items) == limit {
			break
		}
	}
	return items, nil
}
func (f *fakeControl) PublicTaskTerminalClosedSequence(context.Context, string, string, string) (int64, error) {
	for index := len(f.terminal) - 1; index >= 0; index-- {
		if f.terminal[index].Kind == "closed" {
			return f.terminal[index].Sequence, nil
		}
	}
	return 0, nil
}
func (f *fakeControl) CancelPublicTask(_ context.Context, input store.CancelPublicTaskInput) (store.PublicTaskProjection, bool, error) {
	f.taskCancel = input
	if f.taskCancelErr != nil {
		return store.PublicTaskProjection{}, false, f.taskCancelErr
	}
	transitioned := !terminalTaskStatus(f.task.Status)
	if transitioned {
		f.task.Status = "cancelled"
		f.task.Revision++
		f.task.CurrentSequence += 3
	}
	return f.task, transitioned, nil
}

type fakeAuthorizer struct {
	request accessclient.Request
	err     error
	granted []string
}

func (f *fakeAuthorizer) Evaluate(_ context.Context, _ string, request accessclient.Request) (accessclient.Decision, error) {
	f.request = request
	if f.err != nil {
		return accessclient.Decision{}, f.err
	}
	granted := append([]string{}, request.RequiredAllPermissions...)
	if f.granted != nil {
		granted = append(granted, f.granted...)
	} else if len(request.RequiredAnyPermissions) > 0 {
		// Model the least-privileged caller by default. Tests that need owner
		// powers must opt in explicitly instead of receiving every requiredAny.
		granted = append(granted, request.RequiredAnyPermissions[0])
	}
	return accessclient.Decision{
		Allowed: true, ActorID: request.ActorID, MembershipID: "membership_1",
		WorkspaceType: request.WorkspaceType, WorkspaceID: request.WorkspaceID,
		GrantedRequiredPermissions: granted,
	}, nil
}

func controlTestServer(control *fakeControl, authorizer accessclient.Authorizer) *Server {
	return newWithControl(config.Config{
		HTTPAddr: "127.0.0.1:18087", WriteEnabled: true,
		InternalToken: "internal", AuthTokenSecret: "auth-secret",
	}, &fakeReader{}, control, authorizer)
}

func publicRequest(t *testing.T, method, path, body string) *http.Request {
	t.Helper()
	token, err := auth.SignToken("auth-secret", auth.TokenPayload{
		UserID: "user_1", SessionID: "session_1", Exp: time.Now().Add(time.Hour).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-KY-Workspace-Type", "platform")
	request.Header.Set("X-KY-Workspace-Id", "platform_root")
	request.Header.Set("X-KY-Request-Id", "req-control-test")
	return request
}

func TestPublicControlRequiresMembershipDecision(t *testing.T) {
	authorizer := &fakeAuthorizer{err: accessclient.ErrDenied}
	recorder := httptest.NewRecorder()
	controlTestServer(&fakeControl{}, authorizer).buildMux().ServeHTTP(recorder,
		publicRequest(t, http.MethodGet, "/api/v1/ai-executors", ""))
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "permission_denied") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if len(authorizer.request.RequiredAllPermissions) != 1 || authorizer.request.RequiredAllPermissions[0] != "platform.ai_executors.view" {
		t.Fatalf("unexpected decision request: %#v", authorizer.request)
	}
}

func TestCreateExecutorIsStrictIdempotentAndFailClosedByDefault(t *testing.T) {
	control := &fakeControl{}
	recorder := httptest.NewRecorder()
	request := publicRequest(t, http.MethodPost, "/api/v1/ai-executors", `{"name":"Server Codex","runtimeType":"server"}`)
	request.Header.Set("Idempotency-Key", "executor-create-0001")
	controlTestServer(control, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if control.created.AllowScriptSave || control.created.AutoRepairEnabled || control.created.IdempotencyKeyHash == "" || control.created.RequestHash == "" {
		t.Fatalf("unsafe create defaults: %#v", control.created)
	}
	if control.created.RuntimeType != "server" || control.created.ActorID != "user_1" {
		t.Fatalf("unexpected create: %#v", control.created)
	}

	recorder = httptest.NewRecorder()
	request = publicRequest(t, http.MethodPost, "/api/v1/ai-executors", `{"name":"x","runtimeType":"server","credentialStatus":"authorized"}`)
	request.Header.Set("Idempotency-Key", "executor-create-0002")
	controlTestServer(control, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("forbidden authorization field status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestPatchSupportsNullableDefaultModelButRejectsTrustFields(t *testing.T) {
	control := &fakeControl{}
	recorder := httptest.NewRecorder()
	request := publicRequest(t, http.MethodPatch, "/api/v1/ai-executors/aiexec_1", `{"expectedRevision":3,"defaultModelKey":null,"allowScriptSave":true}`)
	controlTestServer(control, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !control.patched.DefaultModelKeySet || control.patched.DefaultModelKey != nil || !control.patched.AllowScriptSave {
		t.Fatalf("patch=%#v status=%d body=%s", control.patched, recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	request = publicRequest(t, http.MethodPatch, "/api/v1/ai-executors/aiexec_1", `{"expectedRevision":4,"readinessStatus":"ready"}`)
	controlTestServer(control, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("trust field status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestPublicRoutesStayDisabledInProductionShadowMode(t *testing.T) {
	recorder := httptest.NewRecorder()
	testServer(&fakeReader{}).buildMux().ServeHTTP(recorder,
		httptest.NewRequest(http.MethodGet, "/api/v1/ai-executors", nil))
	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), "control_plane_disabled") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}
