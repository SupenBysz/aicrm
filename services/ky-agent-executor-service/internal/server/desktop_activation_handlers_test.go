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

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/desktopactivation"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
)

type fakeDesktopActivationRuntime struct {
	proofInput  desktopactivation.SubmitProofInput
	proofResult desktopactivation.SubmitProofResult
	proofErr    error
	proofCalls  int
	renewInput  desktopactivation.RenewLeaseInput
	renewResult desktopactivation.RenewLeaseResult
	renewErr    error
	renewCalls  int
	ackInput    desktopactivation.AcknowledgeInput
	ackResult   desktopactivation.AcknowledgeResult
	ackErr      error
	ackCalls    int
}

func (f *fakeDesktopActivationRuntime) RenewLease(
	_ context.Context,
	input desktopactivation.RenewLeaseInput,
) (desktopactivation.RenewLeaseResult, error) {
	f.renewCalls++
	f.renewInput = input
	return f.renewResult, f.renewErr
}

func (f *fakeDesktopActivationRuntime) SubmitProof(
	_ context.Context,
	input desktopactivation.SubmitProofInput,
) (desktopactivation.SubmitProofResult, error) {
	f.proofCalls++
	f.proofInput = input
	return f.proofResult, f.proofErr
}

func (f *fakeDesktopActivationRuntime) Acknowledge(
	_ context.Context,
	input desktopactivation.AcknowledgeInput,
) (desktopactivation.AcknowledgeResult, error) {
	f.ackCalls++
	f.ackInput = input
	return f.ackResult, f.ackErr
}

func desktopActivationHandlerServer(
	control *fakeDeviceControl,
	runtime *fakeDesktopActivationRuntime,
) *Server {
	server := newWithControl(config.Config{
		HTTPAddr: "127.0.0.1:18087", WriteEnabled: true,
		InternalToken: "desktop-activation-internal", AuthTokenSecret: deviceTestAuthSecret,
		DeviceChallengeSecret: deviceTestChallengeSecret,
	}, &fakeReader{}, control, &fakeAuthorizer{})
	server.confirmationRuntime = &fakeOperationConfirmationRuntime{}
	server.handoffRuntime = &fakeDesktopHandoffRuntime{}
	server.revocationRuntime = &fakeCredentialRevocationRuntime{}
	server.desktopCommandRuntime = &fakeDesktopAuthorizationCommandRuntime{}
	if runtime != nil {
		server.activationRuntime = runtime
	}
	return server
}

func signedDesktopActivationRequest(
	t *testing.T,
	fixture deviceFixture,
	path string,
	body string,
	scheme string,
	token string,
	sequence uint64,
) *http.Request {
	t.Helper()
	authorization := scheme + " " + token
	authorizationHash, err := deviceauth.AuthorizationTokenHash(authorization, []string{scheme})
	if err != nil {
		t.Fatal(err)
	}
	nonceRaw := make([]byte, 16)
	for index := range nonceRaw {
		nonceRaw[index] = byte(index) + byte(sequence) + 43
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
	request.Header.Set("X-KY-Request-Id", "req-desktop-activation")
	request.Header.Set(deviceauth.HeaderDeviceID, proof.DeviceID)
	request.Header.Set(deviceauth.HeaderTimestamp, fmt.Sprintf("%d", proof.TimestampMilli))
	request.Header.Set(deviceauth.HeaderNonce, proof.Nonce)
	request.Header.Set(deviceauth.HeaderSequence, fmt.Sprintf("%d", sequence))
	request.Header.Set(deviceauth.HeaderContentSHA256, proof.BodySHA256)
	request.Header.Set(deviceauth.HeaderSignature, base64.RawURLEncoding.EncodeToString(ed25519.Sign(fixture.privateKey, signingInput)))
	return request
}

func desktopProofTestBody(result string) string {
	accountFingerprint, candidateDigest := "", ""
	if result == "succeeded" {
		accountFingerprint = strings.Repeat("b", 64)
		candidateDigest = strings.Repeat("c", 64)
	}
	return fmt.Sprintf(
		`{"handoffId":"handoff_1","sessionRevision":4,"loginIdHash":%q,"result":%q,"checkedAt":%q,"accountFingerprint":%q,"candidateBindingDigest":%q}`,
		strings.Repeat("a", 64), result, time.Now().UTC().Truncate(time.Millisecond).Format(time.RFC3339Nano),
		accountFingerprint, candidateDigest,
	)
}

func desktopActivationACKTestBody() string {
	return fmt.Sprintf(
		`{"operationId":"desktop_operation_1","activationId":"desktop_activation_1","credentialRevision":7,"leaseEpoch":3,"sourceCredentialRevision":6,"revocationEpoch":2,"durableBarrierCompletedAt":%q,"bindingDigest":%q}`,
		time.Now().UTC().Truncate(time.Millisecond).Format(time.RFC3339Nano), strings.Repeat("c", 64),
	)
}

func desktopActivationLeaseRenewalTestBody() string {
	return fmt.Sprintf(
		`{"operationId":"desktop_operation_1","activationId":"desktop_activation_1","credentialRevision":7,"leaseEpoch":3,"sourceCredentialRevision":6,"revocationEpoch":2,"bindingDigest":%q}`,
		strings.Repeat("c", 64),
	)
}

func desktopActivationVerificationControl(fixture deviceFixture) *fakeDeviceControl {
	return &fakeDeviceControl{verificationKey: store.DeviceVerificationKey{
		DeviceID: fixture.deviceID, PublicKey: fixture.publicKey, KeyGeneration: 2,
	}}
}

func TestDesktopProofVerifiesClaimAndReturnsLockedActivationProjection(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	runtime := &fakeDesktopActivationRuntime{proofResult: desktopactivation.SubmitProofResult{
		ProofID: "desktop_proof_1", Result: "succeeded", SessionRevision: 5,
		Activation: &desktopactivation.ActivationResult{
			ActivationID: "desktop_activation_1", OperationID: "desktop_operation_1",
			CredentialRevision: 7, LeaseEpoch: 3, SourceCredentialRevision: 6,
			RevocationEpoch: 2, BindingDigest: strings.Repeat("c", 64),
			ActivationToken: "activation.header.signature", ExpiresAt: "2026-07-13T02:10:00Z",
		},
	}}
	server := desktopActivationHandlerServer(desktopActivationVerificationControl(fixture), runtime)
	path := desktopProofPath("auth_session_1")
	body := desktopProofTestBody("succeeded")
	request := signedDesktopActivationRequest(t, fixture, path, body, "AiCRM-Claim", "claim.header.signature", 9)
	recorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	input := runtime.proofInput
	if runtime.proofCalls != 1 || input.ClaimToken != "claim.header.signature" ||
		input.SessionID != "auth_session_1" || input.HandoffID != "handoff_1" ||
		input.TargetDeviceID != fixture.deviceID || input.KeyGeneration != 2 ||
		input.SessionRevision != 4 || input.Result != "succeeded" || input.Proof.AuthorizationTokenHash == "" ||
		input.AccountFingerprint != strings.Repeat("b", 64) ||
		input.CandidateBindingDigest != strings.Repeat("c", 64) ||
		input.LedgerExpiresAt.Before(time.Now().UTC().Add(store.DeviceLedgerAuditRetention)) {
		t.Fatalf("proof input=%#v", input)
	}
	for _, expected := range []string{
		`"proofId":"desktop_proof_1"`, `"operationId":"desktop_operation_1"`,
		`"activationId":"desktop_activation_1"`, `"credentialRevision":7`,
		`"leaseEpoch":3`, `"sourceCredentialRevision":6`, `"revocationEpoch":2`,
		`"activationToken":"activation.header.signature"`,
	} {
		if !strings.Contains(recorder.Body.String(), expected) {
			t.Fatalf("response missing %s: %s", expected, recorder.Body.String())
		}
	}
	if recorder.Header().Get("Cache-Control") != "no-store" || recorder.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("unsafe response headers=%v", recorder.Header())
	}
}

func TestDesktopProofTerminalResultHasNoActivationFields(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	for _, result := range []string{"failed", "cancelled"} {
		t.Run(result, func(t *testing.T) {
			runtime := &fakeDesktopActivationRuntime{proofResult: desktopactivation.SubmitProofResult{
				ProofID: "desktop_proof_terminal", Result: result, SessionRevision: 5, Replayed: true,
			}}
			path := desktopProofPath("auth_session_1")
			body := desktopProofTestBody(result)
			request := signedDesktopActivationRequest(t, fixture, path, body, "AiCRM-Claim", "claim.header.signature", uint64(20+len(result)))
			recorder := httptest.NewRecorder()
			desktopActivationHandlerServer(desktopActivationVerificationControl(fixture), runtime).buildMux().ServeHTTP(recorder, request)
			if recorder.Code != http.StatusOK || runtime.proofCalls != 1 ||
				runtime.proofInput.AccountFingerprint != "" || runtime.proofInput.CandidateBindingDigest != "" ||
				strings.Contains(recorder.Body.String(), "activationId") ||
				strings.Contains(recorder.Body.String(), "activationToken") ||
				!strings.Contains(recorder.Body.String(), `"replayed":true`) {
				t.Fatalf("status=%d input=%#v body=%s", recorder.Code, runtime.proofInput, recorder.Body.String())
			}
		})
	}
}

func TestDesktopActivationLeaseRenewalVerifiesTokenAndReturnsDatabaseTimes(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	runtime := &fakeDesktopActivationRuntime{renewResult: desktopactivation.RenewLeaseResult{
		ActivationID: "desktop_activation_1", ExecutorID: "executor_1",
		OperationID: "desktop_operation_1", CredentialRevision: 7, LeaseEpoch: 3,
		SourceCredentialRevision: 6, RevocationEpoch: 2,
		RenewedAt:      "2026-07-13T02:00:00.123456Z",
		LeaseExpiresAt: "2026-07-13T02:00:30.123456Z", Replayed: true,
	}}
	path := desktopActivationLeaseRenewalPath("auth_session_1", "desktop_activation_1")
	body := desktopActivationLeaseRenewalTestBody()
	request := signedDesktopActivationRequest(
		t, fixture, path, body, "AiCRM-Activation", "activation.header.signature", 30,
	)
	recorder := httptest.NewRecorder()
	desktopActivationHandlerServer(desktopActivationVerificationControl(fixture), runtime).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	input := runtime.renewInput
	if runtime.renewCalls != 1 || input.ActivationToken != "activation.header.signature" ||
		input.SessionID != "auth_session_1" || input.ActivationID != "desktop_activation_1" ||
		input.OperationID != "desktop_operation_1" || input.TargetDeviceID != fixture.deviceID ||
		input.KeyGeneration != 2 || input.CredentialRevision != 7 || input.LeaseEpoch != 3 ||
		input.SourceCredentialRevision != 6 || input.RevocationEpoch != 2 ||
		input.BindingDigest != strings.Repeat("c", 64) || input.Proof.AuthorizationTokenHash == "" ||
		input.LedgerExpiresAt.Before(time.Now().UTC().Add(store.DeviceLedgerAuditRetention)) {
		t.Fatalf("renew input=%#v", input)
	}
	for _, expected := range []string{
		`"activationId":"desktop_activation_1"`, `"executorId":"executor_1"`,
		`"operationId":"desktop_operation_1"`, `"credentialRevision":7`, `"leaseEpoch":3`,
		`"sourceCredentialRevision":6`, `"revocationEpoch":2`,
		`"renewedAt":"2026-07-13T02:00:00.123456Z"`,
		`"leaseExpiresAt":"2026-07-13T02:00:30.123456Z"`, `"replayed":true`,
	} {
		if !strings.Contains(recorder.Body.String(), expected) {
			t.Fatalf("response missing %s: %s", expected, recorder.Body.String())
		}
	}
	if strings.Contains(recorder.Body.String(), "activation.header.signature") ||
		recorder.Header().Get("Cache-Control") != "no-store" ||
		recorder.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("unsafe renewal response headers=%v body=%s", recorder.Header(), recorder.Body.String())
	}
}

func TestDesktopActivationLeaseRenewalRejectsOverridesAndMismatchedBody(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	path := desktopActivationLeaseRenewalPath("auth_session_1", "desktop_activation_1")
	valid := desktopActivationLeaseRenewalTestBody()
	tests := []struct {
		name   string
		body   string
		mutate func(*http.Request)
		status int
	}{
		{"query", valid, func(r *http.Request) { r.URL.RawQuery = "x=1"; r.RequestURI = path + "?x=1" }, http.StatusBadRequest},
		{"workspace", valid, func(r *http.Request) { r.Header.Set("X-KY-Workspace-Type", "platform") }, http.StatusBadRequest},
		{"wrong activation", strings.Replace(valid, `"activationId":"desktop_activation_1"`, `"activationId":"desktop_activation_other"`, 1), nil, http.StatusBadRequest},
		{"unknown", strings.TrimSuffix(valid, "}") + `,"leaseSeconds":30}`, nil, http.StatusBadRequest},
	}
	for index, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			runtime := &fakeDesktopActivationRuntime{}
			request := signedDesktopActivationRequest(
				t, fixture, path, testCase.body, "AiCRM-Activation", "activation.header.signature", uint64(31+index),
			)
			if testCase.mutate != nil {
				testCase.mutate(request)
			}
			recorder := httptest.NewRecorder()
			desktopActivationHandlerServer(desktopActivationVerificationControl(fixture), runtime).buildMux().ServeHTTP(recorder, request)
			if recorder.Code != testCase.status || runtime.renewCalls != 0 {
				t.Fatalf("status=%d body=%s calls=%d", recorder.Code, recorder.Body.String(), runtime.renewCalls)
			}
		})
	}
}

func TestDesktopActivationLeaseRenewalMapsFenceAndExpiredToken(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	path := desktopActivationLeaseRenewalPath("auth_session_1", "desktop_activation_1")
	body := desktopActivationLeaseRenewalTestBody()
	tests := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"fenced", store.ErrExecutorFenced, http.StatusConflict, "executor_fenced"},
		{"expired", trustedtoken.ErrExpired, http.StatusGone, "desktop_authorization_gone"},
	}
	for index, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			runtime := &fakeDesktopActivationRuntime{renewErr: testCase.err}
			request := signedDesktopActivationRequest(
				t, fixture, path, body, "AiCRM-Activation", "activation.header.signature", uint64(50+index),
			)
			recorder := httptest.NewRecorder()
			desktopActivationHandlerServer(desktopActivationVerificationControl(fixture), runtime).buildMux().ServeHTTP(recorder, request)
			if recorder.Code != testCase.status || runtime.renewCalls != 1 ||
				!strings.Contains(recorder.Body.String(), testCase.code) ||
				strings.Contains(recorder.Body.String(), "activation.header.signature") {
				t.Fatalf("status=%d calls=%d body=%s", recorder.Code, runtime.renewCalls, recorder.Body.String())
			}
		})
	}
}

func TestDesktopActivationACKVerifiesTokenAndReturnsSafeProjection(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	runtime := &fakeDesktopActivationRuntime{ackResult: desktopactivation.AcknowledgeResult{
		ActivationID: "desktop_activation_1", ExecutorID: "executor_1",
		CredentialRevision: 7, SessionRevision: 6, Replayed: true,
	}}
	path := desktopActivationACKPath("auth_session_1", "desktop_activation_1")
	body := desktopActivationACKTestBody()
	request := signedDesktopActivationRequest(t, fixture, path, body, "AiCRM-Activation", "activation.header.signature", 31)
	recorder := httptest.NewRecorder()
	desktopActivationHandlerServer(desktopActivationVerificationControl(fixture), runtime).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	input := runtime.ackInput
	if runtime.ackCalls != 1 || input.ActivationToken != "activation.header.signature" ||
		input.SessionID != "auth_session_1" || input.ActivationID != "desktop_activation_1" ||
		input.OperationID != "desktop_operation_1" || input.TargetDeviceID != fixture.deviceID ||
		input.KeyGeneration != 2 || input.CredentialRevision != 7 || input.LeaseEpoch != 3 ||
		input.SourceCredentialRevision != 6 || input.RevocationEpoch != 2 ||
		input.BindingDigest != strings.Repeat("c", 64) || input.Proof.AuthorizationTokenHash == "" ||
		input.LedgerExpiresAt.Before(time.Now().UTC().Add(store.DeviceLedgerAuditRetention)) {
		t.Fatalf("ack input=%#v", input)
	}
	for _, expected := range []string{
		`"activationId":"desktop_activation_1"`, `"executorId":"executor_1"`,
		`"credentialRevision":7`, `"sessionRevision":6`, `"replayed":true`,
	} {
		if !strings.Contains(recorder.Body.String(), expected) {
			t.Fatalf("response missing %s: %s", expected, recorder.Body.String())
		}
	}
	if strings.Contains(recorder.Body.String(), "activation.header.signature") {
		t.Fatalf("ack leaked token: %s", recorder.Body.String())
	}
}

func TestDesktopActivationEndpointsRejectOverridesAndNonCanonicalRequests(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	path := desktopProofPath("auth_session_1")
	body := desktopProofTestBody("succeeded")
	newRequest := func(sequence uint64) *http.Request {
		return signedDesktopActivationRequest(t, fixture, path, body, "AiCRM-Claim", "claim.header.signature", sequence)
	}
	testCases := []struct {
		name   string
		mutate func(*http.Request)
		status int
	}{
		{"query", func(r *http.Request) { r.URL.RawQuery = "x=1"; r.RequestURI = path + "?x=1" }, http.StatusBadRequest},
		{"percent encoded path", func(r *http.Request) { r.RequestURI = strings.Replace(path, "auth_session_1", "%61uth_session_1", 1) }, http.StatusBadRequest},
		{"workspace", func(r *http.Request) { r.Header.Set("X-KY-Workspace-Type", "platform") }, http.StatusBadRequest},
		{"idempotency", func(r *http.Request) { r.Header.Set("Idempotency-Key", "forbidden") }, http.StatusBadRequest},
		{"bearer", func(r *http.Request) { r.Header.Set("Authorization", "Bearer forbidden") }, http.StatusUnauthorized},
		{"duplicate authorization", func(r *http.Request) { r.Header.Add("Authorization", "AiCRM-Claim duplicate") }, http.StatusUnauthorized},
		{"duplicate content type", func(r *http.Request) { r.Header.Add("Content-Type", "application/json") }, http.StatusBadRequest},
	}
	for index, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			runtime := &fakeDesktopActivationRuntime{}
			request := newRequest(uint64(40 + index))
			testCase.mutate(request)
			recorder := httptest.NewRecorder()
			desktopActivationHandlerServer(desktopActivationVerificationControl(fixture), runtime).buildMux().ServeHTTP(recorder, request)
			if recorder.Code != testCase.status || runtime.proofCalls != 0 {
				t.Fatalf("status=%d body=%s calls=%d", recorder.Code, recorder.Body.String(), runtime.proofCalls)
			}
		})
	}
}

func TestDesktopProofRejectsDuplicateJSONAndResultShape(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	path := desktopProofPath("auth_session_1")
	valid := desktopProofTestBody("succeeded")
	testCases := []struct {
		name string
		body string
	}{
		{"duplicate", strings.Replace(valid, `"handoffId":"handoff_1"`, `"handoffId":"handoff_1","handoffId":"handoff_1"`, 1)},
		{"unknown", strings.TrimSuffix(valid, "}") + `,"credentialPath":"/secret"}`},
		{"failed with account", strings.Replace(valid, `"result":"succeeded"`, `"result":"failed"`, 1)},
		{"succeeded without account", strings.Replace(desktopProofTestBody("failed"), `"result":"failed"`, `"result":"succeeded"`, 1)},
		{"missing login hash", strings.Replace(valid, `"loginIdHash":"`+strings.Repeat("a", 64)+`",`, "", 1)},
	}
	for index, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			runtime := &fakeDesktopActivationRuntime{}
			request := signedDesktopActivationRequest(t, fixture, path, testCase.body, "AiCRM-Claim", "claim.header.signature", uint64(60+index))
			recorder := httptest.NewRecorder()
			desktopActivationHandlerServer(desktopActivationVerificationControl(fixture), runtime).buildMux().ServeHTTP(recorder, request)
			if recorder.Code != http.StatusBadRequest || runtime.proofCalls != 0 {
				t.Fatalf("status=%d body=%s calls=%d", recorder.Code, recorder.Body.String(), runtime.proofCalls)
			}
		})
	}
}

func TestDesktopActivationRejectsAlteredBodyTokenDeviceAndCrossSession(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	path := desktopActivationACKPath("auth_session_1", "desktop_activation_1")
	body := desktopActivationACKTestBody()
	t.Run("altered body", func(t *testing.T) {
		runtime := &fakeDesktopActivationRuntime{}
		request := signedDesktopActivationRequest(t, fixture, path, body, "AiCRM-Activation", "activation.header.signature", 71)
		altered := strings.Replace(body, `"leaseEpoch":3`, `"leaseEpoch":4`, 1)
		request.Body = io.NopCloser(strings.NewReader(altered))
		request.ContentLength = int64(len(altered))
		recorder := httptest.NewRecorder()
		desktopActivationHandlerServer(desktopActivationVerificationControl(fixture), runtime).buildMux().ServeHTTP(recorder, request)
		if recorder.Code != http.StatusForbidden || runtime.ackCalls != 0 {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	})
	t.Run("altered token", func(t *testing.T) {
		runtime := &fakeDesktopActivationRuntime{}
		request := signedDesktopActivationRequest(t, fixture, path, body, "AiCRM-Activation", "activation.header.signature", 72)
		request.Header.Set("Authorization", "AiCRM-Activation altered.header.signature")
		recorder := httptest.NewRecorder()
		desktopActivationHandlerServer(desktopActivationVerificationControl(fixture), runtime).buildMux().ServeHTTP(recorder, request)
		if recorder.Code != http.StatusForbidden || runtime.ackCalls != 0 {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	})
	t.Run("wrong device", func(t *testing.T) {
		runtime := &fakeDesktopActivationRuntime{}
		other := fixture
		seed := make([]byte, ed25519.SeedSize)
		for index := range seed {
			seed[index] = byte(index + 77)
		}
		other.privateKey = ed25519.NewKeyFromSeed(seed)
		request := signedDesktopActivationRequest(t, other, path, body, "AiCRM-Activation", "activation.header.signature", 73)
		recorder := httptest.NewRecorder()
		desktopActivationHandlerServer(desktopActivationVerificationControl(fixture), runtime).buildMux().ServeHTTP(recorder, request)
		if recorder.Code != http.StatusForbidden || runtime.ackCalls != 0 {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	})
	t.Run("cross session hidden", func(t *testing.T) {
		runtime := &fakeDesktopActivationRuntime{ackErr: store.ErrNotFound}
		request := signedDesktopActivationRequest(t, fixture, path, body, "AiCRM-Activation", "activation.header.signature", 74)
		recorder := httptest.NewRecorder()
		desktopActivationHandlerServer(desktopActivationVerificationControl(fixture), runtime).buildMux().ServeHTTP(recorder, request)
		if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "authorization_proof_invalid") ||
			strings.Contains(recorder.Body.String(), "not_found") {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	})
}

func TestDesktopActivationErrorMappingDistinguishesReplayFenceAndRotation(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	path := desktopProofPath("auth_session_1")
	body := desktopProofTestBody("succeeded")
	testCases := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"replay", store.ErrDeviceProofReplayed, http.StatusConflict, deviceauth.DeviceProofReplayedCode},
		{"proof conflict", store.ErrDesktopProofConflict, http.StatusConflict, "desktop_proof_conflict"},
		{"revision", store.ErrRevisionConflict, http.StatusConflict, "revision_conflict"},
		{"fenced", store.ErrExecutorFenced, http.StatusConflict, "executor_fenced"},
		{"busy", store.ErrExecutorBusy, http.StatusConflict, "executor_has_active_tasks"},
		{"cross session hidden", store.ErrNotFound, http.StatusForbidden, "authorization_proof_invalid"},
		{"rotation", trustedtoken.ErrUnknownKey, http.StatusGone, "desktop_authorization_gone"},
		{"expired", trustedtoken.ErrExpired, http.StatusGone, "desktop_authorization_gone"},
	}
	for index, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			runtime := &fakeDesktopActivationRuntime{proofErr: testCase.err}
			request := signedDesktopActivationRequest(t, fixture, path, body, "AiCRM-Claim", "claim.header.signature", uint64(90+index))
			recorder := httptest.NewRecorder()
			desktopActivationHandlerServer(desktopActivationVerificationControl(fixture), runtime).buildMux().ServeHTTP(recorder, request)
			if recorder.Code != testCase.status || !strings.Contains(recorder.Body.String(), testCase.code) {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestDesktopActivationACKMapsRotatedActivationKeyToGone(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	runtime := &fakeDesktopActivationRuntime{ackErr: trustedtoken.ErrUnknownKey}
	path := desktopActivationACKPath("auth_session_1", "desktop_activation_1")
	request := signedDesktopActivationRequest(
		t, fixture, path, desktopActivationACKTestBody(),
		"AiCRM-Activation", "rotated.header.signature", 105,
	)
	recorder := httptest.NewRecorder()
	desktopActivationHandlerServer(desktopActivationVerificationControl(fixture), runtime).buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusGone || !strings.Contains(recorder.Body.String(), "desktop_authorization_gone") ||
		strings.Contains(recorder.Body.String(), "rotated.header.signature") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestDesktopActivationACKRejectsDuplicateAndMismatchedBody(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	path := desktopActivationACKPath("auth_session_1", "desktop_activation_1")
	valid := desktopActivationACKTestBody()
	testCases := []string{
		strings.Replace(valid, `"activationId":"desktop_activation_1"`, `"activationId":"desktop_activation_1","activationId":"desktop_activation_1"`, 1),
		strings.Replace(valid, `"activationId":"desktop_activation_1"`, `"activationId":"desktop_activation_other"`, 1),
		strings.Replace(valid, `"bindingDigest":"`+strings.Repeat("c", 64)+`"`, `"bindingDigest":"invalid"`, 1),
		strings.TrimSuffix(valid, "}") + `,"result":"succeeded"}`,
	}
	for index, body := range testCases {
		runtime := &fakeDesktopActivationRuntime{}
		request := signedDesktopActivationRequest(t, fixture, path, body, "AiCRM-Activation", "activation.header.signature", uint64(110+index))
		recorder := httptest.NewRecorder()
		desktopActivationHandlerServer(desktopActivationVerificationControl(fixture), runtime).buildMux().ServeHTTP(recorder, request)
		if recorder.Code != http.StatusBadRequest || runtime.ackCalls != 0 {
			t.Fatalf("case=%d status=%d body=%s", index, recorder.Code, recorder.Body.String())
		}
	}
}

func TestDesktopActivationReadyzRequiresRuntime(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	server := desktopActivationHandlerServer(desktopActivationVerificationControl(fixture), nil)
	recorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), `"controlReady":false`) {
		t.Fatalf("missing runtime status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	server.activationRuntime = &fakeDesktopActivationRuntime{}
	recorder = httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"controlReady":true`) {
		t.Fatalf("ready runtime status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestDesktopActivationResponsesAreJSONObjects(t *testing.T) {
	fixture := newDeviceHandlerFixture(t)
	runtime := &fakeDesktopActivationRuntime{proofResult: desktopactivation.SubmitProofResult{
		ProofID: "desktop_proof_1", Result: "failed", SessionRevision: 5,
	}}
	path := desktopProofPath("auth_session_1")
	request := signedDesktopActivationRequest(t, fixture, path, desktopProofTestBody("failed"), "AiCRM-Claim", "claim.header.signature", 130)
	recorder := httptest.NewRecorder()
	desktopActivationHandlerServer(desktopActivationVerificationControl(fixture), runtime).buildMux().ServeHTTP(recorder, request)
	var envelope struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil || envelope.Data["proofId"] != "desktop_proof_1" {
		t.Fatalf("response=%s err=%v", recorder.Body.String(), err)
	}
}
