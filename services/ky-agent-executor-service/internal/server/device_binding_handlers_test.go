package server

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/accessclient"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/operationconfirmation"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
	"github.com/Kysion/KyaiCRM/shared/auth"
)

type deviceBindingReplay struct {
	result  store.DeviceBindingResult
	handled bool
	err     error
}

type fakeDeviceBindingControl struct {
	fakeControl
	verificationKey store.DeviceVerificationKey
	verificationErr error
	verificationIDs []string
	bindInput       store.BindDeviceInput
	bindResult      store.DeviceBindingResult
	bindErr         error
	bindCalls       int
	rebindInput     store.RebindDeviceInput
	unbindInput     store.UnbindDeviceInput
	rebindMutation  store.DeviceBindingResult
	unbindMutation  store.DeviceBindingResult
	mutationErr     error
	rebindReplays   []deviceBindingReplay
	unbindReplays   []deviceBindingReplay
	forceReplays    []deviceBindingReplay
	rebindCalls     int
	unbindCalls     int
	forceCalls      int
}

func (f *fakeDeviceBindingControl) GetDeviceVerificationKey(
	_ context.Context,
	deviceID string,
) (store.DeviceVerificationKey, error) {
	f.verificationIDs = append(f.verificationIDs, deviceID)
	return f.verificationKey, f.verificationErr
}

func (f *fakeDeviceBindingControl) BindDevice(
	_ context.Context,
	input store.BindDeviceInput,
) (store.DeviceBindingResult, error) {
	f.bindCalls++
	f.bindInput = input
	return f.bindResult, f.bindErr
}

func (f *fakeDeviceBindingControl) ReplayRebindDevice(
	_ context.Context,
	input store.RebindDeviceInput,
) (store.DeviceBindingResult, bool, error) {
	f.rebindCalls++
	f.rebindInput = input
	return bindingReplayAt(f.rebindReplays, f.rebindCalls)
}

func (f *fakeDeviceBindingControl) ReplayUnbindDevice(
	_ context.Context,
	input store.UnbindDeviceInput,
) (store.DeviceBindingResult, bool, error) {
	f.unbindCalls++
	f.unbindInput = input
	return bindingReplayAt(f.unbindReplays, f.unbindCalls)
}

func (f *fakeDeviceBindingControl) ReplayForceUnbindDevice(
	_ context.Context,
	input store.UnbindDeviceInput,
) (store.DeviceBindingResult, bool, error) {
	f.forceCalls++
	f.unbindInput = input
	return bindingReplayAt(f.forceReplays, f.forceCalls)
}

func (f *fakeDeviceBindingControl) RebindDeviceMutation(
	input store.RebindDeviceInput,
	capture *store.DeviceBindingResult,
) store.OperationConfirmationMutation {
	f.rebindInput = input
	return func(context.Context, *sql.Tx, store.OperationConfirmationProjection) error {
		if f.mutationErr != nil {
			return f.mutationErr
		}
		*capture = f.rebindMutation
		return nil
	}
}

func (f *fakeDeviceBindingControl) UnbindDeviceMutation(
	input store.UnbindDeviceInput,
	capture *store.DeviceBindingResult,
) store.OperationConfirmationMutation {
	f.unbindInput = input
	return func(context.Context, *sql.Tx, store.OperationConfirmationProjection) error {
		if f.mutationErr != nil {
			return f.mutationErr
		}
		*capture = f.unbindMutation
		return nil
	}
}

func bindingReplayAt(items []deviceBindingReplay, call int) (store.DeviceBindingResult, bool, error) {
	if call <= 0 || call > len(items) {
		return store.DeviceBindingResult{}, false, nil
	}
	item := items[call-1]
	return item.result, item.handled, item.err
}

type fakeDeviceBindingConfirmationRuntime struct {
	fakeOperationConfirmationRuntime
	consumeInput operationconfirmation.ConsumeInput
	consumeErr   error
	consumeCalls int
}

func (f *fakeDeviceBindingConfirmationRuntime) Consume(
	ctx context.Context,
	input operationconfirmation.ConsumeInput,
	mutation store.OperationConfirmationMutation,
) (store.OperationConfirmationProjection, error) {
	f.consumeCalls++
	f.consumeInput = input
	if f.consumeErr != nil {
		return store.OperationConfirmationProjection{}, f.consumeErr
	}
	projection := store.OperationConfirmationProjection{
		ID: "confirmation_1", Action: input.Action, ActorID: input.ActorID,
		ActorSessionID: input.ActorSessionID, ExecutorID: input.ExecutorID,
		ExpectedRevision: input.ExpectedRevision, FromDeviceID: input.FromDeviceID,
		TargetDeviceID: input.TargetDeviceID, SecurityFactsVerified: true,
	}
	if err := mutation(ctx, nil, projection); err != nil {
		return store.OperationConfirmationProjection{}, err
	}
	return projection, nil
}

func deviceBindingHandlerServer(
	control *fakeDeviceBindingControl,
	runtime *fakeDeviceBindingConfirmationRuntime,
	authorizer accessclient.Authorizer,
) *Server {
	server := newWithControl(config.Config{
		HTTPAddr: "127.0.0.1:18087", WriteEnabled: true,
		InternalToken: "device-binding-internal", AuthTokenSecret: deviceTestAuthSecret,
	}, &fakeReader{}, control, authorizer)
	server.confirmationRuntime = runtime
	return server
}

func newDeviceBindingFixture(t *testing.T, seedByte byte) deviceFixture {
	t.Helper()
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = seedByte + byte(index)
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

func signedDeviceBindingRequest(
	t *testing.T,
	fixture deviceFixture,
	method string,
	path string,
	body string,
	token string,
	sequence uint64,
) *http.Request {
	t.Helper()
	authorization := "Bearer " + token
	authorizationHash, err := deviceauth.AuthorizationTokenHash(authorization, []string{"Bearer"})
	if err != nil {
		t.Fatal(err)
	}
	nonceRaw := make([]byte, 16)
	for index := range nonceRaw {
		nonceRaw[index] = byte(index) + byte(sequence) + 3
	}
	proof := deviceauth.ProofHeaders{
		DeviceID: fixture.deviceID, TimestampMilli: time.Now().UTC().UnixMilli(),
		Nonce: base64.RawURLEncoding.EncodeToString(nonceRaw), Sequence: sequence,
		BodySHA256: deviceauth.HashBody([]byte(body)),
	}
	signingInput, err := deviceauth.SigningInput(method, path, proof, authorizationHash)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Authorization", authorization)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-KY-Request-Id", "req-device-binding")
	request.Header.Set("X-KY-Workspace-Type", "platform")
	request.Header.Set("X-KY-Workspace-Id", "platform_root")
	request.Header.Set(deviceauth.HeaderDeviceID, proof.DeviceID)
	request.Header.Set(deviceauth.HeaderTimestamp, fmt.Sprintf("%d", proof.TimestampMilli))
	request.Header.Set(deviceauth.HeaderNonce, proof.Nonce)
	request.Header.Set(deviceauth.HeaderSequence, fmt.Sprintf("%d", proof.Sequence))
	request.Header.Set(deviceauth.HeaderContentSHA256, proof.BodySHA256)
	request.Header.Set(deviceauth.HeaderSignature,
		base64.RawURLEncoding.EncodeToString(ed25519.Sign(fixture.privateKey, signingInput)))
	return request
}

func unsignedDeviceBindingRequest(t *testing.T, method, path, body, token string) *http.Request {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-KY-Request-Id", "req-device-binding")
	request.Header.Set("X-KY-Workspace-Type", "platform")
	request.Header.Set("X-KY-Workspace-Id", "platform_root")
	return request
}

func TestDeviceBindingInitialBindUsesTargetProofAndLeastPrivilege(t *testing.T) {
	fixture := newDeviceBindingFixture(t, 31)
	const executorID = "executor_binding_1"
	path := bindExecutorDevicePath(executorID)
	body := fmt.Sprintf(`{"deviceId":%q,"expectedRevision":0}`, fixture.deviceID)
	token := deviceBearerToken(t)
	control := &fakeDeviceBindingControl{
		verificationKey: store.DeviceVerificationKey{
			DeviceID: fixture.deviceID, PublicKey: fixture.publicKey, Status: "active", KeyGeneration: 2,
		},
		bindResult: store.DeviceBindingResult{Binding: store.DeviceBindingProjection{
			ExecutorID: executorID, DeviceID: fixture.deviceID, Status: "active", Revision: 1,
			UpdatedAt: "2026-07-13T01:00:00Z",
		}},
	}
	authorizer := &fakeAuthorizer{}
	runtime := &fakeDeviceBindingConfirmationRuntime{}
	recorder := httptest.NewRecorder()
	deviceBindingHandlerServer(control, runtime, authorizer).buildMux().ServeHTTP(
		recorder, signedDeviceBindingRequest(t, fixture, http.MethodPost, path, body, token, 4),
	)
	if recorder.Code != http.StatusCreated || recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d headers=%v body=%s", recorder.Code, recorder.Header(), recorder.Body.String())
	}
	if control.bindCalls != 1 || control.bindInput.ExecutorID != executorID ||
		control.bindInput.TargetDeviceID != fixture.deviceID || control.bindInput.ExpectedRevision != 0 ||
		control.bindInput.KeyGeneration != 2 || control.bindInput.ActorID != "device_owner_1" ||
		control.bindInput.ActorSessionID != "device_session_1" {
		t.Fatalf("unexpected bind input: %#v", control.bindInput)
	}
	if control.bindInput.Proof.AuthorizationTokenHash != sha256Hex([]byte(token)) ||
		control.bindInput.OperationReference != deviceBindingOperationReference("bind", control.bindInput.Proof.RequestHash) ||
		control.bindInput.LedgerExpiresAt.Before(time.Now().UTC().Add(store.DeviceLedgerAuditRetention)) {
		t.Fatalf("unsafe proof/retention input: %#v", control.bindInput)
	}
	if len(authorizer.request.RequiredAllPermissions) != 1 ||
		authorizer.request.RequiredAllPermissions[0] != permissionDeviceBind || runtime.consumeCalls != 0 {
		t.Fatalf("unexpected authorization/runtime: request=%#v calls=%d", authorizer.request, runtime.consumeCalls)
	}
	if strings.Contains(recorder.Body.String(), token) || strings.Contains(recorder.Body.String(), control.bindInput.OperationReference) {
		t.Fatalf("response leaked request proof material: %s", recorder.Body.String())
	}
}

func TestDeviceBindingRebindConsumesExactClaimsAndRecoversConsumedRace(t *testing.T) {
	from := newDeviceBindingFixture(t, 41)
	to := newDeviceBindingFixture(t, 71)
	const executorID = "executor_binding_2"
	path := rebindExecutorDevicePath(executorID)
	body := fmt.Sprintf(`{"fromDeviceId":%q,"toDeviceId":%q,"expectedRevision":7,"confirmationToken":"confirmation-token-7"}`,
		from.deviceID, to.deviceID)
	token := deviceBearerToken(t)
	result := store.DeviceBindingResult{Binding: store.DeviceBindingProjection{
		ExecutorID: executorID, DeviceID: to.deviceID, Status: "active", Revision: 8,
	}, Replayed: true}
	control := &fakeDeviceBindingControl{
		verificationKey: store.DeviceVerificationKey{
			DeviceID: to.deviceID, PublicKey: to.publicKey, Status: "active", KeyGeneration: 1,
		},
		rebindMutation: result,
		rebindReplays: []deviceBindingReplay{
			{},
			{result: result, handled: true},
		},
	}
	runtime := &fakeDeviceBindingConfirmationRuntime{consumeErr: store.ErrOperationConfirmationTokenConsumed}
	authorizer := &fakeAuthorizer{}
	recorder := httptest.NewRecorder()
	deviceBindingHandlerServer(control, runtime, authorizer).buildMux().ServeHTTP(
		recorder, signedDeviceBindingRequest(t, to, http.MethodPost, path, body, token, 1),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if control.rebindCalls != 2 || runtime.consumeCalls != 1 ||
		runtime.consumeInput.Action != store.OperationConfirmationRebindDevice ||
		runtime.consumeInput.ActorID != "device_owner_1" || runtime.consumeInput.ActorSessionID != "device_session_1" ||
		runtime.consumeInput.ExecutorID != executorID || runtime.consumeInput.ExpectedRevision != 7 ||
		runtime.consumeInput.FromDeviceID != from.deviceID || runtime.consumeInput.TargetDeviceID != to.deviceID ||
		runtime.consumeInput.ConfirmationToken != "confirmation-token-7" ||
		runtime.consumeInput.ConsumptionReference != control.rebindInput.OperationReference {
		t.Fatalf("unexpected consume/replay: consume=%#v replayCalls=%d", runtime.consumeInput, control.rebindCalls)
	}
	if control.rebindInput.Proof.DeviceID != to.deviceID || control.rebindInput.Proof.AuthorizationTokenHash == "" ||
		len(authorizer.request.RequiredAllPermissions) != 1 || authorizer.request.RequiredAllPermissions[0] != permissionDeviceRebind {
		t.Fatalf("unexpected rebind proof/permission: input=%#v auth=%#v", control.rebindInput, authorizer.request)
	}
	var response struct {
		Data struct {
			Replayed bool                          `json:"replayed"`
			Binding  store.DeviceBindingProjection `json:"binding"`
		} `json:"data"`
	}
	if json.Unmarshal(recorder.Body.Bytes(), &response) != nil || !response.Data.Replayed || response.Data.Binding.Revision != 8 {
		t.Fatalf("unexpected replay response: %s", recorder.Body.String())
	}
}

func TestDeviceBindingExactReplayVerifiesBeforeInactiveStateIsDeferredToCore(t *testing.T) {
	from := newDeviceBindingFixture(t, 61)
	to := newDeviceBindingFixture(t, 81)
	const executorID = "executor_binding_inactive_replay"
	path := rebindExecutorDevicePath(executorID)
	body := fmt.Sprintf(`{"fromDeviceId":%q,"toDeviceId":%q,"expectedRevision":9,"confirmationToken":"confirmation-token-9"}`,
		from.deviceID, to.deviceID)
	result := store.DeviceBindingResult{Binding: store.DeviceBindingProjection{
		ExecutorID: executorID, DeviceID: to.deviceID, Status: "active", Revision: 10,
	}, Replayed: true}
	control := &fakeDeviceBindingControl{
		verificationKey: store.DeviceVerificationKey{
			DeviceID: to.deviceID, PublicKey: to.publicKey, Status: "disabled", KeyGeneration: 1,
		},
		rebindReplays: []deviceBindingReplay{{result: result, handled: true}},
	}
	runtime := &fakeDeviceBindingConfirmationRuntime{}
	recorder := httptest.NewRecorder()
	deviceBindingHandlerServer(control, runtime, &fakeAuthorizer{}).buildMux().ServeHTTP(
		recorder, signedDeviceBindingRequest(t, to, http.MethodPost, path, body, deviceBearerToken(t), 1),
	)
	if recorder.Code != http.StatusOK || control.rebindCalls != 1 || runtime.consumeCalls != 0 {
		t.Fatalf("inactive exact replay status=%d replay=%d consume=%d body=%s",
			recorder.Code, control.rebindCalls, runtime.consumeCalls, recorder.Body.String())
	}
}

func TestDeviceBindingNormalUnbindUsesCurrentDeviceProofAndAtomicMutation(t *testing.T) {
	current := newDeviceBindingFixture(t, 91)
	const executorID = "executor_binding_3"
	path := unbindExecutorDevicePath(executorID)
	body := fmt.Sprintf(`{"deviceId":%q,"expectedRevision":3,"confirmationToken":"confirmation-token-3","force":false}`,
		current.deviceID)
	token := deviceBearerToken(t)
	control := &fakeDeviceBindingControl{
		verificationKey: store.DeviceVerificationKey{
			DeviceID: current.deviceID, PublicKey: current.publicKey, Status: "active", KeyGeneration: 4,
		},
		unbindMutation: store.DeviceBindingResult{Binding: store.DeviceBindingProjection{
			ExecutorID: executorID, DeviceID: current.deviceID, Status: "revoked", Revision: 4,
		}},
	}
	runtime := &fakeDeviceBindingConfirmationRuntime{}
	recorder := httptest.NewRecorder()
	deviceBindingHandlerServer(control, runtime, &fakeAuthorizer{}).buildMux().ServeHTTP(
		recorder, signedDeviceBindingRequest(t, current, http.MethodDelete, path, body, token, 8),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if control.unbindCalls != 1 || runtime.consumeCalls != 1 || control.unbindInput.Force ||
		control.unbindInput.Proof.DeviceID != current.deviceID || control.unbindInput.KeyGeneration != 4 ||
		runtime.consumeInput.Action != store.OperationConfirmationUnbindDevice ||
		runtime.consumeInput.FromDeviceID != current.deviceID || runtime.consumeInput.TargetDeviceID != "" {
		t.Fatalf("unexpected normal unbind: input=%#v consume=%#v", control.unbindInput, runtime.consumeInput)
	}
}

func TestDeviceBindingForceUnbindIsTheOnlyProoflessPathAndReplaysAfterConsume(t *testing.T) {
	device := newDeviceBindingFixture(t, 111)
	const executorID = "executor_binding_4"
	path := unbindExecutorDevicePath(executorID)
	body := fmt.Sprintf(`{"deviceId":%q,"expectedRevision":11,"confirmationToken":"confirmation-token-11","force":true}`,
		device.deviceID)
	token := deviceBearerToken(t)
	result := store.DeviceBindingResult{Binding: store.DeviceBindingProjection{
		ExecutorID: executorID, DeviceID: device.deviceID, Status: "revoked", Revision: 12, Force: true,
	}, Replayed: true}
	control := &fakeDeviceBindingControl{forceReplays: []deviceBindingReplay{{result: result, handled: true}}}
	runtime := &fakeDeviceBindingConfirmationRuntime{consumeErr: store.ErrOperationConfirmationTokenConsumed}
	recorder := httptest.NewRecorder()
	deviceBindingHandlerServer(control, runtime, &fakeAuthorizer{}).buildMux().ServeHTTP(
		recorder, unsignedDeviceBindingRequest(t, http.MethodDelete, path, body, token),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	expectedHash := forceDeviceBindingRequestHash(http.MethodDelete, path, []byte(body), sha256Hex([]byte(token)))
	if len(control.verificationIDs) != 0 || runtime.consumeCalls != 1 || control.forceCalls != 1 ||
		!control.unbindInput.Force || control.unbindInput.Proof != (deviceauth.VerifiedRequest{}) ||
		control.unbindInput.KeyGeneration != 0 || control.unbindInput.RequestHash != expectedHash ||
		control.unbindInput.OperationReference != deviceBindingOperationReference("force_unbind", expectedHash) ||
		runtime.consumeInput.ConsumptionReference != control.unbindInput.OperationReference {
		t.Fatalf("unexpected force unbind: input=%#v consume=%#v", control.unbindInput, runtime.consumeInput)
	}

	requestWithProof := unsignedDeviceBindingRequest(t, http.MethodDelete, path, body, token)
	requestWithProof.Header.Set(deviceauth.HeaderDeviceID, device.deviceID)
	recorder = httptest.NewRecorder()
	deviceBindingHandlerServer(&fakeDeviceBindingControl{}, &fakeDeviceBindingConfirmationRuntime{}, &fakeAuthorizer{}).
		buildMux().ServeHTTP(recorder, requestWithProof)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "device proof headers are not accepted") {
		t.Fatalf("force proof rejection status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	missingConfirmation := fmt.Sprintf(`{"deviceId":%q,"expectedRevision":11,"force":true}`, device.deviceID)
	recorder = httptest.NewRecorder()
	deviceBindingHandlerServer(&fakeDeviceBindingControl{}, &fakeDeviceBindingConfirmationRuntime{}, &fakeAuthorizer{}).
		buildMux().ServeHTTP(recorder, unsignedDeviceBindingRequest(t, http.MethodDelete, path, missingConfirmation, token))
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "operation_confirmation_mismatch") {
		t.Fatalf("missing confirmation status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestDeviceBindingExpiredForceConfirmationFailsClosedWithoutAuditReplay(t *testing.T) {
	device := newDeviceBindingFixture(t, 101)
	const executorID = "executor_binding_force_expired"
	path := unbindExecutorDevicePath(executorID)
	body := fmt.Sprintf(`{"deviceId":%q,"expectedRevision":5,"confirmationToken":"expired-confirmation-token","force":true}`,
		device.deviceID)
	for _, expiryErr := range []error{trustedtoken.ErrExpired, store.ErrOperationConfirmationTokenExpired} {
		control := &fakeDeviceBindingControl{forceReplays: []deviceBindingReplay{{
			result: store.DeviceBindingResult{Binding: store.DeviceBindingProjection{Revision: 6}}, handled: true,
		}}}
		runtime := &fakeDeviceBindingConfirmationRuntime{consumeErr: expiryErr}
		recorder := httptest.NewRecorder()
		deviceBindingHandlerServer(control, runtime, &fakeAuthorizer{}).buildMux().ServeHTTP(
			recorder, unsignedDeviceBindingRequest(t, http.MethodDelete, path, body, deviceBearerToken(t)),
		)
		if recorder.Code != http.StatusGone || !strings.Contains(recorder.Body.String(), "operation_confirmation_gone") ||
			runtime.consumeCalls != 1 || control.forceCalls != 0 {
			t.Fatalf("expired force err=%v status=%d consume=%d replay=%d body=%s",
				expiryErr, recorder.Code, runtime.consumeCalls, control.forceCalls, recorder.Body.String())
		}
	}
}

func TestDeviceBindingTransportAndProofFailClosedBeforeMutation(t *testing.T) {
	fixture := newDeviceBindingFixture(t, 121)
	const executorID = "executor_binding_transport"
	path := bindExecutorDevicePath(executorID)
	token := deviceBearerToken(t)
	validBody := fmt.Sprintf(`{"deviceId":%q,"expectedRevision":0}`, fixture.deviceID)
	newServer := func(control *fakeDeviceBindingControl, authorizer accessclient.Authorizer) *Server {
		control.verificationKey = store.DeviceVerificationKey{
			DeviceID: fixture.deviceID, PublicKey: fixture.publicKey, Status: "active", KeyGeneration: 1,
		}
		return deviceBindingHandlerServer(control, &fakeDeviceBindingConfirmationRuntime{}, authorizer)
	}
	tests := []struct {
		name    string
		request func(*testing.T) *http.Request
		status  int
		code    string
	}{
		{
			name: "query",
			request: func(t *testing.T) *http.Request {
				request := signedDeviceBindingRequest(t, fixture, http.MethodPost, path, validBody, token, 1)
				request.URL.RawQuery = "unsafe=1"
				request.RequestURI = path + "?unsafe=1"
				return request
			},
			status: http.StatusBadRequest, code: "validation_error",
		},
		{
			name: "duplicate authorization",
			request: func(t *testing.T) *http.Request {
				request := signedDeviceBindingRequest(t, fixture, http.MethodPost, path, validBody, token, 1)
				request.Header.Add("Authorization", "Bearer "+token)
				return request
			},
			status: http.StatusUnauthorized, code: "unauthorized",
		},
		{
			name: "percent encoded raw path",
			request: func(t *testing.T) *http.Request {
				rawPath := "/api/v1/ai-executors/executor%5Fbinding%5Ftransport/device-bindings"
				return unsignedDeviceBindingRequest(t, http.MethodPost, rawPath, validBody, token)
			},
			status: http.StatusBadRequest, code: "validation_error",
		},
		{
			name: "idempotency header",
			request: func(t *testing.T) *http.Request {
				request := signedDeviceBindingRequest(t, fixture, http.MethodPost, path, validBody, token, 1)
				request.Header.Set("Idempotency-Key", "binding-idempotency-forbidden")
				return request
			},
			status: http.StatusBadRequest, code: "device_header_forbidden",
		},
		{
			name: "unknown JSON",
			request: func(t *testing.T) *http.Request {
				body := fmt.Sprintf(`{"deviceId":%q,"expectedRevision":0,"credential":"secret"}`, fixture.deviceID)
				return signedDeviceBindingRequest(t, fixture, http.MethodPost, path, body, token, 1)
			},
			status: http.StatusBadRequest, code: "validation_error",
		},
		{
			name: "duplicate JSON",
			request: func(t *testing.T) *http.Request {
				body := fmt.Sprintf(`{"deviceId":%q,"deviceId":%q,"expectedRevision":0}`, fixture.deviceID, fixture.deviceID)
				return signedDeviceBindingRequest(t, fixture, http.MethodPost, path, body, token, 1)
			},
			status: http.StatusBadRequest, code: "validation_error",
		},
		{
			name: "missing proof",
			request: func(t *testing.T) *http.Request {
				return unsignedDeviceBindingRequest(t, http.MethodPost, path, validBody, token)
			},
			status: http.StatusForbidden, code: "authorization_proof_invalid",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			control := &fakeDeviceBindingControl{}
			recorder := httptest.NewRecorder()
			newServer(control, &fakeAuthorizer{}).buildMux().ServeHTTP(recorder, test.request(t))
			if recorder.Code != test.status || !strings.Contains(recorder.Body.String(), test.code) {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			if control.bindCalls != 0 {
				t.Fatalf("invalid request reached bind mutation: %#v", control.bindInput)
			}
		})
	}

	control := &fakeDeviceBindingControl{}
	recorder := httptest.NewRecorder()
	newServer(control, &fakeAuthorizer{err: accessclient.ErrDenied}).buildMux().ServeHTTP(
		recorder, signedDeviceBindingRequest(t, fixture, http.MethodPost, path, validBody, token, 1),
	)
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "permission_denied") || control.bindCalls != 0 {
		t.Fatalf("permission denial status=%d body=%s calls=%d", recorder.Code, recorder.Body.String(), control.bindCalls)
	}
}

func TestDeviceBindingMutationErrorsNeverReturnSuccess(t *testing.T) {
	from := newDeviceBindingFixture(t, 13)
	to := newDeviceBindingFixture(t, 23)
	const executorID = "executor_binding_rollback"
	path := rebindExecutorDevicePath(executorID)
	body := fmt.Sprintf(`{"fromDeviceId":%q,"toDeviceId":%q,"expectedRevision":2,"confirmationToken":"confirmation-token-2"}`,
		from.deviceID, to.deviceID)
	token := deviceBearerToken(t)
	for _, test := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"revision rollback", store.ErrRevisionConflict, http.StatusConflict, "revision_conflict"},
		{"altered sequence", store.ErrDeviceProofReplayed, http.StatusConflict, deviceauth.DeviceProofReplayedCode},
	} {
		t.Run(test.name, func(t *testing.T) {
			control := &fakeDeviceBindingControl{
				verificationKey: store.DeviceVerificationKey{
					DeviceID: to.deviceID, PublicKey: to.publicKey, Status: "active", KeyGeneration: 1,
				},
				mutationErr: test.err,
			}
			runtime := &fakeDeviceBindingConfirmationRuntime{}
			recorder := httptest.NewRecorder()
			deviceBindingHandlerServer(control, runtime, &fakeAuthorizer{}).buildMux().ServeHTTP(
				recorder, signedDeviceBindingRequest(t, to, http.MethodPost, path, body, token, 2),
			)
			if recorder.Code != test.status || !strings.Contains(recorder.Body.String(), test.code) ||
				strings.Contains(recorder.Body.String(), `"status":"active"`) {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestDeviceBindingBearerTokenIsValidAndBoundToProof(t *testing.T) {
	fixture := newDeviceBindingFixture(t, 51)
	token, err := auth.SignToken(deviceTestAuthSecret, auth.TokenPayload{
		UserID: "device_owner_1", SessionID: "device_session_1", Exp: time.Now().Add(time.Hour).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	path := bindExecutorDevicePath("executor_binding_bearer")
	body := fmt.Sprintf(`{"deviceId":%q,"expectedRevision":0}`, fixture.deviceID)
	request := signedDeviceBindingRequest(t, fixture, http.MethodPost, path, body, token, 1)
	changedToken, err := auth.SignToken(deviceTestAuthSecret, auth.TokenPayload{
		UserID: "device_owner_1", SessionID: "device_session_1", Exp: time.Now().Add(2 * time.Hour).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+changedToken)
	control := &fakeDeviceBindingControl{verificationKey: store.DeviceVerificationKey{
		DeviceID: fixture.deviceID, PublicKey: fixture.publicKey, Status: "active", KeyGeneration: 1,
	}}
	recorder := httptest.NewRecorder()
	deviceBindingHandlerServer(control, &fakeDeviceBindingConfirmationRuntime{}, &fakeAuthorizer{}).
		buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "authorization_proof_invalid") || control.bindCalls != 0 {
		t.Fatalf("changed bearer status=%d body=%s calls=%d", recorder.Code, recorder.Body.String(), control.bindCalls)
	}
}
