package server

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/accessclient"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/desktophandoff"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
)

type fakeDesktopHandoffRuntime struct {
	createInput  desktophandoff.CreateInput
	createResult desktophandoff.CreateResult
	createErr    error
	createCalls  int
	claimInput   desktophandoff.ClaimInput
	claimResult  desktophandoff.ClaimResult
	claimErr     error
	claimCalls   int
}

func (f *fakeDesktopHandoffRuntime) Create(
	_ context.Context,
	input desktophandoff.CreateInput,
) (desktophandoff.CreateResult, error) {
	f.createCalls++
	f.createInput = input
	return f.createResult, f.createErr
}

func (f *fakeDesktopHandoffRuntime) Claim(
	_ context.Context,
	input desktophandoff.ClaimInput,
) (desktophandoff.ClaimResult, error) {
	f.claimCalls++
	f.claimInput = input
	return f.claimResult, f.claimErr
}

func desktopHandoffHandlerServer(
	control *fakeDeviceControl,
	runtime *fakeDesktopHandoffRuntime,
	authorizer accessclient.Authorizer,
) *Server {
	server := newWithControl(config.Config{
		HTTPAddr: "127.0.0.1:18087", WriteEnabled: true,
		InternalToken: "desktop-handoff-internal", AuthTokenSecret: deviceTestAuthSecret,
		DeviceChallengeSecret: deviceTestChallengeSecret,
	}, &fakeReader{}, control, authorizer)
	server.confirmationRuntime = &fakeOperationConfirmationRuntime{}
	server.handoffRuntime = runtime
	return server
}

func signedDesktopHandoffClaimRequest(
	t *testing.T,
	fixture deviceFixture,
	path, body, ticket string,
	sequence uint64,
) *http.Request {
	t.Helper()
	authorization := "AiCRM-Handoff " + ticket
	authorizationHash, err := deviceauth.AuthorizationTokenHash(authorization, []string{"AiCRM-Handoff"})
	if err != nil {
		t.Fatal(err)
	}
	nonceRaw := make([]byte, 16)
	for index := range nonceRaw {
		nonceRaw[index] = byte(index) + byte(sequence) + 17
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
	request.Header.Set("X-KY-Request-Id", "req-desktop-handoff")
	request.Header.Set(deviceauth.HeaderDeviceID, proof.DeviceID)
	request.Header.Set(deviceauth.HeaderTimestamp, fmt.Sprintf("%d", proof.TimestampMilli))
	request.Header.Set(deviceauth.HeaderNonce, proof.Nonce)
	request.Header.Set(deviceauth.HeaderSequence, fmt.Sprintf("%d", sequence))
	request.Header.Set(deviceauth.HeaderContentSHA256, proof.BodySHA256)
	request.Header.Set(deviceauth.HeaderSignature, base64.RawURLEncoding.EncodeToString(ed25519.Sign(fixture.privateKey, signingInput)))
	return request
}

func TestCreateDesktopHandoffUsesStrictUserScopeAndIdempotency(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	runtime := &fakeDesktopHandoffRuntime{createResult: desktophandoff.CreateResult{
		HandoffID: "handoff_1", HandoffTicket: "header.payload.signature",
		Nonce: "AQIDBAUGBwgJCgsMDQ4PEA", ExpiresAt: "2026-07-13T01:02:00Z", Created: true,
	}}
	authorizer := &fakeAuthorizer{}
	server := desktopHandoffHandlerServer(&fakeDeviceControl{}, runtime, authorizer)
	path := desktopHandoffCreatePath("auth_session_1")
	body := fmt.Sprintf(`{"deviceId":%q,"expectedSessionRevision":3}`, fixture.deviceID)
	request, _ := deviceBearerRequest(t, http.MethodPost, path, body)
	request.Header.Set("Idempotency-Key", "desktop-handoff-idem-0001")
	recorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if runtime.createCalls != 1 || runtime.createInput.SessionID != "auth_session_1" ||
		runtime.createInput.ActorID != "device_owner_1" || runtime.createInput.DeviceID != fixture.deviceID ||
		runtime.createInput.ExpectedSessionRevision != 3 || runtime.createInput.IdempotencyKeyHash == "" ||
		runtime.createInput.RequestHash == "" {
		t.Fatalf("create input=%#v", runtime.createInput)
	}
	var response struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Data["handoffId"] != "handoff_1" || response.Data["handoffTicket"] != "header.payload.signature" ||
		recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("response=%s headers=%v", recorder.Body.String(), recorder.Header())
	}
	if len(authorizer.request.RequiredAnyPermissions) != 2 ||
		authorizer.request.RequiredAnyPermissions[0] != "platform.ai_executors.authorize" ||
		authorizer.request.RequiredAnyPermissions[1] != "platform.ai_executors.change_account" {
		t.Fatalf("permission request=%#v", authorizer.request)
	}
}

func TestCreateDesktopHandoffRejectsDuplicateHeadersAndProof(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	runtime := &fakeDesktopHandoffRuntime{}
	server := desktopHandoffHandlerServer(&fakeDeviceControl{}, runtime, &fakeAuthorizer{})
	path := desktopHandoffCreatePath("auth_session_1")
	body := fmt.Sprintf(`{"deviceId":%q,"expectedSessionRevision":3}`, fixture.deviceID)
	request, _ := deviceBearerRequest(t, http.MethodPost, path, body)
	request.Header.Add("Authorization", "Bearer duplicate")
	request.Header.Set("Idempotency-Key", "desktop-handoff-idem-0002")
	recorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || runtime.createCalls != 0 {
		t.Fatalf("duplicate header status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	request, _ = deviceBearerRequest(t, http.MethodPost, path, body)
	request.Header.Set("Idempotency-Key", "desktop-handoff-idem-0003")
	request.Header.Set(deviceauth.HeaderDeviceID, fixture.deviceID)
	recorder = httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || runtime.createCalls != 0 {
		t.Fatalf("proof header status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestClaimDesktopHandoffVerifiesDeviceOnlySignedRequest(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	runtime := &fakeDesktopHandoffRuntime{claimResult: desktophandoff.ClaimResult{
		HandoffID: "handoff_1", ClaimToken: "claim.header.payload",
		ExpiresAt: "2026-07-13T01:05:00Z", SessionRevision: 4,
	}}
	control := &fakeDeviceControl{verificationKey: store.DeviceVerificationKey{
		DeviceID: fixture.deviceID, PublicKey: fixture.publicKey, KeyGeneration: 2,
	}}
	server := desktopHandoffHandlerServer(control, runtime, &fakeAuthorizer{})
	path := desktopHandoffClaimPath("auth_session_1", "handoff_1")
	claimedAt := time.Now().UTC().Format(time.RFC3339Nano)
	body := fmt.Sprintf(`{"handoffId":"handoff_1","claimedAt":%q}`, claimedAt)
	request := signedDesktopHandoffClaimRequest(t, fixture, path, body, "handoff.header.payload", 7)
	recorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if runtime.claimCalls != 1 || runtime.claimInput.HandoffTicket != "handoff.header.payload" ||
		runtime.claimInput.SessionID != "auth_session_1" || runtime.claimInput.HandoffID != "handoff_1" ||
		runtime.claimInput.TargetDeviceID != fixture.deviceID || runtime.claimInput.KeyGeneration != 2 ||
		runtime.claimInput.Proof.AuthorizationTokenHash == "" || runtime.claimInput.LedgerExpiresAt.Before(time.Now().Add(store.DeviceLedgerAuditRetention)) {
		t.Fatalf("claim input=%#v", runtime.claimInput)
	}
	if !runtime.claimInput.ClaimedAt.Equal(mustParseDesktopHandoffTime(t, claimedAt)) ||
		!strings.Contains(recorder.Body.String(), `"claimToken":"claim.header.payload"`) ||
		recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("claim response=%s", recorder.Body.String())
	}
}

func TestClaimDesktopHandoffRejectsOverridesAndAlteredBody(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	control := &fakeDeviceControl{verificationKey: store.DeviceVerificationKey{
		DeviceID: fixture.deviceID, PublicKey: fixture.publicKey, KeyGeneration: 1,
	}}
	runtime := &fakeDesktopHandoffRuntime{}
	server := desktopHandoffHandlerServer(control, runtime, &fakeAuthorizer{})
	path := desktopHandoffClaimPath("auth_session_1", "handoff_1")
	body := fmt.Sprintf(`{"handoffId":"handoff_1","claimedAt":%q}`, time.Now().UTC().Format(time.RFC3339Nano))
	request := signedDesktopHandoffClaimRequest(t, fixture, path, body, "handoff.header.payload", 8)
	request.Header.Set("X-KY-Workspace-Type", "platform")
	recorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || runtime.claimCalls != 0 {
		t.Fatalf("override status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	request = signedDesktopHandoffClaimRequest(t, fixture, path, body, "handoff.header.payload", 9)
	alteredBody := fmt.Sprintf(`{"handoffId":"handoff_1","claimedAt":%q}`, time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano))
	request.Body = io.NopCloser(strings.NewReader(alteredBody))
	request.ContentLength = int64(len(alteredBody))
	recorder = httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden || runtime.claimCalls != 0 {
		t.Fatalf("altered body status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestClaimDesktopHandoffMapsExpiredAndReplayErrors(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	control := &fakeDeviceControl{verificationKey: store.DeviceVerificationKey{
		DeviceID: fixture.deviceID, PublicKey: fixture.publicKey, KeyGeneration: 1,
	}}
	path := desktopHandoffClaimPath("auth_session_1", "handoff_1")
	body := fmt.Sprintf(`{"handoffId":"handoff_1","claimedAt":%q}`, time.Now().UTC().Format(time.RFC3339Nano))
	for _, testCase := range []struct {
		name string
		err  error
		code int
		text string
	}{
		{"expired", store.ErrDesktopHandoffExpired, http.StatusGone, "desktop_handoff_gone"},
		{"replayed", store.ErrDeviceProofReplayed, http.StatusConflict, deviceauth.DeviceProofReplayedCode},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			runtime := &fakeDesktopHandoffRuntime{claimErr: testCase.err}
			request := signedDesktopHandoffClaimRequest(t, fixture, path, body, "handoff.header.payload", uint64(30+len(testCase.name)))
			recorder := httptest.NewRecorder()
			desktopHandoffHandlerServer(control, runtime, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
			if recorder.Code != testCase.code || !strings.Contains(recorder.Body.String(), testCase.text) {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func mustParseDesktopHandoffTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
