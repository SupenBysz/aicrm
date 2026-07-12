package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/authorization"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
)

type fakeAuthorizationRuntime struct {
	started   store.AuthorizationSessionProjection
	cancelled string
	action    authorization.UserAction
}

func (f *fakeAuthorizationRuntime) Start(session store.AuthorizationSessionProjection) error {
	f.started = session
	return nil
}
func (f *fakeAuthorizationRuntime) UserAction(string, string) (authorization.UserAction, error) {
	return f.action, nil
}
func (f *fakeAuthorizationRuntime) Cancel(id string)         { f.cancelled = id }
func (f *fakeAuthorizationRuntime) Shutdown(context.Context) {}

func TestServerDeviceAuthorizationNeverProjectsChallengeInSession(t *testing.T) {
	control := &fakeControl{}
	runtime := &fakeAuthorizationRuntime{action: authorization.UserAction{VerificationURL: "https://auth.openai.com/codex/device", UserCode: "ABCD-EFGH", SessionDeadlineAt: "2026-07-12T12:00:00Z"}}
	server := controlTestServer(control, &fakeAuthorizer{})
	server.authRuntime = runtime
	request := publicRequest(t, http.MethodPost, "/api/v1/ai-executors/aiexec_1/authorization-sessions", `{"intent":"authorize"}`)
	request.Header.Set("Idempotency-Key", "authorization-create-0001")
	recorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	for _, forbidden := range []string{"userCode", "verificationUrl", "loginId", "codexHome"} {
		if strings.Contains(recorder.Body.String(), forbidden) {
			t.Fatalf("session leaked %s: %s", forbidden, recorder.Body.String())
		}
	}
	if runtime.started.ID == "" || control.authCreated.ActorID != "user_1" {
		t.Fatalf("runtime=%#v input=%#v", runtime.started, control.authCreated)
	}

	control.session.Status = "waiting_user"
	control.session.Revision = 2
	recorder = httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, publicRequest(t, http.MethodGet, "/api/v1/ai-executor-authorization-sessions/"+control.session.ID+"/user-action", ""))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "ABCD-EFGH") {
		t.Fatalf("user action status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Cache-Control") != "no-store" || recorder.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("unsafe headers: %#v", recorder.Header())
	}

	request = publicRequest(t, http.MethodPost, "/api/v1/ai-executor-authorization-sessions/"+control.session.ID+"/cancel", `{"expectedRevision":2}`)
	request.Header.Set("Idempotency-Key", "authorization-cancel-0001")
	recorder = httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || runtime.cancelled != control.session.ID || control.cancelInput.ExpectedRevision != 2 {
		t.Fatalf("cancel status=%d runtime=%q input=%#v body=%s", recorder.Code, runtime.cancelled, control.cancelInput, recorder.Body.String())
	}
}

func TestAuthorizationRejectsForbiddenTrustFieldsAndInvalidCursor(t *testing.T) {
	control := &fakeControl{}
	server := controlTestServer(control, &fakeAuthorizer{})
	server.authRuntime = &fakeAuthorizationRuntime{}
	request := publicRequest(t, http.MethodPost, "/api/v1/ai-executors/aiexec_1/authorization-sessions", `{"intent":"authorize","authStatus":"authorized"}`)
	request.Header.Set("Idempotency-Key", "authorization-create-0002")
	recorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("trust field status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	control.session = store.AuthorizationSessionProjection{ID: "session_1", Status: "waiting_user"}
	recorder = httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, publicRequest(t, http.MethodGet, "/api/v1/ai-executor-authorization-sessions/session_1/events?after=-1", ""))
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "invalid_event_cursor") {
		t.Fatalf("cursor status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}
