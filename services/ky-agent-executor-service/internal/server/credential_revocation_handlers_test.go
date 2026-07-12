package server

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/accessclient"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/credentialrevocation"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
)

type fakeCredentialRevocationRuntime struct {
	revokeInput  credentialrevocation.RevokeInput
	revokeResult store.CreateCredentialRevocationResult
	revokeErr    error
	revokeCalls  int
	ackInput     store.AcknowledgeCredentialRevocationInput
	ackTicket    string
	ackResult    store.AcknowledgeCredentialRevocationResult
	ackErr       error
	ackCalls     int
}

func (f *fakeCredentialRevocationRuntime) Revoke(
	_ context.Context,
	input credentialrevocation.RevokeInput,
) (store.CreateCredentialRevocationResult, error) {
	f.revokeCalls++
	f.revokeInput = input
	return f.revokeResult, f.revokeErr
}

func (f *fakeCredentialRevocationRuntime) Acknowledge(
	_ context.Context,
	input store.AcknowledgeCredentialRevocationInput,
	ticket string,
) (store.AcknowledgeCredentialRevocationResult, error) {
	f.ackCalls++
	f.ackInput = input
	f.ackTicket = ticket
	return f.ackResult, f.ackErr
}

type fakeCredentialRevocationControl struct {
	fakeControl
	verificationKey store.DeviceVerificationKey
	verificationErr error
	verifiedDevice  string
}

func (f *fakeCredentialRevocationControl) GetDeviceVerificationKey(
	_ context.Context,
	deviceID string,
) (store.DeviceVerificationKey, error) {
	f.verifiedDevice = deviceID
	return f.verificationKey, f.verificationErr
}

func credentialRevocationHandlerServer(
	control *fakeCredentialRevocationControl,
	runtime *fakeCredentialRevocationRuntime,
	authorizer accessclient.Authorizer,
) *Server {
	server := newWithControl(config.Config{
		HTTPAddr: "127.0.0.1:18087", WriteEnabled: true,
		InternalToken: "credential-revocation-internal", AuthTokenSecret: deviceTestAuthSecret,
	}, &fakeReader{}, control, authorizer)
	installTrustedTokenTestReadiness(server)
	server.revocationRuntime = runtime
	return server
}

func credentialRevocationUserRequest(t *testing.T, path, body string) *http.Request {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+deviceBearerToken(t))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "credential-revoke-idem-0001")
	request.Header.Set("X-KY-Request-Id", "req-credential-revocation")
	request.Header.Set("X-KY-Workspace-Type", "platform")
	request.Header.Set("X-KY-Workspace-Id", "platform_root")
	return request
}

func signedCredentialRevocationACKRequest(
	t *testing.T,
	fixture deviceFixture,
	path string,
	body string,
	ticket string,
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
	request.Header.Set("X-KY-Request-Id", "req-credential-revocation-ack")
	request.Header.Set(deviceauth.HeaderDeviceID, proof.DeviceID)
	request.Header.Set(deviceauth.HeaderTimestamp, fmt.Sprintf("%d", proof.TimestampMilli))
	request.Header.Set(deviceauth.HeaderNonce, proof.Nonce)
	request.Header.Set(deviceauth.HeaderSequence, fmt.Sprintf("%d", proof.Sequence))
	request.Header.Set(deviceauth.HeaderContentSHA256, proof.BodySHA256)
	request.Header.Set(deviceauth.HeaderSignature,
		base64.RawURLEncoding.EncodeToString(ed25519.Sign(fixture.privateKey, signingInput)))
	return request
}

func TestCredentialRevocationNormalServerUsesBothPermissionsAndStableRequestHash(t *testing.T) {
	const executorID = "executor_revoke_server"
	path := credentialRevocationPath(executorID)
	body := `{"expectedCredentialRevision":12,"force":false}`
	runtime := &fakeCredentialRevocationRuntime{revokeResult: store.CreateCredentialRevocationResult{
		Revocation: store.CredentialRevocationProjection{
			ExecutorID: executorID, RuntimeType: "server", CredentialRevision: 12,
			RevocationEpoch: 4, Status: "completed",
		},
	}}
	authorizer := &fakeAuthorizer{}
	recorder := httptest.NewRecorder()
	credentialRevocationHandlerServer(&fakeCredentialRevocationControl{}, runtime, authorizer).
		buildMux().ServeHTTP(recorder, credentialRevocationUserRequest(t, path, body))
	if recorder.Code != http.StatusOK || recorder.Header().Get("Cache-Control") != "no-store" ||
		recorder.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("status=%d headers=%v body=%s", recorder.Code, recorder.Header(), recorder.Body.String())
	}
	if runtime.revokeCalls != 1 || runtime.revokeInput.ExecutorID != executorID ||
		runtime.revokeInput.ActorID != "device_owner_1" || runtime.revokeInput.ActorSessionID != "device_session_1" ||
		runtime.revokeInput.ExpectedCredentialRevision != 12 || runtime.revokeInput.Force ||
		runtime.revokeInput.ConfirmationToken != "" || !credentialRevocationDigestPattern.MatchString(runtime.revokeInput.RequestHash) ||
		!credentialRevocationDigestPattern.MatchString(runtime.revokeInput.IdempotencyKeyHash) {
		t.Fatalf("unexpected revoke input: %#v", runtime.revokeInput)
	}
	if got := authorizer.request.RequiredAllPermissions; len(got) != 2 ||
		got[0] != permissionCredentialAuthorize || got[1] != permissionCredentialChangeAccount {
		t.Fatalf("unexpected permissions: %#v", got)
	}
	var response struct {
		Data struct {
			CredentialStatus   string `json:"credentialStatus"`
			CredentialRevision int64  `json:"credentialRevision"`
			RevocationEpoch    int64  `json:"revocationEpoch"`
		} `json:"data"`
	}
	if json.Unmarshal(recorder.Body.Bytes(), &response) != nil || response.Data.CredentialStatus != "revoked" ||
		response.Data.CredentialRevision != 12 || response.Data.RevocationEpoch != 4 {
		t.Fatalf("unexpected response: %s", recorder.Body.String())
	}
}

func TestCredentialRevocationForceDesktopRequiresOnlyForcePermissionAndReturnsCommand(t *testing.T) {
	const executorID = "executor_revoke_desktop"
	path := credentialRevocationPath(executorID)
	body := `{"expectedCredentialRevision":7,"force":true,"confirmationToken":"confirmed.force.token"}`
	expiresAt := "2026-07-13T03:02:00Z"
	runtime := &fakeCredentialRevocationRuntime{revokeResult: store.CreateCredentialRevocationResult{
		Revocation: store.CredentialRevocationProjection{
			RevocationID: "revocation_7", OperationID: "logout_7", ExecutorID: executorID,
			RuntimeType: "desktop", CredentialRevision: 7, RevocationEpoch: 9,
			Status: "awaiting_device", ExpiresAt: &expiresAt,
		},
		CommandTicket: "desktop.command.ticket",
	}}
	authorizer := &fakeAuthorizer{}
	recorder := httptest.NewRecorder()
	credentialRevocationHandlerServer(&fakeCredentialRevocationControl{}, runtime, authorizer).
		buildMux().ServeHTTP(recorder, credentialRevocationUserRequest(t, path, body))
	if recorder.Code != http.StatusAccepted || !strings.Contains(recorder.Body.String(), `"status":"awaiting_device"`) ||
		!strings.Contains(recorder.Body.String(), `"commandTicket":"desktop.command.ticket"`) {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if runtime.revokeInput.ConfirmationToken != "confirmed.force.token" || !runtime.revokeInput.Force ||
		len(authorizer.request.RequiredAllPermissions) != 1 ||
		authorizer.request.RequiredAllPermissions[0] != permissionCredentialForceRevoke {
		t.Fatalf("input=%#v permission=%#v", runtime.revokeInput, authorizer.request)
	}

	// Once the device ACK changes the stored projection to a terminal status,
	// the exact idempotent create replay must still return the original create
	// envelope and deterministically reconstructed ticket.
	runtime.revokeResult.Revocation.Status = "completed"
	runtime.revokeResult.Created = false
	recorder = httptest.NewRecorder()
	credentialRevocationHandlerServer(&fakeCredentialRevocationControl{}, runtime, authorizer).
		buildMux().ServeHTTP(recorder, credentialRevocationUserRequest(t, path, body))
	if recorder.Code != http.StatusAccepted || !strings.Contains(recorder.Body.String(), `"status":"awaiting_device"`) ||
		!strings.Contains(recorder.Body.String(), `"commandTicket":"desktop.command.ticket"`) {
		t.Fatalf("terminal replay status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestCredentialRevocationUserTransportAndShapeFailClosed(t *testing.T) {
	const executorID = "executor_revoke_strict"
	path := credentialRevocationPath(executorID)
	validBody := `{"expectedCredentialRevision":2,"force":false}`
	tests := []struct {
		name    string
		request func(*testing.T) *http.Request
		status  int
		code    string
	}{
		{"query", func(t *testing.T) *http.Request {
			r := credentialRevocationUserRequest(t, path, validBody)
			r.URL.RawQuery, r.RequestURI = "bad=1", path+"?bad=1"
			return r
		}, http.StatusBadRequest, "validation_error"},
		{"duplicate authorization", func(t *testing.T) *http.Request {
			r := credentialRevocationUserRequest(t, path, validBody)
			r.Header.Add("Authorization", r.Header.Get("Authorization"))
			return r
		}, http.StatusUnauthorized, "unauthorized"},
		{"missing idempotency", func(t *testing.T) *http.Request {
			r := credentialRevocationUserRequest(t, path, validBody)
			r.Header.Del("Idempotency-Key")
			return r
		}, http.StatusBadRequest, "idempotency_key_required"},
		{"device proof forbidden", func(t *testing.T) *http.Request {
			r := credentialRevocationUserRequest(t, path, validBody)
			r.Header.Set(deviceauth.HeaderDeviceID, strings.Repeat("a", 64))
			return r
		}, http.StatusBadRequest, "validation_error"},
		{"unknown JSON", func(t *testing.T) *http.Request {
			return credentialRevocationUserRequest(t, path, `{"expectedCredentialRevision":2,"force":false,"token":"secret"}`)
		}, http.StatusBadRequest, "validation_error"},
		{"duplicate JSON", func(t *testing.T) *http.Request {
			return credentialRevocationUserRequest(t, path, `{"expectedCredentialRevision":2,"expectedCredentialRevision":3,"force":false}`)
		}, http.StatusBadRequest, "validation_error"},
		{"null revision", func(t *testing.T) *http.Request {
			return credentialRevocationUserRequest(t, path, `{"expectedCredentialRevision":null,"force":false}`)
		}, http.StatusBadRequest, "validation_error"},
		{"force missing confirmation", func(t *testing.T) *http.Request {
			return credentialRevocationUserRequest(t, path, `{"expectedCredentialRevision":2,"force":true}`)
		}, http.StatusBadRequest, "validation_error"},
		{"normal confirmation forbidden", func(t *testing.T) *http.Request {
			return credentialRevocationUserRequest(t, path, `{"expectedCredentialRevision":2,"force":false,"confirmationToken":"not-used"}`)
		}, http.StatusBadRequest, "validation_error"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			runtime := &fakeCredentialRevocationRuntime{}
			recorder := httptest.NewRecorder()
			credentialRevocationHandlerServer(&fakeCredentialRevocationControl{}, runtime, &fakeAuthorizer{}).
				buildMux().ServeHTTP(recorder, testCase.request(t))
			if recorder.Code != testCase.status || !strings.Contains(recorder.Body.String(), testCase.code) || runtime.revokeCalls != 0 {
				t.Fatalf("status=%d calls=%d body=%s", recorder.Code, runtime.revokeCalls, recorder.Body.String())
			}
		})
	}

	runtime := &fakeCredentialRevocationRuntime{}
	recorder := httptest.NewRecorder()
	credentialRevocationHandlerServer(&fakeCredentialRevocationControl{}, runtime, &fakeAuthorizer{err: accessclient.ErrDenied}).
		buildMux().ServeHTTP(recorder, credentialRevocationUserRequest(t, path, validBody))
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "permission_denied") || runtime.revokeCalls != 0 {
		t.Fatalf("permission status=%d calls=%d body=%s", recorder.Code, runtime.revokeCalls, recorder.Body.String())
	}
}

func TestCredentialRevocationACKIsDeviceOnlySignedAndLedgerBound(t *testing.T) {
	fixture := newDeviceBindingFixture(t, 181)
	const executorID = "executor_revoke_ack"
	const revocationID = "revocation_ack_1"
	path := store.CredentialRevocationACKPath(executorID, revocationID)
	completedAt := time.Now().UTC().Truncate(time.Second)
	digest := strings.Repeat("b", 64)
	body := fmt.Sprintf(
		`{"operationId":"logout_ack_1","revocationId":%q,"credentialRevision":8,"revocationEpoch":6,"completedAt":%q,"quarantineDigest":%q,"result":"succeeded"}`,
		revocationID, completedAt.Format(time.RFC3339Nano), digest,
	)
	completedAtText := completedAt.Format(time.RFC3339Nano)
	runtime := &fakeCredentialRevocationRuntime{ackResult: store.AcknowledgeCredentialRevocationResult{
		Revocation: store.CredentialRevocationProjection{
			RevocationID: revocationID, OperationID: "logout_ack_1", CredentialRevision: 8,
			RevocationEpoch: 6, Status: "completed", CompletedAt: &completedAtText,
		},
	}}
	control := &fakeCredentialRevocationControl{verificationKey: store.DeviceVerificationKey{
		DeviceID: fixture.deviceID, PublicKey: fixture.publicKey, Status: "active", KeyGeneration: 3,
	}}
	recorder := httptest.NewRecorder()
	credentialRevocationHandlerServer(control, runtime, &fakeAuthorizer{}).buildMux().ServeHTTP(
		recorder, signedCredentialRevocationACKRequest(t, fixture, path, body, "command.ticket.ack", 11),
	)
	if recorder.Code != http.StatusOK || recorder.Header().Get("Cache-Control") != "no-store" ||
		recorder.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("status=%d headers=%v body=%s", recorder.Code, recorder.Header(), recorder.Body.String())
	}
	if runtime.ackCalls != 1 || runtime.ackTicket != "command.ticket.ack" ||
		runtime.ackInput.ExecutorID != executorID || runtime.ackInput.RevocationID != revocationID ||
		runtime.ackInput.OperationID != "logout_ack_1" || runtime.ackInput.CredentialRevision != 8 ||
		runtime.ackInput.RevocationEpoch != 6 || runtime.ackInput.Result != "succeeded" ||
		runtime.ackInput.QuarantineDigest != digest || runtime.ackInput.KeyGeneration != 3 ||
		runtime.ackInput.Proof.DeviceID != fixture.deviceID || runtime.ackInput.Proof.AuthorizationTokenHash == "" ||
		runtime.ackInput.LedgerExpiresAt.Before(time.Now().UTC().Add(store.DeviceLedgerAuditRetention)) {
		t.Fatalf("unexpected ACK input: %#v", runtime.ackInput)
	}
	if control.verifiedDevice != fixture.deviceID || strings.Contains(recorder.Body.String(), "command.ticket.ack") ||
		strings.Contains(recorder.Body.String(), digest) {
		t.Fatalf("unsafe ACK response/control: device=%q body=%s", control.verifiedDevice, recorder.Body.String())
	}
}

func TestCredentialRevocationACKStrictProofReplayExpiryAndMappings(t *testing.T) {
	fixture := newDeviceBindingFixture(t, 201)
	const executorID = "executor_revoke_ack_strict"
	const revocationID = "revocation_ack_strict"
	path := store.CredentialRevocationACKPath(executorID, revocationID)
	completedAt := time.Now().UTC().Truncate(time.Second).Format(time.RFC3339Nano)
	body := fmt.Sprintf(
		`{"operationId":"logout_ack_strict","revocationId":%q,"credentialRevision":4,"revocationEpoch":5,"completedAt":%q,"quarantineDigest":"","result":"stale_target"}`,
		revocationID, completedAt,
	)
	newControl := func() *fakeCredentialRevocationControl {
		return &fakeCredentialRevocationControl{verificationKey: store.DeviceVerificationKey{
			DeviceID: fixture.deviceID, PublicKey: fixture.publicKey, Status: "active", KeyGeneration: 1,
		}}
	}
	tests := []struct {
		name    string
		request func(*testing.T) *http.Request
		status  int
		code    string
	}{
		{"workspace override", func(t *testing.T) *http.Request {
			r := signedCredentialRevocationACKRequest(t, fixture, path, body, "ack.ticket", 1)
			r.Header.Set("X-KY-Workspace-Type", "platform")
			return r
		}, http.StatusBadRequest, "device_header_forbidden"},
		{"idempotency override", func(t *testing.T) *http.Request {
			r := signedCredentialRevocationACKRequest(t, fixture, path, body, "ack.ticket", 1)
			r.Header.Set("Idempotency-Key", "forbidden-ack-idempotency")
			return r
		}, http.StatusBadRequest, "device_header_forbidden"},
		{"bearer scheme", func(t *testing.T) *http.Request {
			r := signedCredentialRevocationACKRequest(t, fixture, path, body, "ack.ticket", 1)
			r.Header.Set("Authorization", "Bearer ack.ticket")
			return r
		}, http.StatusUnauthorized, "credential_revocation_unauthorized"},
		{"changed token invalidates signature", func(t *testing.T) *http.Request {
			r := signedCredentialRevocationACKRequest(t, fixture, path, body, "ack.ticket", 1)
			r.Header.Set("Authorization", "AiCRM-Command changed.ticket")
			return r
		}, http.StatusForbidden, credentialRevocationProofInvalidCode},
		{"query", func(t *testing.T) *http.Request {
			r := signedCredentialRevocationACKRequest(t, fixture, path, body, "ack.ticket", 1)
			r.URL.RawQuery, r.RequestURI = "bad=1", path+"?bad=1"
			return r
		}, http.StatusBadRequest, "validation_error"},
		{"body revocation mismatch", func(t *testing.T) *http.Request {
			bad := strings.Replace(body, revocationID, "revocation_other", 1)
			return signedCredentialRevocationACKRequest(t, fixture, path, bad, "ack.ticket", 1)
		}, http.StatusBadRequest, "validation_error"},
		{"unknown JSON", func(t *testing.T) *http.Request {
			bad := strings.TrimSuffix(body, "}") + `,"credential":"secret"}`
			return signedCredentialRevocationACKRequest(t, fixture, path, bad, "ack.ticket", 1)
		}, http.StatusBadRequest, "validation_error"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			runtime := &fakeCredentialRevocationRuntime{}
			recorder := httptest.NewRecorder()
			credentialRevocationHandlerServer(newControl(), runtime, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, testCase.request(t))
			if recorder.Code != testCase.status || !strings.Contains(recorder.Body.String(), testCase.code) || runtime.ackCalls != 0 {
				t.Fatalf("status=%d calls=%d body=%s", recorder.Code, runtime.ackCalls, recorder.Body.String())
			}
		})
	}

	for _, testCase := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"exact sequence replay conflict", store.ErrDeviceProofReplayed, http.StatusConflict, deviceauth.DeviceProofReplayedCode},
		{"expired command", trustedtoken.ErrExpired, http.StatusGone, "credential_revocation_gone"},
		{"rotated command key", trustedtoken.ErrUnknownKey, http.StatusGone, "credential_revocation_gone"},
		{"command key window", trustedtoken.ErrKeyWindowMismatch, http.StatusGone, "credential_revocation_gone"},
		{"command key retired", trustedtoken.ErrKeyRetired, http.StatusGone, "credential_revocation_gone"},
		{"wrong command claims", store.ErrCredentialRevocationTicketMismatch, http.StatusForbidden, credentialRevocationProofInvalidCode},
		{"already ACKed differently", store.ErrCredentialRevocationACKRecorded, http.StatusConflict, "credential_revocation_conflict"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			runtime := &fakeCredentialRevocationRuntime{ackErr: testCase.err}
			recorder := httptest.NewRecorder()
			credentialRevocationHandlerServer(newControl(), runtime, &fakeAuthorizer{}).buildMux().ServeHTTP(
				recorder, signedCredentialRevocationACKRequest(t, fixture, path, body, "ack.ticket", 2),
			)
			if recorder.Code != testCase.status || !strings.Contains(recorder.Body.String(), testCase.code) || runtime.ackCalls != 1 {
				t.Fatalf("status=%d calls=%d body=%s", recorder.Code, runtime.ackCalls, recorder.Body.String())
			}
		})
	}
}

func TestCredentialRevocationCreateErrorMappings(t *testing.T) {
	const executorID = "executor_revoke_errors"
	path := credentialRevocationPath(executorID)
	body := `{"expectedCredentialRevision":3,"force":false}`
	for _, testCase := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"idempotency", store.ErrIdempotencyReuse, http.StatusConflict, "idempotency_key_reused"},
		{"active tasks", store.ErrCredentialRevocationActiveWork, http.StatusConflict, "executor_has_active_tasks"},
		{"revision", store.ErrRevisionConflict, http.StatusConflict, "revision_conflict"},
		{"expired confirmation", trustedtoken.ErrExpired, http.StatusGone, "operation_confirmation_gone"},
		{"confirmation key window", trustedtoken.ErrKeyWindowMismatch, http.StatusGone, "operation_confirmation_gone"},
		{"confirmation key retired", trustedtoken.ErrKeyRetired, http.StatusGone, "operation_confirmation_gone"},
		{"confirmation mismatch", trustedtoken.ErrInvalidSignature, http.StatusForbidden, "operation_confirmation_mismatch"},
		{"not found", store.ErrNotFound, http.StatusNotFound, "not_found"},
		{"internal redacted", errors.New("postgresql://secret /credential/home"), http.StatusInternalServerError, "credential_revocation_failed"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			runtime := &fakeCredentialRevocationRuntime{revokeErr: testCase.err}
			recorder := httptest.NewRecorder()
			credentialRevocationHandlerServer(&fakeCredentialRevocationControl{}, runtime, &fakeAuthorizer{}).
				buildMux().ServeHTTP(recorder, credentialRevocationUserRequest(t, path, body))
			if recorder.Code != testCase.status || !strings.Contains(recorder.Body.String(), testCase.code) ||
				strings.Contains(recorder.Body.String(), "postgresql://") || strings.Contains(recorder.Body.String(), "/credential/home") {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestReadyzRequiresCredentialRevocationRuntime(t *testing.T) {
	server := newWithControl(config.Config{
		WriteEnabled: true, InternalToken: "revocation-ready-internal",
		AuthTokenSecret:       "revocation-ready-auth-secret",
		DeviceChallengeSecret: "revocation-ready-independent-device-challenge-secret",
	}, &fakeReader{}, &fakeCredentialRevocationControl{}, &fakeAuthorizer{})
	server.confirmationRuntime = &fakeOperationConfirmationRuntime{}
	server.handoffRuntime = &fakeDesktopHandoffRuntime{}
	server.activationRuntime = &fakeDesktopActivationRuntime{}
	server.desktopCommandRuntime = &fakeDesktopAuthorizationCommandRuntime{}
	installTrustedTokenTestReadiness(server)

	recorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), `"controlReady":false`) {
		t.Fatalf("missing runtime status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	server.revocationRuntime = &fakeCredentialRevocationRuntime{}
	recorder = httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"controlReady":true`) {
		t.Fatalf("ready runtime status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}
