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

	request = publicRequest(t, http.MethodPost, "/api/v1/ai-executor-authorization-sessions/"+control.session.ID+"/cancel", `{"expectedSessionRevision":2}`)
	request.Header.Set("Idempotency-Key", "authorization-cancel-0001")
	recorder = httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || runtime.cancelled != control.session.ID || control.cancelInput.ExpectedRevision != 2 || control.cancelInput.CanCancelAny {
		t.Fatalf("cancel status=%d runtime=%q input=%#v body=%s", recorder.Code, runtime.cancelled, control.cancelInput, recorder.Body.String())
	}
}

func TestAuthorizationCancelUsesCanonicalBodyAndRequesterGuard(t *testing.T) {
	control := &fakeControl{session: store.AuthorizationSessionProjection{
		ID: "session_1", Status: "waiting_user", Revision: 2, RequestedBy: "user_1",
	}}
	server := controlTestServer(control, &fakeAuthorizer{})
	server.authRuntime = &fakeAuthorizationRuntime{}

	request := publicRequest(t, http.MethodPost, "/api/v1/ai-executor-authorization-sessions/session_1/cancel", `{"expectedRevision":2}`)
	request.Header.Set("Idempotency-Key", "authorization-cancel-old-body")
	recorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("legacy body status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	control.cancelErr = store.ErrRequesterMismatch
	request = publicRequest(t, http.MethodPost, "/api/v1/ai-executor-authorization-sessions/session_1/cancel", `{"expectedSessionRevision":2}`)
	request.Header.Set("Idempotency-Key", "authorization-cancel-requester-guard")
	recorder = httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "permission_denied") {
		t.Fatalf("requester guard status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if server.authRuntime.(*fakeAuthorizationRuntime).cancelled != "" {
		t.Fatal("runtime was cancelled after the store rejected the requester")
	}
}

func TestAuthorizationOwnerCancelAndIntentPermissionAreExplicit(t *testing.T) {
	control := &fakeControl{session: store.AuthorizationSessionProjection{
		ID: "session_1", Status: "waiting_user", Revision: 2, RequestedBy: "user_2",
	}}
	owner := &fakeAuthorizer{granted: []string{"platform.ai_executors.force_revoke"}}
	server := controlTestServer(control, owner)
	server.authRuntime = &fakeAuthorizationRuntime{}
	request := publicRequest(t, http.MethodPost, "/api/v1/ai-executor-authorization-sessions/session_1/cancel", `{"expectedSessionRevision":2}`)
	request.Header.Set("Idempotency-Key", "authorization-owner-cancel")
	recorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !control.cancelInput.CanCancelAny {
		t.Fatalf("owner cancel status=%d input=%#v body=%s", recorder.Code, control.cancelInput, recorder.Body.String())
	}

	control = &fakeControl{}
	changeOnly := &fakeAuthorizer{granted: []string{"platform.ai_executors.change_account"}}
	request = publicRequest(t, http.MethodPost, "/api/v1/ai-executors/aiexec_1/authorization-sessions", `{"intent":"authorize"}`)
	request.Header.Set("Idempotency-Key", "authorization-wrong-intent-permission")
	recorder = httptest.NewRecorder()
	controlTestServer(control, changeOnly).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden || control.authCreated.ID != "" {
		t.Fatalf("intent permission status=%d input=%#v body=%s", recorder.Code, control.authCreated, recorder.Body.String())
	}
}

func TestAuthorizationEventHistoryAndTerminalStreamFollowLockedContract(t *testing.T) {
	control := &fakeControl{
		session: store.AuthorizationSessionProjection{
			ID: "session_1", ExecutorID: "aiexec_1", Status: "cancelled",
			Revision: 3, Sequence: 3, AccountSummary: []byte(`{}`),
		},
		events: []store.AuthorizationEventProjection{
			{Sequence: 1, EventType: store.AuthorizationEventChanged, OccurredAt: "2026-07-12T12:00:00Z", SafePayload: []byte(`{"userCode":"CANARY-SECRET"}`)},
			{Sequence: 2, EventType: store.AuthorizationEventTerminal, OccurredAt: "2026-07-12T12:00:01Z"},
			{Sequence: 3, EventType: store.AuthorizationEventClosed, OccurredAt: "2026-07-12T12:00:02Z"},
		},
	}
	server := controlTestServer(control, &fakeAuthorizer{})

	recorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, publicRequest(t, http.MethodGet, "/api/v1/ai-executor-authorization-sessions/session_1/events?after=0&limit=2", ""))
	if recorder.Code != http.StatusOK || control.eventLimit != 3 {
		t.Fatalf("history status=%d limit=%d body=%s", recorder.Code, control.eventLimit, recorder.Body.String())
	}
	for _, expected := range []string{`"nextSequence":2`, `"hasMore":true`} {
		if !strings.Contains(recorder.Body.String(), expected) {
			t.Fatalf("history missing %s: %s", expected, recorder.Body.String())
		}
	}
	if strings.Contains(recorder.Body.String(), "CANARY-SECRET") {
		t.Fatalf("history exposed stored payload: %s", recorder.Body.String())
	}

	request := publicRequest(t, http.MethodGet, "/api/v1/ai-executor-authorization-sessions/session_1/events-stream?after=-1", "")
	request.Header.Set("Last-Event-ID", "1")
	recorder = httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || recorder.Header().Get("X-Accel-Buffering") != "no" {
		t.Fatalf("stream status=%d headers=%#v body=%s", recorder.Code, recorder.Header(), recorder.Body.String())
	}
	body := recorder.Body.String()
	if strings.Contains(body, "id: 1\n") || strings.Contains(body, "CANARY-SECRET") {
		t.Fatalf("stream replayed old or unsafe data: %s", body)
	}
	terminal := "id: 2\nevent: " + store.AuthorizationEventTerminal
	closed := "id: 3\nevent: " + store.AuthorizationEventClosed
	if !strings.Contains(body, terminal) || !strings.Contains(body, closed) || strings.Index(body, terminal) > strings.Index(body, closed) {
		t.Fatalf("terminal stream order is invalid: %s", body)
	}
	if !strings.Contains(body, `"sessionId":"session_1"`) ||
		!strings.Contains(body, `"sequence":3`) || !strings.Contains(body, `"reason":"terminal"`) {
		t.Fatalf("closed envelope is invalid: %s", body)
	}
}

func TestAuthorizationStreamRejectsMultipleLastEventIDs(t *testing.T) {
	control := &fakeControl{session: store.AuthorizationSessionProjection{ID: "session_1", Status: "waiting_user"}}
	request := publicRequest(t, http.MethodGet, "/api/v1/ai-executor-authorization-sessions/session_1/events-stream", "")
	request.Header.Add("Last-Event-ID", "1")
	request.Header.Add("Last-Event-ID", "2")
	recorder := httptest.NewRecorder()
	controlTestServer(control, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "invalid_event_cursor") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
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
