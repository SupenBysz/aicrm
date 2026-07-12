package server

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/desktopcommand"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
)

type fakeDesktopAuthorizationCommandRuntime struct {
	cancelInput  desktopcommand.CreateInput
	cancelResult store.CreateDesktopAuthorizationCommandResult
	cancelErr    error
	cancelCalls  int
	reopenInput  desktopcommand.CreateInput
	reopenResult store.CreateDesktopAuthorizationCommandResult
	reopenErr    error
	reopenCalls  int
	ackInput     store.AcknowledgeDesktopAuthorizationCommandInput
	ackTicket    string
	ackResult    store.AcknowledgeDesktopAuthorizationCommandResult
	ackErr       error
	ackCalls     int
}

func (f *fakeDesktopAuthorizationCommandRuntime) Cancel(
	_ context.Context,
	input desktopcommand.CreateInput,
) (store.CreateDesktopAuthorizationCommandResult, error) {
	f.cancelCalls++
	f.cancelInput = input
	return f.cancelResult, f.cancelErr
}

func (f *fakeDesktopAuthorizationCommandRuntime) Reopen(
	_ context.Context,
	input desktopcommand.CreateInput,
) (store.CreateDesktopAuthorizationCommandResult, error) {
	f.reopenCalls++
	f.reopenInput = input
	return f.reopenResult, f.reopenErr
}

func (f *fakeDesktopAuthorizationCommandRuntime) Acknowledge(
	_ context.Context,
	input store.AcknowledgeDesktopAuthorizationCommandInput,
	ticket string,
) (store.AcknowledgeDesktopAuthorizationCommandResult, error) {
	f.ackCalls++
	f.ackInput = input
	f.ackTicket = ticket
	return f.ackResult, f.ackErr
}

type fakeDesktopAuthorizationCommandControl struct {
	fakeControl
	verificationKey store.DeviceVerificationKey
	verificationErr error
}

func (f *fakeDesktopAuthorizationCommandControl) GetDeviceVerificationKey(
	_ context.Context,
	_ string,
) (store.DeviceVerificationKey, error) {
	return f.verificationKey, f.verificationErr
}

func desktopAuthorizationCommandHandlerServer(
	control *fakeDesktopAuthorizationCommandControl,
	runtime *fakeDesktopAuthorizationCommandRuntime,
) *Server {
	server := newWithControl(config.Config{
		WriteEnabled: true, InternalToken: "desktop-command-internal",
		AuthTokenSecret:       "auth-secret",
		DeviceChallengeSecret: "desktop-command-independent-device-challenge",
	}, &fakeReader{}, control, &fakeAuthorizer{})
	server.confirmationRuntime = &fakeOperationConfirmationRuntime{}
	server.handoffRuntime = &fakeDesktopHandoffRuntime{}
	server.activationRuntime = &fakeDesktopActivationRuntime{}
	server.revocationRuntime = &fakeCredentialRevocationRuntime{}
	if runtime != nil {
		server.desktopCommandRuntime = runtime
	}
	return server
}

func TestDesktopAuthorizationCancelAndReopenReturnTrustedCommandEnvelopes(t *testing.T) {
	expiresAt := "2026-07-13T04:02:00Z"
	control := &fakeDesktopAuthorizationCommandControl{fakeControl: fakeControl{session: store.AuthorizationSessionProjection{
		ID: "auth_desktop_command_1", ExecutorID: "executor_desktop_1",
		RuntimeType: "desktop", FlowType: "browser", Status: "waiting_user",
		Revision: 2, Sequence: 2, RequestedBy: "user_1",
	}}}
	runtime := &fakeDesktopAuthorizationCommandRuntime{
		cancelResult: store.CreateDesktopAuthorizationCommandResult{
			Session: store.AuthorizationSessionProjection{
				ID: "auth_desktop_command_1", ExecutorID: "executor_desktop_1",
				RuntimeType: "desktop", FlowType: "browser", Status: "cancelled", Revision: 3, Sequence: 5,
			},
			Command: store.DesktopAuthorizationCommandProjection{
				OperationID: "desktop_command_cancel_1", SessionID: "auth_desktop_command_1",
				ExpectedSessionRevision: 2, ExpiresAt: expiresAt,
			},
			CommandTicket: "cancel.command.ticket", CommandCreated: true, Transitioned: true,
		},
		reopenResult: store.CreateDesktopAuthorizationCommandResult{
			Session: control.session,
			Command: store.DesktopAuthorizationCommandProjection{
				OperationID: "desktop_command_reopen_1", SessionID: "auth_desktop_command_1",
				ExpectedSessionRevision: 2, ExpiresAt: expiresAt,
			},
			CommandTicket: "reopen.command.ticket", CommandCreated: true,
		},
	}
	server := desktopAuthorizationCommandHandlerServer(control, runtime)
	server.authRuntime = &fakeAuthorizationRuntime{}

	cancelPath := authorizationSessionActionPath(control.session.ID, "cancel")
	cancelRequest := publicRequest(t, http.MethodPost, cancelPath, `{"expectedSessionRevision":2}`)
	cancelRequest.Header.Set("Idempotency-Key", "desktop-command-cancel-0001")
	cancelRecorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(cancelRecorder, cancelRequest)
	if cancelRecorder.Code != http.StatusAccepted ||
		!strings.Contains(cancelRecorder.Body.String(), `"commandTicket":"cancel.command.ticket"`) ||
		!strings.Contains(cancelRecorder.Body.String(), `"status":"cancelled"`) {
		t.Fatalf("cancel status=%d body=%s", cancelRecorder.Code, cancelRecorder.Body.String())
	}
	if runtime.cancelCalls != 1 || runtime.cancelInput.SessionID != control.session.ID ||
		runtime.cancelInput.ActorID != "user_1" || runtime.cancelInput.ActorSessionID != "session_1" ||
		runtime.cancelInput.ExpectedSessionRevision != 2 || runtime.cancelInput.CanCancelAny ||
		server.authRuntime.(*fakeAuthorizationRuntime).cancelled != "" {
		t.Fatalf("cancel input=%#v authRuntime=%#v", runtime.cancelInput, server.authRuntime)
	}
	if cancelRecorder.Header().Get("Cache-Control") != "no-store" ||
		cancelRecorder.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("unsafe cancel headers: %v", cancelRecorder.Header())
	}

	reopenPath := authorizationSessionActionPath(control.session.ID, "reopen")
	reopenRequest := publicRequest(t, http.MethodPost, reopenPath, `{"expectedSessionRevision":2}`)
	reopenRequest.Header.Set("Idempotency-Key", "desktop-command-reopen-0001")
	reopenRecorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(reopenRecorder, reopenRequest)
	if reopenRecorder.Code != http.StatusAccepted ||
		!strings.Contains(reopenRecorder.Body.String(), `"commandTicket":"reopen.command.ticket"`) ||
		runtime.reopenCalls != 1 || runtime.reopenInput.CanCancelAny {
		t.Fatalf("reopen status=%d input=%#v body=%s", reopenRecorder.Code, runtime.reopenInput, reopenRecorder.Body.String())
	}

	runtime.cancelResult = store.CreateDesktopAuthorizationCommandResult{Session: runtime.cancelResult.Session}
	terminalRequest := publicRequest(t, http.MethodPost, cancelPath, `{"expectedSessionRevision":3}`)
	terminalRequest.Header.Set("Idempotency-Key", "desktop-command-terminal-0001")
	terminalRecorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(terminalRecorder, terminalRequest)
	if terminalRecorder.Code != http.StatusOK || strings.Contains(terminalRecorder.Body.String(), "commandTicket") {
		t.Fatalf("terminal cancel status=%d body=%s", terminalRecorder.Code, terminalRecorder.Body.String())
	}
}

func TestDesktopAuthorizationCommandUserRequestsAreStrict(t *testing.T) {
	control := &fakeDesktopAuthorizationCommandControl{fakeControl: fakeControl{session: store.AuthorizationSessionProjection{
		ID: "auth_desktop_command_strict", ExecutorID: "executor_desktop_strict",
		RuntimeType: "desktop", FlowType: "browser", Status: "waiting_user",
		Revision: 2, RequestedBy: "user_1",
	}}}
	path := authorizationSessionActionPath(control.session.ID, "cancel")
	tests := []struct {
		name    string
		request func(*testing.T) *http.Request
	}{
		{"query", func(t *testing.T) *http.Request {
			r := publicRequest(t, http.MethodPost, path+"?bad=1", `{"expectedSessionRevision":2}`)
			r.Header.Set("Idempotency-Key", "desktop-command-strict-0001")
			return r
		}},
		{"duplicate authorization", func(t *testing.T) *http.Request {
			r := publicRequest(t, http.MethodPost, path, `{"expectedSessionRevision":2}`)
			r.Header.Set("Idempotency-Key", "desktop-command-strict-0002")
			r.Header.Add("Authorization", r.Header.Get("Authorization"))
			return r
		}},
		{"unknown JSON", func(t *testing.T) *http.Request {
			r := publicRequest(t, http.MethodPost, path, `{"expectedSessionRevision":2,"token":"secret"}`)
			r.Header.Set("Idempotency-Key", "desktop-command-strict-0003")
			return r
		}},
		{"duplicate JSON", func(t *testing.T) *http.Request {
			r := publicRequest(t, http.MethodPost, path, `{"expectedSessionRevision":2,"expectedSessionRevision":3}`)
			r.Header.Set("Idempotency-Key", "desktop-command-strict-0004")
			return r
		}},
		{"device proof", func(t *testing.T) *http.Request {
			r := publicRequest(t, http.MethodPost, path, `{"expectedSessionRevision":2}`)
			r.Header.Set("Idempotency-Key", "desktop-command-strict-0005")
			r.Header.Set(deviceauth.HeaderDeviceID, strings.Repeat("a", 64))
			return r
		}},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			runtime := &fakeDesktopAuthorizationCommandRuntime{}
			recorder := httptest.NewRecorder()
			desktopAuthorizationCommandHandlerServer(control, runtime).buildMux().ServeHTTP(recorder, testCase.request(t))
			if recorder.Code != http.StatusBadRequest || runtime.cancelCalls != 0 {
				t.Fatalf("status=%d calls=%d body=%s", recorder.Code, runtime.cancelCalls, recorder.Body.String())
			}
		})
	}
}

func signedDesktopCommandHandlerRequest(
	t *testing.T,
	fixture deviceFixture,
	path, body, ticket string,
	sequence uint64,
) *http.Request {
	t.Helper()
	authorization := "AiCRM-Command " + ticket
	authorizationHash, err := deviceauth.AuthorizationTokenHash(authorization, []string{"AiCRM-Command"})
	if err != nil {
		t.Fatal(err)
	}
	nonceRaw := make([]byte, 16)
	for index := range nonceRaw {
		nonceRaw[index] = byte(index) + byte(sequence) + 29
	}
	proof := deviceauth.ProofHeaders{
		DeviceID: fixture.deviceID, TimestampMilli: time.Now().UTC().UnixMilli(),
		Nonce: base64.RawURLEncoding.EncodeToString(nonceRaw), Sequence: sequence,
		BodySHA256: deviceauth.HashBody([]byte(body)),
	}
	signingInput, err := deviceauth.SigningInput(http.MethodPost, path, proof, authorizationHash)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Authorization", authorization)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-KY-Request-Id", "req-desktop-command-ack")
	request.Header.Set(deviceauth.HeaderDeviceID, proof.DeviceID)
	request.Header.Set(deviceauth.HeaderTimestamp, fmt.Sprintf("%d", proof.TimestampMilli))
	request.Header.Set(deviceauth.HeaderNonce, proof.Nonce)
	request.Header.Set(deviceauth.HeaderSequence, fmt.Sprintf("%d", proof.Sequence))
	request.Header.Set(deviceauth.HeaderContentSHA256, proof.BodySHA256)
	request.Header.Set(deviceauth.HeaderSignature,
		base64.RawURLEncoding.EncodeToString(ed25519.Sign(fixture.privateKey, signingInput)))
	return request
}

func TestDesktopAuthorizationCommandACKIsDeviceOnlyAndStrict(t *testing.T) {
	fixture := newDeviceBindingFixture(t, 221)
	const sessionID = "auth_desktop_command_ack"
	const operationID = "desktop_command_ack_1"
	path := store.DesktopAuthorizationCommandACKPath(sessionID, operationID)
	completedAt := time.Now().UTC().Truncate(time.Second).Format(time.RFC3339Nano)
	body := fmt.Sprintf(
		`{"operationId":%q,"purpose":"authorization_cancel","expectedSessionRevision":2,"result":"succeeded","completedAt":%q}`,
		operationID, completedAt,
	)
	runtime := &fakeDesktopAuthorizationCommandRuntime{ackResult: store.AcknowledgeDesktopAuthorizationCommandResult{
		Command: store.DesktopAuthorizationCommandProjection{
			OperationID: operationID, SessionID: sessionID, Purpose: "authorization_cancel",
			ExpectedSessionRevision: 2, Status: "succeeded", CompletedAt: &completedAt,
		},
	}}
	control := &fakeDesktopAuthorizationCommandControl{verificationKey: store.DeviceVerificationKey{
		DeviceID: fixture.deviceID, PublicKey: fixture.publicKey, Status: "active", KeyGeneration: 4,
	}}
	recorder := httptest.NewRecorder()
	desktopAuthorizationCommandHandlerServer(control, runtime).buildMux().ServeHTTP(
		recorder, signedDesktopCommandHandlerRequest(t, fixture, path, body, "desktop.command.ticket", 7),
	)
	if recorder.Code != http.StatusOK || runtime.ackCalls != 1 || runtime.ackTicket != "desktop.command.ticket" ||
		runtime.ackInput.SessionID != sessionID || runtime.ackInput.OperationID != operationID ||
		runtime.ackInput.Purpose != "authorization_cancel" || runtime.ackInput.KeyGeneration != 4 ||
		runtime.ackInput.Proof.DeviceID != fixture.deviceID ||
		runtime.ackInput.LedgerExpiresAt.Before(time.Now().UTC().Add(store.DeviceLedgerAuditRetention)) {
		t.Fatalf("status=%d input=%#v body=%s", recorder.Code, runtime.ackInput, recorder.Body.String())
	}
	if recorder.Header().Get("Cache-Control") != "no-store" ||
		recorder.Header().Get("Referrer-Policy") != "no-referrer" ||
		strings.Contains(recorder.Body.String(), "desktop.command.ticket") {
		t.Fatalf("unsafe response headers=%v body=%s", recorder.Header(), recorder.Body.String())
	}

	for _, mutate := range []func(*http.Request){
		func(r *http.Request) { r.Header.Set("X-KY-Workspace-Type", "platform") },
		func(r *http.Request) { r.Header.Set("Idempotency-Key", "forbidden-command-idem") },
		func(r *http.Request) { r.Header.Set("Authorization", "Bearer desktop.command.ticket") },
		func(r *http.Request) { r.Header.Set("Authorization", "AiCRM-Command changed.ticket") },
	} {
		invalidRuntime := &fakeDesktopAuthorizationCommandRuntime{}
		request := signedDesktopCommandHandlerRequest(t, fixture, path, body, "desktop.command.ticket", 8)
		mutate(request)
		recorder = httptest.NewRecorder()
		desktopAuthorizationCommandHandlerServer(control, invalidRuntime).buildMux().ServeHTTP(recorder, request)
		if recorder.Code < 400 || invalidRuntime.ackCalls != 0 {
			t.Fatalf("invalid status=%d calls=%d body=%s", recorder.Code, invalidRuntime.ackCalls, recorder.Body.String())
		}
	}

	for _, mapping := range []struct {
		err    error
		status int
		code   string
	}{
		{store.ErrDeviceProofReplayed, http.StatusConflict, deviceauth.DeviceProofReplayedCode},
		{trustedtoken.ErrExpired, http.StatusGone, "desktop_command_gone"},
		{trustedtoken.ErrUnknownKey, http.StatusGone, "desktop_command_gone"},
		{store.ErrDesktopAuthorizationCommandTicketMismatch, http.StatusForbidden, "authorization_proof_invalid"},
	} {
		mappedRuntime := &fakeDesktopAuthorizationCommandRuntime{ackErr: mapping.err}
		recorder = httptest.NewRecorder()
		desktopAuthorizationCommandHandlerServer(control, mappedRuntime).buildMux().ServeHTTP(
			recorder, signedDesktopCommandHandlerRequest(t, fixture, path, body, "desktop.command.ticket", 9),
		)
		if recorder.Code != mapping.status || !strings.Contains(recorder.Body.String(), mapping.code) {
			t.Fatalf("err=%v status=%d body=%s", mapping.err, recorder.Code, recorder.Body.String())
		}
	}
}

func TestReadyzRequiresDesktopAuthorizationCommandRuntime(t *testing.T) {
	server := desktopAuthorizationCommandHandlerServer(&fakeDesktopAuthorizationCommandControl{}, nil)
	recorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), `"controlReady":false`) {
		t.Fatalf("missing runtime status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	server.desktopCommandRuntime = &fakeDesktopAuthorizationCommandRuntime{}
	recorder = httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"controlReady":true`) {
		t.Fatalf("ready runtime status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestDesktopAuthorizationCommandACKRejectsEquivalentNonUTCCompletedAt(t *testing.T) {
	const operationID = "desktop_command_non_utc"
	raw := desktopAuthorizationCommandACKRawBody{
		OperationID:             json.RawMessage(`"desktop_command_non_utc"`),
		Purpose:                 json.RawMessage(`"authorization_cancel"`),
		ExpectedSessionRevision: json.RawMessage(`2`),
		Result:                  json.RawMessage(`"succeeded"`),
		CompletedAt:             json.RawMessage(`"2026-07-13T12:00:00+08:00"`),
	}
	if _, ok := parseDesktopAuthorizationCommandACKBody(raw, "auth_session_non_utc", operationID); ok {
		t.Fatal("equivalent offset time must not be accepted as canonical UTC")
	}
	raw.CompletedAt = json.RawMessage(`"2026-07-13T04:00:00Z"`)
	input, ok := parseDesktopAuthorizationCommandACKBody(raw, "auth_session_non_utc", operationID)
	if !ok || input.CompletedAt.Location() != time.UTC ||
		input.CompletedAt.Format(time.RFC3339Nano) != "2026-07-13T04:00:00Z" {
		t.Fatalf("canonical UTC input=%#v ok=%v", input, ok)
	}
}
