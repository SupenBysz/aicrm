package server

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/accessclient"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/operationconfirmation"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
	"github.com/Kysion/KyaiCRM/shared/auth"
)

const (
	deviceBindingRequestLimit     = 24 << 10
	permissionDeviceBind          = "platform.ai_executors.bind_device"
	permissionDeviceRebind        = "platform.ai_executors.rebind_device"
	deviceBindingOperationPrefix  = "device_binding_"
	forceBindingRequestHashDomain = "AICRM-DEVICE-BINDING-FORCE-V1"
)

type deviceBindingControlStore interface {
	GetDeviceVerificationKey(context.Context, string) (store.DeviceVerificationKey, error)
	BindDevice(context.Context, store.BindDeviceInput) (store.DeviceBindingResult, error)
	ReplayRebindDevice(context.Context, store.RebindDeviceInput) (store.DeviceBindingResult, bool, error)
	ReplayUnbindDevice(context.Context, store.UnbindDeviceInput) (store.DeviceBindingResult, bool, error)
	ReplayForceUnbindDevice(context.Context, store.UnbindDeviceInput) (store.DeviceBindingResult, bool, error)
	RebindDeviceMutation(store.RebindDeviceInput, *store.DeviceBindingResult) store.OperationConfirmationMutation
	UnbindDeviceMutation(store.UnbindDeviceInput, *store.DeviceBindingResult) store.OperationConfirmationMutation
}

type deviceBindingConfirmationRuntime interface {
	Consume(context.Context, operationconfirmation.ConsumeInput, store.OperationConfirmationMutation) (store.OperationConfirmationProjection, error)
}

type deviceBindingActor struct {
	ActorID         string
	SessionID       string
	TokenExpiresAt  time.Time
	BearerTokenHash string
}

type deviceBindingHandler func(http.ResponseWriter, *http.Request, deviceBindingActor)

type bindDeviceBody struct {
	DeviceID         string `json:"deviceId"`
	ExpectedRevision *int64 `json:"expectedRevision"`
}

type rebindDeviceBody struct {
	FromDeviceID      string  `json:"fromDeviceId"`
	ToDeviceID        string  `json:"toDeviceId"`
	ExpectedRevision  *int64  `json:"expectedRevision"`
	ConfirmationToken *string `json:"confirmationToken"`
}

type unbindDeviceBody struct {
	DeviceID          string  `json:"deviceId"`
	ExpectedRevision  *int64  `json:"expectedRevision"`
	ConfirmationToken *string `json:"confirmationToken"`
	Force             *bool   `json:"force"`
}

func (s *Server) registerDeviceBindingRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/ai-executors/{executorId}/device-bindings",
		s.deviceBinding(permissionDeviceBind, s.bindExecutorDevice))
	mux.HandleFunc("POST /api/v1/ai-executors/{executorId}/device-binding/rebind",
		s.deviceBinding(permissionDeviceRebind, s.rebindExecutorDevice))
	mux.HandleFunc("DELETE /api/v1/ai-executors/{executorId}/device-binding",
		s.deviceBinding(permissionDeviceRebind, s.unbindExecutorDevice))
}

func (s *Server) bindExecutorDevice(w http.ResponseWriter, r *http.Request, actor deviceBindingActor) {
	bindingStore, ok := s.control.(deviceBindingControlStore)
	if !ok {
		writeError(w, r, http.StatusServiceUnavailable, "device_binding_unavailable", "device binding is unavailable")
		return
	}
	executorID := r.PathValue("executorId")
	expectedPath := bindExecutorDevicePath(executorID)
	if !validOpaqueID(executorID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "executorId is invalid")
		return
	}
	if !requireRawDevicePath(w, r, expectedPath) || !rejectDeviceBindingIdempotencyHeader(w, r) {
		return
	}
	var body bindDeviceBody
	raw, ok := decodeDeviceJSON(w, r, deviceBindingRequestLimit, &body)
	if !ok {
		return
	}
	if body.ExpectedRevision == nil || *body.ExpectedRevision < 0 || *body.ExpectedRevision >= math.MaxInt64 ||
		deviceauth.ValidateDeviceID(body.DeviceID) != nil {
		writeError(w, r, http.StatusBadRequest, "validation_error", "device binding input is invalid")
		return
	}
	proof, keyGeneration, ok := s.verifyDeviceBindingProof(w, r, bindingStore, body.DeviceID, raw)
	if !ok {
		return
	}
	result, err := bindingStore.BindDevice(r.Context(), store.BindDeviceInput{
		ExecutorID: executorID, ActorID: actor.ActorID, ActorSessionID: actor.SessionID,
		WorkspaceType: "platform", WorkspaceID: "platform_root", TargetDeviceID: body.DeviceID,
		ExpectedRevision:   *body.ExpectedRevision,
		OperationReference: deviceBindingOperationReference("bind", proof.RequestHash),
		KeyGeneration:      keyGeneration, Proof: proof,
		LedgerExpiresAt: ledgerExpiry(time.Now().UTC(), actor.TokenExpiresAt),
	})
	if err != nil {
		s.writeDeviceBindingError(w, r, err)
		return
	}
	writeDeviceBindingResult(w, r, http.StatusCreated, result)
}

func (s *Server) rebindExecutorDevice(w http.ResponseWriter, r *http.Request, actor deviceBindingActor) {
	bindingStore, confirmationRuntime, ok := s.deviceBindingRuntimes(w, r)
	if !ok {
		return
	}
	executorID := r.PathValue("executorId")
	expectedPath := rebindExecutorDevicePath(executorID)
	if !validOpaqueID(executorID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "executorId is invalid")
		return
	}
	if !requireRawDevicePath(w, r, expectedPath) || !rejectDeviceBindingIdempotencyHeader(w, r) {
		return
	}
	var body rebindDeviceBody
	raw, ok := decodeDeviceJSON(w, r, deviceBindingRequestLimit, &body)
	if !ok {
		return
	}
	if body.ExpectedRevision == nil || *body.ExpectedRevision <= 0 || *body.ExpectedRevision >= math.MaxInt64 ||
		deviceauth.ValidateDeviceID(body.FromDeviceID) != nil || deviceauth.ValidateDeviceID(body.ToDeviceID) != nil ||
		body.FromDeviceID == body.ToDeviceID {
		writeError(w, r, http.StatusBadRequest, "validation_error", "device rebind input is invalid")
		return
	}
	if body.ConfirmationToken == nil || !validConfirmationToken(*body.ConfirmationToken) {
		writeError(w, r, http.StatusForbidden, "operation_confirmation_mismatch", "operation confirmation does not match")
		return
	}
	proof, keyGeneration, ok := s.verifyDeviceBindingProof(w, r, bindingStore, body.ToDeviceID, raw)
	if !ok {
		return
	}
	input := store.RebindDeviceInput{
		ExecutorID: executorID, ActorID: actor.ActorID, ActorSessionID: actor.SessionID,
		WorkspaceType: "platform", WorkspaceID: "platform_root", FromDeviceID: body.FromDeviceID,
		TargetDeviceID: body.ToDeviceID, ExpectedRevision: *body.ExpectedRevision,
		OperationReference: deviceBindingOperationReference("rebind", proof.RequestHash),
		KeyGeneration:      keyGeneration, Proof: proof,
		LedgerExpiresAt: ledgerExpiry(time.Now().UTC(), actor.TokenExpiresAt),
	}
	if result, handled, err := bindingStore.ReplayRebindDevice(r.Context(), input); handled || err != nil {
		s.finishDeviceBindingReplay(w, r, result, handled, err)
		return
	}
	var result store.DeviceBindingResult
	_, err := confirmationRuntime.Consume(r.Context(), operationconfirmation.ConsumeInput{
		ConfirmationToken: *body.ConfirmationToken, Action: store.OperationConfirmationRebindDevice,
		ActorID: actor.ActorID, ActorSessionID: actor.SessionID, ExecutorID: executorID,
		ExpectedRevision: *body.ExpectedRevision, FromDeviceID: body.FromDeviceID,
		TargetDeviceID: body.ToDeviceID, ConsumptionReference: input.OperationReference,
	}, bindingStore.RebindDeviceMutation(input, &result))
	if errors.Is(err, store.ErrOperationConfirmationTokenConsumed) {
		var handled bool
		result, handled, err = bindingStore.ReplayRebindDevice(r.Context(), input)
		if err == nil && !handled {
			err = store.ErrOperationConfirmationTokenConsumed
		}
	}
	if err != nil {
		s.writeDeviceBindingError(w, r, err)
		return
	}
	writeDeviceBindingResult(w, r, http.StatusOK, result)
}

func (s *Server) unbindExecutorDevice(w http.ResponseWriter, r *http.Request, actor deviceBindingActor) {
	bindingStore, confirmationRuntime, ok := s.deviceBindingRuntimes(w, r)
	if !ok {
		return
	}
	executorID := r.PathValue("executorId")
	expectedPath := unbindExecutorDevicePath(executorID)
	if !validOpaqueID(executorID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "executorId is invalid")
		return
	}
	if !requireRawDevicePath(w, r, expectedPath) || !rejectDeviceBindingIdempotencyHeader(w, r) {
		return
	}
	var body unbindDeviceBody
	raw, ok := decodeDeviceJSON(w, r, deviceBindingRequestLimit, &body)
	if !ok {
		return
	}
	if body.ExpectedRevision == nil || *body.ExpectedRevision <= 0 || *body.ExpectedRevision >= math.MaxInt64 ||
		body.Force == nil || deviceauth.ValidateDeviceID(body.DeviceID) != nil {
		writeError(w, r, http.StatusBadRequest, "validation_error", "device unbind input is invalid")
		return
	}
	if body.ConfirmationToken == nil || !validConfirmationToken(*body.ConfirmationToken) {
		writeError(w, r, http.StatusForbidden, "operation_confirmation_mismatch", "operation confirmation does not match")
		return
	}
	input := store.UnbindDeviceInput{
		ExecutorID: executorID, ActorID: actor.ActorID, ActorSessionID: actor.SessionID,
		WorkspaceType: "platform", WorkspaceID: "platform_root", DeviceID: body.DeviceID,
		ExpectedRevision: *body.ExpectedRevision, Force: *body.Force,
	}
	if input.Force {
		if !rejectDeviceProofHeaders(w, r) {
			return
		}
		input.RequestHash = forceDeviceBindingRequestHash(r.Method, expectedPath, raw, actor.BearerTokenHash)
		input.OperationReference = deviceBindingOperationReference("force_unbind", input.RequestHash)
	} else {
		proof, keyGeneration, verified := s.verifyDeviceBindingProof(w, r, bindingStore, body.DeviceID, raw)
		if !verified {
			return
		}
		input.KeyGeneration = keyGeneration
		input.Proof = proof
		input.OperationReference = deviceBindingOperationReference("unbind", proof.RequestHash)
		input.LedgerExpiresAt = ledgerExpiry(time.Now().UTC(), actor.TokenExpiresAt)
		if result, handled, err := bindingStore.ReplayUnbindDevice(r.Context(), input); handled || err != nil {
			s.finishDeviceBindingReplay(w, r, result, handled, err)
			return
		}
	}
	var result store.DeviceBindingResult
	_, err := confirmationRuntime.Consume(r.Context(), operationconfirmation.ConsumeInput{
		ConfirmationToken: *body.ConfirmationToken, Action: store.OperationConfirmationUnbindDevice,
		ActorID: actor.ActorID, ActorSessionID: actor.SessionID, ExecutorID: executorID,
		ExpectedRevision: *body.ExpectedRevision, FromDeviceID: body.DeviceID,
		ConsumptionReference: input.OperationReference,
	}, bindingStore.UnbindDeviceMutation(input, &result))
	if errors.Is(err, store.ErrOperationConfirmationTokenConsumed) {
		// Force requests have no device ledger. They are replayable only after
		// Consume has cryptographically verified a still-valid token and the
		// store reports that exact token as consumed. An expired token therefore
		// fails closed instead of reaching the force audit replay path.
		var handled bool
		if input.Force {
			result, handled, err = bindingStore.ReplayForceUnbindDevice(r.Context(), input)
		} else {
			result, handled, err = bindingStore.ReplayUnbindDevice(r.Context(), input)
		}
		if err == nil && !handled {
			err = store.ErrOperationConfirmationTokenConsumed
		}
	}
	if err != nil {
		s.writeDeviceBindingError(w, r, err)
		return
	}
	writeDeviceBindingResult(w, r, http.StatusOK, result)
}

func (s *Server) deviceBinding(permission string, next deviceBindingHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		noStore(w)
		ensureRequestID(r)
		if !s.cfg.WriteEnabled || s.control == nil || s.authorizer == nil {
			writeError(w, r, http.StatusServiceUnavailable, "device_binding_unavailable", "device binding is unavailable")
			return
		}
		if s.cfg.AuthTokenSecret == "" {
			writeError(w, r, http.StatusServiceUnavailable, "authentication_unavailable", "authentication is unavailable")
			return
		}
		if r.URL.RawQuery != "" {
			writeError(w, r, http.StatusBadRequest, "validation_error", "device binding path is invalid")
			return
		}
		workspaceType, workspaceTypeOK := strictSingleHeader(r.Header, "X-KY-Workspace-Type")
		workspaceID, workspaceIDOK := strictSingleHeader(r.Header, "X-KY-Workspace-Id")
		if !workspaceTypeOK || !workspaceIDOK || workspaceType != "platform" || workspaceID != "platform_root" {
			writeError(w, r, http.StatusForbidden, "workspace_forbidden", "platform workspace is required")
			return
		}
		authorization, ok := strictSingleHeader(r.Header, "Authorization")
		if !ok || !strings.HasPrefix(authorization, "Bearer ") {
			writeError(w, r, http.StatusUnauthorized, "unauthorized", "authentication is required")
			return
		}
		token := strings.TrimPrefix(authorization, "Bearer ")
		if token == "" || strings.ContainsAny(token, " \t\r\n") {
			writeError(w, r, http.StatusUnauthorized, "unauthorized", "authentication is invalid")
			return
		}
		payload, err := auth.VerifyToken(s.cfg.AuthTokenSecret, token)
		if err != nil || !validOpaqueID(payload.UserID) || !validOpaqueID(payload.SessionID) {
			writeError(w, r, http.StatusUnauthorized, "unauthorized", "authentication is invalid")
			return
		}
		decision, err := s.authorizer.Evaluate(r.Context(), requestID(r), accessclient.Request{
			ActorID: payload.UserID, SessionID: payload.SessionID,
			WorkspaceType: "platform", WorkspaceID: "platform_root",
			RequiredAllPermissions: []string{permission},
		})
		if errors.Is(err, accessclient.ErrDenied) {
			writeError(w, r, http.StatusForbidden, "permission_denied", "permission is denied")
			return
		}
		if err != nil {
			writeError(w, r, http.StatusServiceUnavailable, "authorization_unavailable", "authorization decision is unavailable")
			return
		}
		if !decision.Allowed || decision.ActorID != payload.UserID || decision.WorkspaceType != "platform" ||
			decision.WorkspaceID != "platform_root" || !containsExact(decision.GrantedRequiredPermissions, permission) {
			writeError(w, r, http.StatusForbidden, "permission_denied", "permission is denied")
			return
		}
		next(w, r, deviceBindingActor{
			ActorID: payload.UserID, SessionID: payload.SessionID,
			TokenExpiresAt: time.Unix(payload.Exp, 0).UTC(), BearerTokenHash: sha256Hex([]byte(token)),
		})
	}
}

func (s *Server) deviceBindingRuntimes(
	w http.ResponseWriter,
	r *http.Request,
) (deviceBindingControlStore, deviceBindingConfirmationRuntime, bool) {
	bindingStore, storeOK := s.control.(deviceBindingControlStore)
	confirmationRuntime, confirmationOK := s.confirmationRuntime.(deviceBindingConfirmationRuntime)
	if !storeOK || !confirmationOK {
		writeError(w, r, http.StatusServiceUnavailable, "device_binding_unavailable", "device binding is unavailable")
		return nil, nil, false
	}
	return bindingStore, confirmationRuntime, true
}

func (s *Server) verifyDeviceBindingProof(
	w http.ResponseWriter,
	r *http.Request,
	bindingStore deviceBindingControlStore,
	targetDeviceID string,
	raw []byte,
) (deviceauth.VerifiedRequest, uint64, bool) {
	parsed, err := deviceauth.ParseProofHeaders(r.Header)
	if err != nil || parsed.DeviceID != targetDeviceID {
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "device proof is invalid")
		return deviceauth.VerifiedRequest{}, 0, false
	}
	key, err := bindingStore.GetDeviceVerificationKey(r.Context(), targetDeviceID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrDeviceInactive) || errors.Is(err, store.ErrDeviceKeyGenerationMismatch) {
			writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "device proof is invalid")
		} else {
			writeError(w, r, http.StatusInternalServerError, "device_binding_failed", "device verification is unavailable")
		}
		return deviceauth.VerifiedRequest{}, 0, false
	}
	if key.DeviceID != targetDeviceID || key.KeyGeneration == 0 {
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "device proof is invalid")
		return deviceauth.VerifiedRequest{}, 0, false
	}
	proof, err := deviceauth.VerifyRequestForPersistentLedger(deviceauth.VerifyInput{
		PublicKey: key.PublicKey, Method: r.Method, RequestTarget: r.RequestURI,
		Headers: r.Header, Body: raw, AllowedAuthorizationSchemes: []string{"Bearer"},
	})
	if err != nil || proof.DeviceID != targetDeviceID || proof.AuthorizationTokenHash == "" {
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "device proof is invalid")
		return deviceauth.VerifiedRequest{}, 0, false
	}
	return proof, key.KeyGeneration, true
}

func (s *Server) finishDeviceBindingReplay(
	w http.ResponseWriter,
	r *http.Request,
	result store.DeviceBindingResult,
	handled bool,
	err error,
) {
	if err != nil {
		s.writeDeviceBindingError(w, r, err)
		return
	}
	if !handled {
		s.writeDeviceBindingError(w, r, store.ErrDeviceBindingReplayMismatch)
		return
	}
	writeDeviceBindingResult(w, r, http.StatusOK, result)
}

func (s *Server) writeDeviceBindingError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, trustedtoken.ErrExpired), errors.Is(err, store.ErrOperationConfirmationTokenExpired):
		writeError(w, r, http.StatusGone, "operation_confirmation_gone", "operation confirmation is unavailable")
	case errors.Is(err, store.ErrDeviceProofReplayed):
		writeError(w, r, http.StatusConflict, deviceauth.DeviceProofReplayedCode, "device proof was replayed")
	case errors.Is(err, store.ErrRevisionConflict):
		writeError(w, r, http.StatusConflict, "revision_conflict", "device binding revision changed")
	case errors.Is(err, store.ErrDeviceBindingAlreadyActive):
		writeError(w, r, http.StatusConflict, "device_binding_active", "device binding is already active")
	case errors.Is(err, store.ErrDeviceBindingNotActive), errors.Is(err, store.ErrConflict):
		writeError(w, r, http.StatusConflict, "device_binding_conflict", "device binding conflicts with current state")
	case errors.Is(err, store.ErrDeviceBindingReplayMismatch):
		writeError(w, r, http.StatusConflict, "device_binding_replay_mismatch", "device binding replay does not match")
	case errors.Is(err, store.ErrOperationConfirmationTokenMismatch),
		errors.Is(err, store.ErrDeviceBindingConfirmationMismatch),
		errors.Is(err, operationconfirmation.ErrInvalidInput), isTrustedTokenVerificationError(err):
		writeError(w, r, http.StatusForbidden, "operation_confirmation_mismatch", "operation confirmation does not match")
	case errors.Is(err, store.ErrOperationConfirmationTokenConsumed):
		writeError(w, r, http.StatusConflict, "operation_confirmation_conflict", "operation confirmation is already used")
	case errors.Is(err, store.ErrDeviceBindingTargetMismatch), errors.Is(err, store.ErrDeviceMismatch),
		errors.Is(err, store.ErrDeviceInactive), errors.Is(err, store.ErrDeviceKeyGenerationMismatch),
		errors.Is(err, deviceauth.ErrTimestampOutsideWindow), errors.Is(err, store.ErrNotFound):
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "device proof is invalid")
	case errors.Is(err, store.ErrExecutorRuntimeUnsupported):
		writeError(w, r, http.StatusUnprocessableEntity, "executor_runtime_unsupported", "executor runtime is unsupported")
	case errors.Is(err, store.ErrExecutorDisabled):
		writeError(w, r, http.StatusConflict, "executor_disabled", "executor is disabled")
	case errors.Is(err, store.ErrDeviceBindingInputInvalid), errors.Is(err, store.ErrDeviceLedgerRetentionInvalid):
		writeError(w, r, http.StatusBadRequest, "validation_error", "device binding input is invalid")
	default:
		writeError(w, r, http.StatusInternalServerError, "device_binding_failed", "device binding operation failed")
	}
}

func writeDeviceBindingResult(w http.ResponseWriter, r *http.Request, status int, result store.DeviceBindingResult) {
	writeData(w, r, status, map[string]any{
		"binding":  result.Binding,
		"replayed": result.Replayed,
	})
}

func rejectDeviceBindingIdempotencyHeader(w http.ResponseWriter, r *http.Request) bool {
	if len(r.Header.Values("Idempotency-Key")) != 0 {
		writeError(w, r, http.StatusBadRequest, "device_header_forbidden", "Idempotency-Key is not accepted for device binding")
		return false
	}
	return true
}

func validConfirmationToken(value string) bool {
	return value != "" && len(value) <= 16<<10 && strings.TrimSpace(value) == value && !strings.ContainsAny(value, " \t\r\n")
}

func deviceBindingOperationReference(action, requestHash string) string {
	return deviceBindingOperationPrefix + action + "_" + requestHash
}

func forceDeviceBindingRequestHash(method, path string, raw []byte, bearerTokenHash string) string {
	return sha256Hex([]byte(strings.Join([]string{
		forceBindingRequestHashDomain,
		method,
		path,
		sha256Hex(raw),
		bearerTokenHash,
	}, "\n")))
}

func bindExecutorDevicePath(executorID string) string {
	return "/api/v1/ai-executors/" + executorID + "/device-bindings"
}

func rebindExecutorDevicePath(executorID string) string {
	return "/api/v1/ai-executors/" + executorID + "/device-binding/rebind"
}

func unbindExecutorDevicePath(executorID string) string {
	return "/api/v1/ai-executors/" + executorID + "/device-binding"
}

func isTrustedTokenVerificationError(err error) bool {
	for _, candidate := range []error{
		trustedtoken.ErrInvalidKey, trustedtoken.ErrInvalidClaims, trustedtoken.ErrMalformed,
		trustedtoken.ErrUnknownKey, trustedtoken.ErrInvalidSignature, trustedtoken.ErrAudienceMismatch,
		trustedtoken.ErrPurposeMismatch, trustedtoken.ErrNotYetValid, trustedtoken.ErrExpired,
	} {
		if errors.Is(err, candidate) {
			return true
		}
	}
	return false
}
