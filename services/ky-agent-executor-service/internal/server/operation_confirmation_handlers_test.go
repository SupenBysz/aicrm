package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/accessclient"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/operationconfirmation"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/shared/auth"
)

const operationConfirmationTestAuthSecret = "operation-confirmation-handler-auth-secret"

var operationConfirmationTestDatabaseNow = time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)

type fakeOperationConfirmationRuntime struct {
	action         string
	resolveErr     error
	createInput    operationconfirmation.CreateInput
	createResult   operationconfirmation.CreateResult
	createErr      error
	confirmInput   operationconfirmation.ConfirmInput
	confirmResult  operationconfirmation.ConfirmResult
	confirmErr     error
	resolveID      string
	resolveActor   string
	resolveSession string
	createCalls    int
	confirmCalls   int
	resolveCalls   int
	databaseNow    time.Time
}

func (f *fakeOperationConfirmationRuntime) ResolveOperationConfirmationAction(
	_ context.Context,
	confirmationID string,
	actorID string,
	actorSessionID string,
) (string, error) {
	f.resolveCalls++
	f.resolveID, f.resolveActor, f.resolveSession = confirmationID, actorID, actorSessionID
	return f.action, f.resolveErr
}

func (f *fakeOperationConfirmationRuntime) Create(
	_ context.Context,
	input operationconfirmation.CreateInput,
) (operationconfirmation.CreateResult, error) {
	f.createCalls++
	f.createInput = input
	if err := fakeConfirmationDatabaseAssurance(f.databaseNow, input.OwnerVerified, input.LoginAuthenticatedAt, input.MFARequired, input.MFAVerified); err != nil {
		return operationconfirmation.CreateResult{}, err
	}
	return f.createResult, f.createErr
}

func (f *fakeOperationConfirmationRuntime) Confirm(
	_ context.Context,
	input operationconfirmation.ConfirmInput,
) (operationconfirmation.ConfirmResult, error) {
	f.confirmCalls++
	f.confirmInput = input
	if err := fakeConfirmationDatabaseAssurance(f.databaseNow, input.OwnerVerified, input.LoginAuthenticatedAt, input.MFARequired, input.MFAVerified); err != nil {
		return operationconfirmation.ConfirmResult{}, err
	}
	return f.confirmResult, f.confirmErr
}

func fakeConfirmationDatabaseAssurance(now time.Time, owner bool, authenticatedAt time.Time, mfaRequired, mfaVerified bool) error {
	if !owner {
		return store.ErrOperationConfirmationOwnerRequired
	}
	if mfaRequired && !mfaVerified {
		return store.ErrOperationConfirmationMFARequired
	}
	if !now.IsZero() && (authenticatedAt.After(now) || now.Sub(authenticatedAt) > 10*time.Minute) {
		return store.ErrOperationConfirmationFreshLogin
	}
	return nil
}

type fakeOperationConfirmationAuthorizer struct {
	requests []accessclient.Request
	decision accessclient.Decision
	err      error
}

func (f *fakeOperationConfirmationAuthorizer) Evaluate(
	_ context.Context,
	_ string,
	request accessclient.Request,
) (accessclient.Decision, error) {
	f.requests = append(f.requests, request)
	if f.err != nil {
		return accessclient.Decision{}, f.err
	}
	decision := f.decision
	if decision.ActorID == "" {
		decision.ActorID = request.ActorID
	}
	if decision.WorkspaceType == "" {
		decision.WorkspaceType = request.WorkspaceType
	}
	if decision.WorkspaceID == "" {
		decision.WorkspaceID = request.WorkspaceID
	}
	if decision.GrantedRequiredPermissions == nil && len(request.RequiredAllPermissions) == 1 {
		decision.GrantedRequiredPermissions = append([]string(nil), request.RequiredAllPermissions...)
	}
	return decision, nil
}

func operationConfirmationHandlerServer(
	runtime *fakeOperationConfirmationRuntime,
	authorizer accessclient.Authorizer,
) *Server {
	server := newWithControl(config.Config{
		HTTPAddr: "127.0.0.1:18087", WriteEnabled: true,
		InternalToken: "operation-confirmation-internal", AuthTokenSecret: operationConfirmationTestAuthSecret,
	}, &fakeReader{}, &fakeControl{}, authorizer)
	server.confirmationRuntime = runtime
	return server
}

func validOperationConfirmationAuthorizer(authenticatedAt time.Time) *fakeOperationConfirmationAuthorizer {
	return &fakeOperationConfirmationAuthorizer{decision: accessclient.Decision{
		Allowed: true, MembershipID: "membership_owner_1",
		Assurance: &accessclient.AssuranceFacts{
			Verified: true, WorkspaceOwner: true,
			AuthenticatedAt: authenticatedAt.UTC().Format(time.RFC3339Nano),
			MFARequired:     true, MFAVerified: true,
		},
	}}
}

func operationConfirmationRequest(t *testing.T, path, body string, withIdempotency bool) *http.Request {
	t.Helper()
	token, err := auth.SignToken(operationConfirmationTestAuthSecret, auth.TokenPayload{
		UserID: "owner_1", SessionID: "login_session_1", Exp: time.Now().Add(time.Hour).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-KY-Request-Id", "req-operation-confirmation")
	request.Header.Set("X-KY-Workspace-Type", "platform")
	request.Header.Set("X-KY-Workspace-Id", "platform_root")
	if withIdempotency {
		request.Header.Set("Idempotency-Key", "operation-confirmation-idem-1")
	}
	return request
}

func TestCreateOperationConfirmationUsesExactActionAssuranceAndResponse(t *testing.T) {
	authenticatedAt := operationConfirmationTestDatabaseNow.Add(-10 * time.Minute)
	authorizer := validOperationConfirmationAuthorizer(authenticatedAt)
	runtime := &fakeOperationConfirmationRuntime{
		databaseNow: operationConfirmationTestDatabaseNow,
		createResult: operationconfirmation.CreateResult{
			ConfirmationID: "confirmation_1", ChallengeText: "AICRM-AAAA-BBBB-CCCC-DDDD",
			ExpiresAt: "2026-07-13T00:05:00Z", Created: true,
		},
	}
	target := strings.Repeat("b", 64)
	body := `{"action":"rebind_device","executorId":"executor_1","expectedRevision":3,"targetDeviceId":"` + target + `"}`
	recorder := httptest.NewRecorder()
	operationConfirmationHandlerServer(runtime, authorizer).buildMux().ServeHTTP(
		recorder, operationConfirmationRequest(t, operationConfirmationPath, body, true),
	)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	assertOperationConfirmationNoStore(t, recorder)
	assertExactDataKeys(t, recorder.Body.Bytes(), "confirmationId", "challengeText", "expiresAt")
	if runtime.createCalls != 1 || runtime.createInput.Action != store.OperationConfirmationRebindDevice ||
		runtime.createInput.TargetDeviceID != target || runtime.createInput.ActorID != "owner_1" ||
		runtime.createInput.ActorSessionID != "login_session_1" || runtime.createInput.ExpectedRevision != 3 ||
		!runtime.createInput.OwnerVerified || !runtime.createInput.LoginAuthenticatedAt.Equal(authenticatedAt) ||
		!runtime.createInput.MFARequired || !runtime.createInput.MFAVerified ||
		len(runtime.createInput.IdempotencyKeyHash) != 64 || len(runtime.createInput.RequestHash) != 64 {
		t.Fatalf("create input=%#v", runtime.createInput)
	}
	assertExactAssuranceRequest(t, authorizer.requests, permissionOperationConfirmationRebind)
}

func TestConfirmResolvesPersistedActionBeforeSeparateAssurance(t *testing.T) {
	authenticatedAt := operationConfirmationTestDatabaseNow.Add(-time.Minute)
	authorizer := validOperationConfirmationAuthorizer(authenticatedAt)
	runtime := &fakeOperationConfirmationRuntime{
		action: store.OperationConfirmationForceRevoke, databaseNow: operationConfirmationTestDatabaseNow,
		confirmResult: operationconfirmation.ConfirmResult{
			ConfirmationToken: "trusted.compact.token", ExpiresAt: "2026-07-13T00:05:00Z",
		},
	}
	path := operationConfirmationPath + "/confirmation_1/confirm"
	recorder := httptest.NewRecorder()
	operationConfirmationHandlerServer(runtime, authorizer).buildMux().ServeHTTP(
		recorder, operationConfirmationRequest(t, path, `{"challengeText":"AICRM-AAAA-BBBB-CCCC-DDDD"}`, false),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	assertOperationConfirmationNoStore(t, recorder)
	assertExactDataKeys(t, recorder.Body.Bytes(), "confirmationToken", "expiresAt")
	if runtime.resolveCalls != 1 || runtime.resolveID != "confirmation_1" ||
		runtime.resolveActor != "owner_1" || runtime.resolveSession != "login_session_1" ||
		runtime.confirmCalls != 1 || runtime.confirmInput.ChallengeText != "AICRM-AAAA-BBBB-CCCC-DDDD" {
		t.Fatalf("resolve/confirm runtime=%#v", runtime)
	}
	assertExactAssuranceRequest(t, authorizer.requests, permissionOperationConfirmationForce)
}

func TestOperationConfirmationAssuranceFailsClosed(t *testing.T) {
	tests := []struct {
		name       string
		mutate     func(*fakeOperationConfirmationAuthorizer)
		wantStatus int
	}{
		{"decision denied", func(value *fakeOperationConfirmationAuthorizer) { value.err = accessclient.ErrDenied }, http.StatusForbidden},
		{"permission missing", func(value *fakeOperationConfirmationAuthorizer) {
			value.decision.GrantedRequiredPermissions = []string{"platform.ai_executors.view"}
		}, http.StatusForbidden},
		{"assurance missing", func(value *fakeOperationConfirmationAuthorizer) { value.decision.Assurance = nil }, http.StatusServiceUnavailable},
		{"assurance unverified", func(value *fakeOperationConfirmationAuthorizer) { value.decision.Assurance.Verified = false }, http.StatusServiceUnavailable},
		{"authenticatedAt missing", func(value *fakeOperationConfirmationAuthorizer) { value.decision.Assurance.AuthenticatedAt = "" }, http.StatusServiceUnavailable},
		{"authenticatedAt malformed", func(value *fakeOperationConfirmationAuthorizer) {
			value.decision.Assurance.AuthenticatedAt = "not-time"
		}, http.StatusServiceUnavailable},
		{"owner missing", func(value *fakeOperationConfirmationAuthorizer) { value.decision.Assurance.WorkspaceOwner = false }, http.StatusForbidden},
		{"MFA missing", func(value *fakeOperationConfirmationAuthorizer) { value.decision.Assurance.MFAVerified = false }, http.StatusForbidden},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			authorizer := validOperationConfirmationAuthorizer(operationConfirmationTestDatabaseNow.Add(-time.Minute))
			testCase.mutate(authorizer)
			runtime := &fakeOperationConfirmationRuntime{databaseNow: operationConfirmationTestDatabaseNow}
			recorder := httptest.NewRecorder()
			operationConfirmationHandlerServer(runtime, authorizer).buildMux().ServeHTTP(
				recorder,
				operationConfirmationRequest(t, operationConfirmationPath,
					`{"action":"force_revoke","executorId":"executor_1","expectedRevision":3}`, true),
			)
			if recorder.Code != testCase.wantStatus || runtime.createCalls != 0 {
				t.Fatalf("status=%d calls=%d body=%s", recorder.Code, runtime.createCalls, recorder.Body.String())
			}
			assertOperationConfirmationNoStore(t, recorder)
		})
	}
}

func TestOperationConfirmationDatabaseClockOwnsExactFreshnessBoundary(t *testing.T) {
	for _, testCase := range []struct {
		name            string
		authenticatedAt time.Time
		wantStatus      int
	}{
		{"exact 600 seconds", operationConfirmationTestDatabaseNow.Add(-10 * time.Minute), http.StatusCreated},
		{"older than 600 seconds", operationConfirmationTestDatabaseNow.Add(-10*time.Minute - time.Nanosecond), http.StatusForbidden},
		{"future", operationConfirmationTestDatabaseNow.Add(time.Nanosecond), http.StatusForbidden},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			authorizer := validOperationConfirmationAuthorizer(testCase.authenticatedAt)
			runtime := &fakeOperationConfirmationRuntime{
				databaseNow: operationConfirmationTestDatabaseNow,
				createResult: operationconfirmation.CreateResult{
					ConfirmationID: "confirmation_clock", ChallengeText: "AICRM-CLOCK",
					ExpiresAt: "2026-07-13T00:05:00Z",
				},
			}
			recorder := httptest.NewRecorder()
			operationConfirmationHandlerServer(runtime, authorizer).buildMux().ServeHTTP(
				recorder,
				operationConfirmationRequest(t, operationConfirmationPath,
					`{"action":"force_revoke","executorId":"executor_1","expectedRevision":3}`, true),
			)
			if recorder.Code != testCase.wantStatus {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			if runtime.createCalls != 1 {
				t.Fatalf("HTTP recomputed database freshness: calls=%d", runtime.createCalls)
			}
		})
	}
}

func TestOperationConfirmationStrictTransportAndBodies(t *testing.T) {
	target := strings.Repeat("b", 64)
	tests := []struct {
		name            string
		path            string
		body            string
		withIdempotency bool
		mutate          func(*http.Request)
	}{
		{"missing idempotency", operationConfirmationPath, `{"action":"force_revoke","executorId":"executor_1","expectedRevision":3}`, false, nil},
		{"unknown field", operationConfirmationPath, `{"action":"force_revoke","executorId":"executor_1","expectedRevision":3,"trusted":true}`, true, nil},
		{"duplicate field", operationConfirmationPath, `{"action":"force_revoke","action":"force_revoke","executorId":"executor_1","expectedRevision":3}`, true, nil},
		{"explicit null target", operationConfirmationPath, `{"action":"force_revoke","executorId":"executor_1","expectedRevision":3,"targetDeviceId":null}`, true, nil},
		{"missing rebind target", operationConfirmationPath, `{"action":"rebind_device","executorId":"executor_1","expectedRevision":3}`, true, nil},
		{"bad content type", operationConfirmationPath, `{"action":"force_revoke","executorId":"executor_1","expectedRevision":3}`, true, func(request *http.Request) { request.Header.Set("Content-Type", "text/plain") }},
		{"query", operationConfirmationPath + "?x=1", `{"action":"force_revoke","executorId":"executor_1","expectedRevision":3}`, true, nil},
		{"confirm idempotency", operationConfirmationPath + "/confirmation_1/confirm", `{"challengeText":"AICRM-TEST"}`, true, nil},
		{"confirm unknown field", operationConfirmationPath + "/confirmation_1/confirm", `{"challengeText":"AICRM-TEST","action":"force_revoke"}`, false, nil},
		{"encoded path", operationConfirmationPath + "/confirmation%5F1/confirm", `{"challengeText":"AICRM-TEST"}`, false, nil},
		{"rebind target control", operationConfirmationPath, `{"action":"rebind_device","executorId":"executor_1","expectedRevision":3,"targetDeviceId":"` + target + `"}`, false, nil},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			authorizer := validOperationConfirmationAuthorizer(operationConfirmationTestDatabaseNow.Add(-time.Minute))
			runtime := &fakeOperationConfirmationRuntime{action: store.OperationConfirmationForceRevoke}
			request := operationConfirmationRequest(t, testCase.path, testCase.body, testCase.withIdempotency)
			if testCase.mutate != nil {
				testCase.mutate(request)
			}
			recorder := httptest.NewRecorder()
			operationConfirmationHandlerServer(runtime, authorizer).buildMux().ServeHTTP(recorder, request)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			assertOperationConfirmationNoStore(t, recorder)
			if runtime.createCalls != 0 || runtime.confirmCalls != 0 {
				t.Fatalf("invalid request reached runtime: %#v", runtime)
			}
		})
	}
}

func TestOperationConfirmationRequiresSinglePlatformWorkspaceAndIdempotencyHeaders(t *testing.T) {
	for _, header := range []string{"X-KY-Workspace-Type", "X-KY-Workspace-Id"} {
		t.Run(header, func(t *testing.T) {
			runtime := &fakeOperationConfirmationRuntime{}
			request := operationConfirmationRequest(t, operationConfirmationPath,
				`{"action":"force_revoke","executorId":"executor_1","expectedRevision":3}`, true)
			request.Header.Add(header, request.Header.Get(header))
			recorder := httptest.NewRecorder()
			operationConfirmationHandlerServer(runtime,
				validOperationConfirmationAuthorizer(operationConfirmationTestDatabaseNow)).buildMux().ServeHTTP(recorder, request)
			if recorder.Code != http.StatusForbidden || runtime.createCalls != 0 {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			assertOperationConfirmationNoStore(t, recorder)
		})
	}
	runtime := &fakeOperationConfirmationRuntime{}
	request := operationConfirmationRequest(t, operationConfirmationPath,
		`{"action":"force_revoke","executorId":"executor_1","expectedRevision":3}`, true)
	request.Header.Add("Idempotency-Key", "operation-confirmation-idem-2")
	recorder := httptest.NewRecorder()
	operationConfirmationHandlerServer(runtime,
		validOperationConfirmationAuthorizer(operationConfirmationTestDatabaseNow)).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || runtime.createCalls != 0 {
		t.Fatalf("duplicate idempotency status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestOperationConfirmationErrorLayersAndRuntimeReadiness(t *testing.T) {
	tests := []struct {
		name       string
		runtimeErr error
		wantStatus int
	}{
		{"bad input", operationconfirmation.ErrInvalidInput, http.StatusBadRequest},
		{"assurance", store.ErrOperationConfirmationFreshLogin, http.StatusForbidden},
		{"idempotency", store.ErrIdempotencyReuse, http.StatusConflict},
		{"revision", store.ErrRevisionConflict, http.StatusConflict},
		{"gone", store.ErrOperationConfirmationChallengeExpired, http.StatusGone},
		{"unavailable", operationconfirmation.ErrInvalidConfiguration, http.StatusServiceUnavailable},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			runtime := &fakeOperationConfirmationRuntime{
				databaseNow: operationConfirmationTestDatabaseNow, createErr: testCase.runtimeErr,
			}
			recorder := httptest.NewRecorder()
			operationConfirmationHandlerServer(runtime,
				validOperationConfirmationAuthorizer(operationConfirmationTestDatabaseNow.Add(-time.Minute))).buildMux().ServeHTTP(
				recorder,
				operationConfirmationRequest(t, operationConfirmationPath,
					`{"action":"force_revoke","executorId":"executor_1","expectedRevision":3}`, true),
			)
			if recorder.Code != testCase.wantStatus {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			assertOperationConfirmationNoStore(t, recorder)
		})
	}

	server := newWithControl(config.Config{
		WriteEnabled: true, AuthTokenSecret: operationConfirmationTestAuthSecret,
	}, &fakeReader{}, &fakeControl{}, validOperationConfirmationAuthorizer(operationConfirmationTestDatabaseNow))
	recorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder,
		operationConfirmationRequest(t, operationConfirmationPath,
			`{"action":"force_revoke","executorId":"executor_1","expectedRevision":3}`, true))
	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), "operation_confirmation_unavailable") {
		t.Fatalf("missing runtime status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestReadyzIncludesOperationConfirmationManagerReadiness(t *testing.T) {
	server := newWithControl(config.Config{
		WriteEnabled: true, InternalToken: "ready-internal", AuthTokenSecret: operationConfirmationTestAuthSecret,
		DeviceChallengeSecret: "ready-independent-device-challenge-secret",
	}, &fakeReader{}, &fakeControl{}, validOperationConfirmationAuthorizer(operationConfirmationTestDatabaseNow))
	server.handoffRuntime = &fakeDesktopHandoffRuntime{}
	server.revocationRuntime = &fakeCredentialRevocationRuntime{}
	for _, testCase := range []struct {
		name       string
		runtime    operationConfirmationRuntime
		wantStatus int
	}{
		{"missing", nil, http.StatusServiceUnavailable},
		{"ready", &fakeOperationConfirmationRuntime{}, http.StatusOK},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			server.confirmationRuntime = testCase.runtime
			recorder := httptest.NewRecorder()
			server.buildMux().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
			if recorder.Code != testCase.wantStatus ||
				!strings.Contains(recorder.Body.String(), `"controlReady":`+map[bool]string{true: "true", false: "false"}[testCase.wantStatus == http.StatusOK]) {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestOperationConfirmationCreateAndConfirmEachRequireIndependentDecision(t *testing.T) {
	authorizer := validOperationConfirmationAuthorizer(operationConfirmationTestDatabaseNow.Add(-time.Minute))
	runtime := &fakeOperationConfirmationRuntime{
		action: store.OperationConfirmationUnbindDevice, databaseNow: operationConfirmationTestDatabaseNow,
		createResult: operationconfirmation.CreateResult{
			ConfirmationID: "confirmation_1", ChallengeText: "AICRM-TEST", ExpiresAt: "2026-07-13T00:05:00Z",
		},
		confirmResult: operationconfirmation.ConfirmResult{
			ConfirmationToken: "trusted.token.value", ExpiresAt: "2026-07-13T00:06:00Z",
		},
	}
	server := operationConfirmationHandlerServer(runtime, authorizer)
	createRecorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(createRecorder,
		operationConfirmationRequest(t, operationConfirmationPath,
			`{"action":"unbind_device","executorId":"executor_1","expectedRevision":2}`, true))
	confirmRecorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(confirmRecorder,
		operationConfirmationRequest(t, operationConfirmationPath+"/confirmation_1/confirm",
			`{"challengeText":"AICRM-TEST"}`, false))
	if createRecorder.Code != http.StatusCreated || confirmRecorder.Code != http.StatusOK || len(authorizer.requests) != 2 {
		t.Fatalf("create=%d confirm=%d decisions=%d", createRecorder.Code, confirmRecorder.Code, len(authorizer.requests))
	}
	for _, request := range authorizer.requests {
		if len(request.RequiredAllPermissions) != 1 || request.RequiredAllPermissions[0] != permissionOperationConfirmationRebind {
			t.Fatalf("unexpected action permission: %#v", request)
		}
	}
}

func assertExactAssuranceRequest(t *testing.T, requests []accessclient.Request, permission string) {
	t.Helper()
	if len(requests) != 1 {
		t.Fatalf("assurance decisions=%d", len(requests))
	}
	request := requests[0]
	if request.ActorID != "owner_1" || request.SessionID != "login_session_1" ||
		request.WorkspaceType != "platform" || request.WorkspaceID != "platform_root" ||
		len(request.RequiredAllPermissions) != 1 || request.RequiredAllPermissions[0] != permission ||
		len(request.RequiredAnyPermissions) != 0 || request.Assurance == nil ||
		!request.Assurance.RequireWorkspaceOwner ||
		request.Assurance.MaxAuthenticationAgeSeconds != operationConfirmationMaxAuthAgeSeconds ||
		!request.Assurance.RequireMFAIfEnabled {
		t.Fatalf("assurance request=%#v", request)
	}
}

func assertExactDataKeys(t *testing.T, body []byte, expected ...string) {
	t.Helper()
	var envelope struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if json.Unmarshal(body, &envelope) != nil {
		t.Fatalf("invalid response: %s", body)
	}
	if len(envelope.Data) != len(expected) {
		t.Fatalf("data keys=%v expected=%v", envelope.Data, expected)
	}
	for _, key := range expected {
		if _, ok := envelope.Data[key]; !ok {
			t.Fatalf("missing response key %s: %s", key, body)
		}
	}
}

func assertOperationConfirmationNoStore(t *testing.T, recorder *httptest.ResponseRecorder) {
	t.Helper()
	if recorder.Header().Get("Cache-Control") != "no-store" || recorder.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("no-store headers missing: %#v", recorder.Header())
	}
}
