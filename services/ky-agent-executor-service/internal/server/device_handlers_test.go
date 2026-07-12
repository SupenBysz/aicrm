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
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/accessclient"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/shared/auth"
)

const (
	deviceTestAuthSecret      = "device-handler-auth-secret"
	deviceTestChallengeSecret = "device-handler-independent-challenge-secret-v1"
)

type fakeDeviceControl struct {
	fakeControl
	challengeInput  store.CreateDeviceRegistrationChallengeInput
	challengeResult store.CreateDeviceRegistrationChallengeResult
	challengeErr    error
	registerInput   store.RegisterDeviceInput
	registerResult  store.RegisterDeviceResult
	registerErr     error
	verificationKey store.DeviceVerificationKey
	verificationErr error
	heartbeatInput  store.RecordDeviceHeartbeatInput
	heartbeatResult store.DeviceHeartbeatResult
	heartbeatErr    error
	registerCalls   int
	heartbeatCalls  int
}

func (f *fakeDeviceControl) CreateDeviceRegistrationChallenge(
	_ context.Context,
	input store.CreateDeviceRegistrationChallengeInput,
) (store.CreateDeviceRegistrationChallengeResult, error) {
	f.challengeInput = input
	return f.challengeResult, f.challengeErr
}

func (f *fakeDeviceControl) RegisterDevice(
	_ context.Context,
	input store.RegisterDeviceInput,
) (store.RegisterDeviceResult, error) {
	f.registerCalls++
	f.registerInput = input
	return f.registerResult, f.registerErr
}

func (f *fakeDeviceControl) GetDeviceVerificationKey(
	_ context.Context,
	_ string,
) (store.DeviceVerificationKey, error) {
	return f.verificationKey, f.verificationErr
}

func (f *fakeDeviceControl) RecordDeviceHeartbeat(
	_ context.Context,
	input store.RecordDeviceHeartbeatInput,
) (store.DeviceHeartbeatResult, error) {
	f.heartbeatCalls++
	f.heartbeatInput = input
	return f.heartbeatResult, f.heartbeatErr
}

type deviceFixture struct {
	privateKey ed25519.PrivateKey
	publicKey  string
	deviceID   string
}

func newDeviceHandlerFixture(t *testing.T) deviceFixture {
	t.Helper()
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = byte(index + 11)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	publicKey := privateKey.Public().(ed25519.PublicKey)
	encoded, err := deviceauth.EncodePublicKey(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	deviceID, err := deviceauth.DeviceID(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	return deviceFixture{privateKey: privateKey, publicKey: encoded, deviceID: deviceID}
}

func deviceHandlerServer(control *fakeDeviceControl, authorizer accessclient.Authorizer) *Server {
	server := newWithControl(config.Config{
		HTTPAddr: "127.0.0.1:18087", WriteEnabled: true,
		InternalToken: "device-handler-internal-token", AuthTokenSecret: deviceTestAuthSecret,
		DeviceChallengeSecret: deviceTestChallengeSecret,
	}, &fakeReader{}, control, authorizer)
	server.confirmationRuntime = &fakeOperationConfirmationRuntime{}
	server.handoffRuntime = &fakeDesktopHandoffRuntime{}
	return server
}

func deviceBearerToken(t *testing.T) string {
	t.Helper()
	token, err := auth.SignToken(deviceTestAuthSecret, auth.TokenPayload{
		UserID: "device_owner_1", SessionID: "device_session_1", Exp: time.Now().Add(time.Hour).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func deviceBearerRequest(t *testing.T, method, path, body string) (*http.Request, string) {
	t.Helper()
	token := deviceBearerToken(t)
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-KY-Request-Id", "req-device-handler")
	request.Header.Set("X-KY-Workspace-Type", "platform")
	request.Header.Set("X-KY-Workspace-Id", "platform_root")
	return request, token
}

func signedDeviceHandlerRequest(
	t *testing.T,
	fixture deviceFixture,
	path string,
	body string,
	authorization string,
	timestamp time.Time,
	sequence uint64,
) *http.Request {
	t.Helper()
	authorizationHash, err := deviceauth.AuthorizationTokenHash(authorization, func() []string {
		if authorization == "" {
			return nil
		}
		return []string{"Bearer"}
	}())
	if err != nil {
		t.Fatal(err)
	}
	nonceRaw := make([]byte, 16)
	for index := range nonceRaw {
		nonceRaw[index] = byte(index) + byte(sequence)
	}
	proof := deviceauth.ProofHeaders{
		DeviceID: fixture.deviceID, TimestampMilli: timestamp.UnixMilli(),
		Nonce: base64.RawURLEncoding.EncodeToString(nonceRaw), Sequence: sequence,
		BodySHA256: deviceauth.HashBody([]byte(body)),
	}
	signingInput, err := deviceauth.SigningInput(http.MethodPost, path, proof, authorizationHash)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-KY-Request-Id", "req-device-handler")
	request.Header.Set(deviceauth.HeaderDeviceID, proof.DeviceID)
	request.Header.Set(deviceauth.HeaderTimestamp, fmt.Sprintf("%d", proof.TimestampMilli))
	request.Header.Set(deviceauth.HeaderNonce, proof.Nonce)
	request.Header.Set(deviceauth.HeaderSequence, fmt.Sprintf("%d", sequence))
	request.Header.Set(deviceauth.HeaderContentSHA256, proof.BodySHA256)
	request.Header.Set(deviceauth.HeaderSignature, base64.RawURLEncoding.EncodeToString(ed25519.Sign(fixture.privateKey, signingInput)))
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
		request.Header.Set("X-KY-Workspace-Type", "platform")
		request.Header.Set("X-KY-Workspace-Id", "platform_root")
	}
	return request
}

func TestDeviceChallengeUsesPersistedIDAndIndependentSecret(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	const persistedID = "device_challenge_persisted_1"
	control := &fakeDeviceControl{challengeResult: store.CreateDeviceRegistrationChallengeResult{
		Challenge: store.DeviceRegistrationChallengeProjection{
			ID: persistedID, ExpiresAt: "2026-07-12T12:02:00Z",
		},
	}}
	authorizer := &fakeAuthorizer{}
	body := fmt.Sprintf(`{"publicKey":%q,"deviceLabel":"Mac Studio","appVersion":"2.0.0"}`, fixture.publicKey)
	request, _ := deviceBearerRequest(t, http.MethodPost, store.DeviceRegistrationPath+"/registration-challenges", body)
	request.Header.Set("Idempotency-Key", "device-challenge-idem-0001")
	recorder := httptest.NewRecorder()
	deviceHandlerServer(control, authorizer).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Data struct {
			ChallengeID string `json:"challengeId"`
			Challenge   string `json:"challenge"`
			ExpiresAt   string `json:"expiresAt"`
			Algorithm   string `json:"algorithm"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Data.ChallengeID != persistedID ||
		response.Data.Challenge != deriveRegistrationChallenge(deviceTestChallengeSecret, persistedID) ||
		response.Data.ExpiresAt != control.challengeResult.Challenge.ExpiresAt || response.Data.Algorithm != "Ed25519" {
		t.Fatalf("unexpected response: %#v", response.Data)
	}
	if control.challengeInput.ActorID != "device_owner_1" || control.challengeInput.WorkspaceType != "platform" ||
		control.challengeInput.WorkspaceID != "platform_root" || control.challengeInput.PublicKey != fixture.publicKey ||
		control.challengeInput.RequestHash != sha256Hex([]byte(body)) || control.challengeInput.ID == persistedID {
		t.Fatalf("challenge binding input=%#v", control.challengeInput)
	}
	candidatePlaintext := deriveRegistrationChallenge(deviceTestChallengeSecret, control.challengeInput.ID)
	if control.challengeInput.ChallengeHash != sha256Hex([]byte(candidatePlaintext)) || strings.Contains(control.challengeInput.ChallengeHash, candidatePlaintext) {
		t.Fatal("challenge plaintext was not reduced to its digest")
	}
	if len(authorizer.request.RequiredAllPermissions) != 1 || authorizer.request.RequiredAllPermissions[0] != "platform.ai_executors.bind_device" {
		t.Fatalf("unexpected permission request: %#v", authorizer.request)
	}
}

func TestDeviceChallengeFailsClosedWithoutSecretOrWithWorkspaceOverride(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	body := fmt.Sprintf(`{"publicKey":%q}`, fixture.publicKey)
	control := &fakeDeviceControl{}
	server := deviceHandlerServer(control, &fakeAuthorizer{})
	server.cfg.DeviceChallengeSecret = ""
	request, _ := deviceBearerRequest(t, http.MethodPost, store.DeviceRegistrationPath+"/registration-challenges", body)
	request.Header.Set("Idempotency-Key", "device-challenge-idem-0002")
	recorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), "device_trust_unavailable") {
		t.Fatalf("missing secret status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	server = deviceHandlerServer(control, &fakeAuthorizer{})
	request, _ = deviceBearerRequest(t, http.MethodPost, store.DeviceRegistrationPath+"/registration-challenges", body)
	request.Header.Set("Idempotency-Key", "device-challenge-idem-0003")
	request.Header.Set("X-KY-Workspace-Type", "enterprise")
	recorder = httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "workspace_forbidden") {
		t.Fatalf("workspace override status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	request, _ = deviceBearerRequest(t, http.MethodPost, store.DeviceRegistrationPath+"/registration-challenges", body)
	request.Header.Set("Idempotency-Key", "device-challenge-idem-missing-workspace")
	request.Header.Del("X-KY-Workspace-Id")
	recorder = httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "workspace_forbidden") {
		t.Fatalf("missing workspace status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	duplicateBody := fmt.Sprintf(`{"publicKey":%q,"publicKey":%q}`, fixture.publicKey, fixture.publicKey)
	request, _ = deviceBearerRequest(t, http.MethodPost, store.DeviceRegistrationPath+"/registration-challenges", duplicateBody)
	request.Header.Set("Idempotency-Key", "device-challenge-idem-0004")
	recorder = httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "duplicate") {
		t.Fatalf("duplicate JSON status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestDeviceChallengeSecretControlsReadiness(t *testing.T) {
	control := &fakeDeviceControl{}
	server := deviceHandlerServer(control, &fakeAuthorizer{})
	for _, secret := range []string{"", "too-short", deviceTestAuthSecret, "device-handler-internal-token"} {
		server.cfg.DeviceChallengeSecret = secret
		recorder := httptest.NewRecorder()
		server.buildMux().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), `"controlReady":false`) {
			t.Fatalf("secret %q readiness status=%d body=%s", secret, recorder.Code, recorder.Body.String())
		}
	}
	server.cfg.DeviceChallengeSecret = deviceTestChallengeSecret
	recorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"controlReady":true`) {
		t.Fatalf("valid secret readiness status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestRegisterDeviceVerifiesExactBearerSignedRequestAndDefersClock(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	challengeID := "device_challenge_registration_1"
	challenge := deriveRegistrationChallenge(deviceTestChallengeSecret, challengeID)
	token := deviceBearerToken(t)
	body := fmt.Sprintf(
		`{"challengeId":%q,"challenge":%q,"publicKey":%q,"deviceLabel":"Mac Studio","appVersion":"2.0.0"}`,
		challengeID, challenge, fixture.publicKey,
	)
	request := signedDeviceHandlerRequest(t, fixture, store.DeviceRegistrationPath, body, "Bearer "+token,
		time.Now().Add(-deviceauth.ClockWindow-time.Hour), 1)
	control := &fakeDeviceControl{registerResult: store.RegisterDeviceResult{ResponseReference: fixture.deviceID}}
	recorder := httptest.NewRecorder()
	deviceHandlerServer(control, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated || !strings.Contains(recorder.Body.String(), fixture.deviceID) {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if control.registerCalls != 1 || control.registerInput.ActorID != "device_owner_1" ||
		control.registerInput.WorkspaceType != "platform" || control.registerInput.WorkspaceID != "platform_root" ||
		control.registerInput.DeviceLabel != "Mac Studio" || control.registerInput.AppVersion != "2.0.0" ||
		control.registerInput.Proof.AuthorizationTokenHash == "" || control.registerInput.Proof.Sequence != 1 {
		t.Fatalf("registration input=%#v", control.registerInput)
	}
	if time.Until(control.registerInput.LedgerExpiresAt) < store.DeviceLedgerAuditRetention {
		t.Fatalf("ledger retention too short: %s", time.Until(control.registerInput.LedgerExpiresAt))
	}
}

func TestRegisterDeviceRejectsTamperingAndUnsignedHeaders(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	challengeID := "device_challenge_registration_2"
	challenge := deriveRegistrationChallenge(deviceTestChallengeSecret, challengeID)
	token := deviceBearerToken(t)
	body := fmt.Sprintf(
		`{"challengeId":%q,"challenge":%q,"publicKey":%q,"deviceLabel":"Mac","appVersion":"2.0.0"}`,
		challengeID, challenge, fixture.publicKey,
	)
	request := signedDeviceHandlerRequest(t, fixture, store.DeviceRegistrationPath, body, "Bearer "+token, time.Now(), 1)
	request.Body = io.NopCloser(strings.NewReader(strings.Replace(body, `"Mac"`, `"Other"`, 1)))
	control := &fakeDeviceControl{}
	recorder := httptest.NewRecorder()
	deviceHandlerServer(control, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden || control.registerCalls != 0 {
		t.Fatalf("tampered status=%d calls=%d body=%s", recorder.Code, control.registerCalls, recorder.Body.String())
	}

	request = signedDeviceHandlerRequest(t, fixture, store.DeviceRegistrationPath, body, "Bearer "+token, time.Now(), 1)
	request.Header.Set("Idempotency-Key", "forbidden-device-idem")
	recorder = httptest.NewRecorder()
	deviceHandlerServer(control, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "device_header_forbidden") {
		t.Fatalf("unsigned header status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestHeartbeatDefersClockAndDeviceStatusToPersistentStore(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	path := store.DeviceRegistrationPath + "/" + fixture.deviceID + "/heartbeat"
	body := `{"bridgeVersion":2,"appVersion":"2.0.1","capabilities":{"deviceProof":true},"occurredAt":"2026-07-12T00:00:00Z"}`
	request := signedDeviceHandlerRequest(t, fixture, path, body, "", time.Now().Add(-deviceauth.ClockWindow-time.Hour), 9)
	control := &fakeDeviceControl{
		verificationKey: store.DeviceVerificationKey{
			DeviceID: fixture.deviceID, PublicKey: fixture.publicKey, Status: "disabled", KeyGeneration: 1,
		},
		heartbeatResult: store.DeviceHeartbeatResult{
			Sequence: 9, AcceptedAt: "2026-07-12T00:00:01Z", ResponseReference: "heartbeat-recorded",
		},
	}
	recorder := httptest.NewRecorder()
	deviceHandlerServer(control, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || control.heartbeatCalls != 1 ||
		!strings.Contains(recorder.Body.String(), `"sequence":9`) || !strings.Contains(recorder.Body.String(), control.heartbeatResult.AcceptedAt) {
		t.Fatalf("status=%d calls=%d body=%s", recorder.Code, control.heartbeatCalls, recorder.Body.String())
	}
	if control.heartbeatInput.Proof.RequestHash == "" || control.heartbeatInput.KeyGeneration != 1 ||
		time.Until(control.heartbeatInput.LedgerExpiresAt) < store.DeviceLedgerAuditRetention {
		t.Fatalf("heartbeat input=%#v", control.heartbeatInput)
	}
}

func TestHeartbeatRejectsWorkspaceQueryBodyAndSignatureTampering(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	path := store.DeviceRegistrationPath + "/" + fixture.deviceID + "/heartbeat"
	body := `{"bridgeVersion":2,"appVersion":"2.0.1","capabilities":{"deviceProof":true},"occurredAt":"2026-07-12T00:00:00Z"}`
	baseControl := func() *fakeDeviceControl {
		return &fakeDeviceControl{verificationKey: store.DeviceVerificationKey{
			DeviceID: fixture.deviceID, PublicKey: fixture.publicKey, Status: "active", KeyGeneration: 1,
		}}
	}

	request := signedDeviceHandlerRequest(t, fixture, path, body, "", time.Now(), 2)
	request.Header.Set("X-KY-Workspace-Id", "platform_root")
	recorder := httptest.NewRecorder()
	deviceHandlerServer(baseControl(), &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "device_header_forbidden") {
		t.Fatalf("workspace status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	request = signedDeviceHandlerRequest(t, fixture, path, body, "", time.Now(), 2)
	request.URL.RawQuery = "unexpected=1"
	request.RequestURI = path + "?unexpected=1"
	recorder = httptest.NewRecorder()
	deviceHandlerServer(baseControl(), &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("query status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	control := baseControl()
	request = signedDeviceHandlerRequest(t, fixture, path, body, "", time.Now(), 2)
	request.Body = io.NopCloser(strings.NewReader(strings.Replace(body, "2.0.1", "2.0.2", 1)))
	recorder = httptest.NewRecorder()
	deviceHandlerServer(control, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden || control.heartbeatCalls != 0 {
		t.Fatalf("tamper status=%d calls=%d body=%s", recorder.Code, control.heartbeatCalls, recorder.Body.String())
	}

	request = signedDeviceHandlerRequest(t, fixture, path, body, "", time.Now(), 2)
	request.Header.Add("Content-Type", "application/json")
	recorder = httptest.NewRecorder()
	deviceHandlerServer(baseControl(), &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("duplicate content type status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	invalidPath := store.DeviceRegistrationPath + "/not-a-digest/heartbeat"
	request = httptest.NewRequest(http.MethodPost, invalidPath, strings.NewReader(body))
	recorder = httptest.NewRecorder()
	deviceHandlerServer(baseControl(), &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "validation_error") {
		t.Fatalf("invalid device ID status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestDeviceStoreErrorsKeepStableSecurityCodes(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	path := store.DeviceRegistrationPath + "/" + fixture.deviceID + "/heartbeat"
	body := `{"bridgeVersion":2,"appVersion":"2.0.1","capabilities":{"deviceProof":true},"occurredAt":"2026-07-12T00:00:00Z"}`
	request := signedDeviceHandlerRequest(t, fixture, path, body, "", time.Now(), 2)
	control := &fakeDeviceControl{
		verificationKey: store.DeviceVerificationKey{DeviceID: fixture.deviceID, PublicKey: fixture.publicKey, Status: "active", KeyGeneration: 1},
		heartbeatErr:    deviceauth.ErrTimestampOutsideWindow,
	}
	recorder := httptest.NewRecorder()
	deviceHandlerServer(control, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "authorization_proof_invalid") {
		t.Fatalf("timestamp status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	control.heartbeatErr = store.ErrDeviceProofReplayed
	request = signedDeviceHandlerRequest(t, fixture, path, body, "", time.Now(), 2)
	recorder = httptest.NewRecorder()
	deviceHandlerServer(control, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), deviceauth.DeviceProofReplayedCode) {
		t.Fatalf("replay status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestDeviceHTTPAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("KY_AGENT_EXECUTOR_DEVICE_HTTP_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set KY_AGENT_EXECUTOR_DEVICE_HTTP_TEST_DATABASE_URL for PostgreSQL integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	control, err := store.OpenControl(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = control.Close() }()
	server := newWithControl(config.Config{
		HTTPAddr: "127.0.0.1:18087", WriteEnabled: true,
		InternalToken: "device-http-pg-internal", AuthTokenSecret: deviceTestAuthSecret,
		DeviceChallengeSecret: deviceTestChallengeSecret,
	}, &fakeReader{}, control, &fakeAuthorizer{})
	fixture := newDeviceHandlerFixture(t)
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	challengeBody := fmt.Sprintf(
		`{"publicKey":%q,"deviceLabel":%q,"appVersion":"2.0.0"}`,
		fixture.publicKey, "PG Desktop "+suffix,
	)
	createChallenge := func(body string) *httptest.ResponseRecorder {
		request, _ := deviceBearerRequest(t, http.MethodPost, store.DeviceRegistrationPath+"/registration-challenges", body)
		request.Header.Set("Idempotency-Key", "device-http-pg-"+suffix)
		recorder := httptest.NewRecorder()
		server.buildMux().ServeHTTP(recorder, request)
		return recorder
	}
	challengeRecorder := createChallenge(challengeBody)
	if challengeRecorder.Code != http.StatusCreated {
		t.Fatalf("challenge status=%d body=%s", challengeRecorder.Code, challengeRecorder.Body.String())
	}
	firstChallengeResponse := challengeRecorder.Body.String()
	challengeRecorder = createChallenge(challengeBody)
	if challengeRecorder.Code != http.StatusCreated || challengeRecorder.Body.String() != firstChallengeResponse {
		t.Fatalf("challenge replay status=%d body=%s first=%s", challengeRecorder.Code, challengeRecorder.Body.String(), firstChallengeResponse)
	}
	challengeRecorder = createChallenge(strings.Replace(challengeBody, "PG Desktop", "Changed Desktop", 1))
	if challengeRecorder.Code != http.StatusConflict || !strings.Contains(challengeRecorder.Body.String(), "idempotency_key_reused") {
		t.Fatalf("changed challenge status=%d body=%s", challengeRecorder.Code, challengeRecorder.Body.String())
	}
	var challengeEnvelope struct {
		Data struct {
			ChallengeID string `json:"challengeId"`
			Challenge   string `json:"challenge"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(firstChallengeResponse), &challengeEnvelope); err != nil {
		t.Fatal(err)
	}
	if challengeEnvelope.Data.ChallengeID == "" || challengeEnvelope.Data.Challenge == "" {
		t.Fatalf("invalid challenge response: %s", firstChallengeResponse)
	}

	token := deviceBearerToken(t)
	registrationBody := fmt.Sprintf(
		`{"challengeId":%q,"challenge":%q,"publicKey":%q,"deviceLabel":%q,"appVersion":"2.0.0"}`,
		challengeEnvelope.Data.ChallengeID, challengeEnvelope.Data.Challenge, fixture.publicKey, "PG Desktop "+suffix,
	)
	registrationAt := time.Now().UTC()
	register := func(body string) *httptest.ResponseRecorder {
		request := signedDeviceHandlerRequest(t, fixture, store.DeviceRegistrationPath, body, "Bearer "+token, registrationAt, 1)
		recorder := httptest.NewRecorder()
		server.buildMux().ServeHTTP(recorder, request)
		return recorder
	}
	registerRecorder := register(registrationBody)
	if registerRecorder.Code != http.StatusCreated || !strings.Contains(registerRecorder.Body.String(), fixture.deviceID) {
		t.Fatalf("registration status=%d body=%s", registerRecorder.Code, registerRecorder.Body.String())
	}
	firstRegistrationResponse := registerRecorder.Body.String()
	registerRecorder = register(registrationBody)
	if registerRecorder.Code != http.StatusCreated || registerRecorder.Body.String() != firstRegistrationResponse {
		t.Fatalf("registration replay status=%d body=%s first=%s", registerRecorder.Code, registerRecorder.Body.String(), firstRegistrationResponse)
	}
	registerRecorder = register(strings.Replace(registrationBody, `"2.0.0"`, `"2.0.1"`, 1))
	if registerRecorder.Code != http.StatusConflict || !strings.Contains(registerRecorder.Body.String(), deviceauth.DeviceProofReplayedCode) {
		t.Fatalf("changed registration status=%d body=%s", registerRecorder.Code, registerRecorder.Body.String())
	}

	heartbeatPath := store.DeviceRegistrationPath + "/" + fixture.deviceID + "/heartbeat"
	heartbeatBody := `{"bridgeVersion":2,"appVersion":"2.0.1","capabilities":{"deviceProof":true},"occurredAt":"2026-07-12T00:00:00Z"}`
	heartbeatAt := time.Now().UTC()
	heartbeat := func(body string, timestamp time.Time, sequence uint64) *httptest.ResponseRecorder {
		request := signedDeviceHandlerRequest(t, fixture, heartbeatPath, body, "", timestamp, sequence)
		recorder := httptest.NewRecorder()
		server.buildMux().ServeHTTP(recorder, request)
		return recorder
	}
	heartbeatRecorder := heartbeat(heartbeatBody, heartbeatAt, 2)
	if heartbeatRecorder.Code != http.StatusOK || !strings.Contains(heartbeatRecorder.Body.String(), `"sequence":2`) {
		t.Fatalf("heartbeat status=%d body=%s", heartbeatRecorder.Code, heartbeatRecorder.Body.String())
	}
	firstHeartbeatResponse := heartbeatRecorder.Body.String()
	heartbeatRecorder = heartbeat(heartbeatBody, heartbeatAt, 2)
	if heartbeatRecorder.Code != http.StatusOK || heartbeatRecorder.Body.String() != firstHeartbeatResponse {
		t.Fatalf("heartbeat replay status=%d body=%s first=%s", heartbeatRecorder.Code, heartbeatRecorder.Body.String(), firstHeartbeatResponse)
	}
	heartbeatRecorder = heartbeat(strings.Replace(heartbeatBody, "2.0.1", "2.0.2", 1), heartbeatAt, 2)
	if heartbeatRecorder.Code != http.StatusConflict || !strings.Contains(heartbeatRecorder.Body.String(), deviceauth.DeviceProofReplayedCode) {
		t.Fatalf("changed heartbeat status=%d body=%s", heartbeatRecorder.Code, heartbeatRecorder.Body.String())
	}
	heartbeatRecorder = heartbeat(heartbeatBody, time.Now().Add(-deviceauth.ClockWindow-time.Second), 3)
	if heartbeatRecorder.Code != http.StatusForbidden || !strings.Contains(heartbeatRecorder.Body.String(), "authorization_proof_invalid") {
		t.Fatalf("expired heartbeat status=%d body=%s", heartbeatRecorder.Code, heartbeatRecorder.Body.String())
	}
}
