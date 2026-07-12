package server

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/desktopactivation"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
)

const (
	desktopActivationRequestLimit    = 24 << 10
	desktopActivationUnavailableCode = "desktop_activation_unavailable"
	desktopActivationUnavailableText = "Desktop credential activation is unavailable"
)

var desktopActivationDigestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type desktopActivationRuntime interface {
	SubmitProof(context.Context, desktopactivation.SubmitProofInput) (desktopactivation.SubmitProofResult, error)
	Acknowledge(context.Context, desktopactivation.AcknowledgeInput) (desktopactivation.AcknowledgeResult, error)
}

type desktopActivationDeviceStore interface {
	GetDeviceVerificationKey(context.Context, string) (store.DeviceVerificationKey, error)
}

type desktopProofRawBody struct {
	HandoffID              json.RawMessage `json:"handoffId"`
	SessionRevision        json.RawMessage `json:"sessionRevision"`
	LoginIDHash            json.RawMessage `json:"loginIdHash"`
	Result                 json.RawMessage `json:"result"`
	CheckedAt              json.RawMessage `json:"checkedAt"`
	AccountFingerprint     json.RawMessage `json:"accountFingerprint"`
	CandidateBindingDigest json.RawMessage `json:"candidateBindingDigest"`
}

type desktopActivationACKRawBody struct {
	OperationID               json.RawMessage `json:"operationId"`
	ActivationID              json.RawMessage `json:"activationId"`
	CredentialRevision        json.RawMessage `json:"credentialRevision"`
	LeaseEpoch                json.RawMessage `json:"leaseEpoch"`
	SourceCredentialRevision  json.RawMessage `json:"sourceCredentialRevision"`
	RevocationEpoch           json.RawMessage `json:"revocationEpoch"`
	DurableBarrierCompletedAt json.RawMessage `json:"durableBarrierCompletedAt"`
	BindingDigest             json.RawMessage `json:"bindingDigest"`
}

func (s *Server) registerDesktopActivationRoutes(mux *http.ServeMux) {
	mux.HandleFunc(
		"POST /api/v1/ai-executor-authorization-sessions/{sessionId}/desktop-proofs",
		s.submitDesktopAuthorizationProof,
	)
	mux.HandleFunc(
		"POST /api/v1/ai-executor-authorization-sessions/{sessionId}/desktop-activations/{activationId}/ack",
		s.acknowledgeDesktopCredentialActivation,
	)
}

func (s *Server) submitDesktopAuthorizationProof(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	w.Header().Set("Referrer-Policy", "no-referrer")
	ensureRequestID(r)
	if !s.desktopActivationReady() {
		writeError(w, r, http.StatusServiceUnavailable, desktopActivationUnavailableCode, desktopActivationUnavailableText)
		return
	}
	sessionID := r.PathValue("sessionId")
	expectedPath := desktopProofPath(sessionID)
	if !validOpaqueID(sessionID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "Desktop authorization proof path is invalid")
		return
	}
	if !requireRawDevicePath(w, r, expectedPath) || !rejectDesktopActivationOverrides(w, r) {
		return
	}
	authorization, ok := strictSingleHeader(r.Header, "Authorization")
	if !ok || !validDesktopActivationAuthorization(authorization, "AiCRM-Claim") {
		writeError(w, r, http.StatusUnauthorized, "desktop_proof_unauthorized", "Desktop authorization claim authentication is required")
		return
	}
	var rawBody desktopProofRawBody
	raw, ok := decodeDeviceJSON(w, r, desktopActivationRequestLimit, &rawBody)
	if !ok {
		return
	}
	input, ok := parseDesktopProofBody(rawBody, sessionID)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "Desktop authorization proof input is invalid")
		return
	}
	key, proof, ok := s.verifyDesktopActivationDeviceRequest(w, r, raw, "AiCRM-Claim")
	if !ok {
		return
	}
	input.ClaimToken = strings.TrimPrefix(authorization, "AiCRM-Claim ")
	input.TargetDeviceID = proof.DeviceID
	input.KeyGeneration = key.KeyGeneration
	input.Proof = proof
	input.LedgerExpiresAt = time.Now().UTC().Add(store.DeviceLedgerAuditRetention + deviceLedgerExpiryMargin)
	result, err := s.activationRuntime.SubmitProof(r.Context(), input)
	if err != nil {
		s.writeDesktopActivationError(w, r, err, false)
		return
	}
	writeDesktopProofResult(w, r, result)
}

func (s *Server) acknowledgeDesktopCredentialActivation(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	w.Header().Set("Referrer-Policy", "no-referrer")
	ensureRequestID(r)
	if !s.desktopActivationReady() {
		writeError(w, r, http.StatusServiceUnavailable, desktopActivationUnavailableCode, desktopActivationUnavailableText)
		return
	}
	sessionID, activationID := r.PathValue("sessionId"), r.PathValue("activationId")
	expectedPath := desktopActivationACKPath(sessionID, activationID)
	if !validOpaqueID(sessionID) || !validOpaqueID(activationID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "Desktop credential activation path is invalid")
		return
	}
	if !requireRawDevicePath(w, r, expectedPath) || !rejectDesktopActivationOverrides(w, r) {
		return
	}
	authorization, ok := strictSingleHeader(r.Header, "Authorization")
	if !ok || !validDesktopActivationAuthorization(authorization, "AiCRM-Activation") {
		writeError(w, r, http.StatusUnauthorized, "desktop_activation_unauthorized", "Desktop credential activation authentication is required")
		return
	}
	var rawBody desktopActivationACKRawBody
	raw, ok := decodeDeviceJSON(w, r, desktopActivationRequestLimit, &rawBody)
	if !ok {
		return
	}
	input, ok := parseDesktopActivationACKBody(rawBody, sessionID, activationID)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "Desktop credential activation acknowledgement input is invalid")
		return
	}
	key, proof, ok := s.verifyDesktopActivationDeviceRequest(w, r, raw, "AiCRM-Activation")
	if !ok {
		return
	}
	input.ActivationToken = strings.TrimPrefix(authorization, "AiCRM-Activation ")
	input.TargetDeviceID = proof.DeviceID
	input.KeyGeneration = key.KeyGeneration
	input.Proof = proof
	input.LedgerExpiresAt = time.Now().UTC().Add(store.DeviceLedgerAuditRetention + deviceLedgerExpiryMargin)
	result, err := s.activationRuntime.Acknowledge(r.Context(), input)
	if err != nil {
		s.writeDesktopActivationError(w, r, err, true)
		return
	}
	writeData(w, r, http.StatusOK, map[string]any{
		"activationId": result.ActivationID, "executorId": result.ExecutorID,
		"credentialRevision": result.CredentialRevision,
		"sessionRevision":    result.SessionRevision,
		"replayed":           result.Replayed,
	})
}

func (s *Server) desktopActivationReady() bool {
	return s.cfg.WriteEnabled && s.control != nil && s.activationRuntime != nil
}

func (s *Server) verifyDesktopActivationDeviceRequest(
	w http.ResponseWriter,
	r *http.Request,
	raw []byte,
	authorizationScheme string,
) (store.DeviceVerificationKey, deviceauth.VerifiedRequest, bool) {
	deviceStore, ok := s.control.(desktopActivationDeviceStore)
	if !ok {
		writeError(w, r, http.StatusServiceUnavailable, desktopActivationUnavailableCode, desktopActivationUnavailableText)
		return store.DeviceVerificationKey{}, deviceauth.VerifiedRequest{}, false
	}
	parsed, err := deviceauth.ParseProofHeaders(r.Header)
	if err != nil {
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "device proof is invalid")
		return store.DeviceVerificationKey{}, deviceauth.VerifiedRequest{}, false
	}
	key, err := deviceStore.GetDeviceVerificationKey(r.Context(), parsed.DeviceID)
	if err != nil || key.DeviceID != parsed.DeviceID || key.KeyGeneration == 0 {
		if err != nil && !errors.Is(err, store.ErrNotFound) && !errors.Is(err, store.ErrDeviceInactive) &&
			!errors.Is(err, store.ErrDeviceKeyGenerationMismatch) {
			writeError(w, r, http.StatusInternalServerError, "desktop_activation_failed", "device verification is unavailable")
			return store.DeviceVerificationKey{}, deviceauth.VerifiedRequest{}, false
		}
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "device proof is invalid")
		return store.DeviceVerificationKey{}, deviceauth.VerifiedRequest{}, false
	}
	proof, err := deviceauth.VerifyRequestForPersistentLedger(deviceauth.VerifyInput{
		PublicKey: key.PublicKey, Method: r.Method, RequestTarget: r.RequestURI,
		Headers: r.Header, Body: raw, AllowedAuthorizationSchemes: []string{authorizationScheme},
	})
	if err != nil || proof.DeviceID != key.DeviceID || proof.AuthorizationTokenHash == "" {
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "device proof is invalid")
		return store.DeviceVerificationKey{}, deviceauth.VerifiedRequest{}, false
	}
	return key, proof, true
}

func parseDesktopProofBody(raw desktopProofRawBody, sessionID string) (desktopactivation.SubmitProofInput, bool) {
	var handoffID, loginIDHash, result, checkedAtText, accountFingerprint, candidateBindingDigest string
	var sessionRevision int64
	if !decodeRequiredDesktopActivationJSON(raw.HandoffID, &handoffID) || !validOpaqueID(handoffID) ||
		!decodeRequiredDesktopActivationJSON(raw.SessionRevision, &sessionRevision) || sessionRevision <= 0 || sessionRevision >= math.MaxInt64 ||
		!decodeRequiredDesktopActivationJSON(raw.LoginIDHash, &loginIDHash) || !desktopActivationDigestPattern.MatchString(loginIDHash) ||
		!decodeRequiredDesktopActivationJSON(raw.Result, &result) ||
		!decodeRequiredDesktopActivationJSON(raw.CheckedAt, &checkedAtText) ||
		!decodeRequiredDesktopActivationJSON(raw.AccountFingerprint, &accountFingerprint) ||
		!decodeRequiredDesktopActivationJSON(raw.CandidateBindingDigest, &candidateBindingDigest) {
		return desktopactivation.SubmitProofInput{}, false
	}
	checkedAt, ok := parseCanonicalDesktopActivationTime(checkedAtText)
	if !ok {
		return desktopactivation.SubmitProofInput{}, false
	}
	switch result {
	case "succeeded":
		if !desktopActivationDigestPattern.MatchString(accountFingerprint) ||
			!desktopActivationDigestPattern.MatchString(candidateBindingDigest) {
			return desktopactivation.SubmitProofInput{}, false
		}
	case "failed", "cancelled":
		if accountFingerprint != "" || candidateBindingDigest != "" {
			return desktopactivation.SubmitProofInput{}, false
		}
	default:
		return desktopactivation.SubmitProofInput{}, false
	}
	return desktopactivation.SubmitProofInput{
		SessionID: sessionID, HandoffID: handoffID, SessionRevision: sessionRevision,
		LoginIDHash: loginIDHash, Result: result, CheckedAt: checkedAt,
		AccountFingerprint: accountFingerprint, CandidateBindingDigest: candidateBindingDigest,
	}, true
}

func parseDesktopActivationACKBody(
	raw desktopActivationACKRawBody,
	sessionID string,
	activationID string,
) (desktopactivation.AcknowledgeInput, bool) {
	var operationID, bodyActivationID, barrierText, bindingDigest string
	var credentialRevision, leaseEpoch, sourceRevision, revocationEpoch int64
	if !decodeRequiredDesktopActivationJSON(raw.OperationID, &operationID) || !validOpaqueID(operationID) ||
		!decodeRequiredDesktopActivationJSON(raw.ActivationID, &bodyActivationID) || bodyActivationID != activationID ||
		!decodeRequiredDesktopActivationJSON(raw.CredentialRevision, &credentialRevision) || credentialRevision <= 0 || credentialRevision >= math.MaxInt64 ||
		!decodeRequiredDesktopActivationJSON(raw.LeaseEpoch, &leaseEpoch) || leaseEpoch <= 0 || leaseEpoch >= math.MaxInt64 ||
		!decodeRequiredDesktopActivationJSON(raw.SourceCredentialRevision, &sourceRevision) || sourceRevision < 0 || sourceRevision >= math.MaxInt64 ||
		!decodeRequiredDesktopActivationJSON(raw.RevocationEpoch, &revocationEpoch) || revocationEpoch < 0 || revocationEpoch >= math.MaxInt64 ||
		!decodeRequiredDesktopActivationJSON(raw.DurableBarrierCompletedAt, &barrierText) ||
		!decodeRequiredDesktopActivationJSON(raw.BindingDigest, &bindingDigest) || !desktopActivationDigestPattern.MatchString(bindingDigest) {
		return desktopactivation.AcknowledgeInput{}, false
	}
	barrierAt, ok := parseCanonicalDesktopActivationTime(barrierText)
	if !ok {
		return desktopactivation.AcknowledgeInput{}, false
	}
	return desktopactivation.AcknowledgeInput{
		SessionID: sessionID, ActivationID: activationID, OperationID: operationID,
		CredentialRevision: credentialRevision, LeaseEpoch: leaseEpoch,
		SourceCredentialRevision: sourceRevision, RevocationEpoch: revocationEpoch,
		DurableBarrierCompletedAt: barrierAt, BindingDigest: bindingDigest,
	}, true
}

func decodeRequiredDesktopActivationJSON(raw json.RawMessage, target any) bool {
	return len(raw) != 0 && string(raw) != "null" && json.Unmarshal(raw, target) == nil
}

func parseCanonicalDesktopActivationTime(value string) (time.Time, bool) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	return parsed.UTC(), err == nil && !parsed.IsZero() && value == parsed.Format(time.RFC3339Nano)
}

func rejectDesktopActivationOverrides(w http.ResponseWriter, r *http.Request) bool {
	for _, name := range []string{"X-KY-Workspace-Type", "X-KY-Workspace-Id", "Idempotency-Key"} {
		if len(r.Header.Values(name)) != 0 {
			writeError(w, r, http.StatusBadRequest, "device_header_forbidden", "workspace and idempotency headers are forbidden")
			return false
		}
	}
	return true
}

func validDesktopActivationAuthorization(value, scheme string) bool {
	prefix := scheme + " "
	if !strings.HasPrefix(value, prefix) {
		return false
	}
	token := strings.TrimPrefix(value, prefix)
	if token == "" || len(token) > 16<<10 || strings.TrimSpace(token) != token || strings.ContainsAny(token, " \t\r\n") {
		return false
	}
	for index := 0; index < len(token); index++ {
		if token[index] < 0x21 || token[index] > 0x7e {
			return false
		}
	}
	return true
}

func writeDesktopProofResult(w http.ResponseWriter, r *http.Request, result desktopactivation.SubmitProofResult) {
	response := map[string]any{
		"proofId": result.ProofID, "result": result.Result,
		"sessionRevision": result.SessionRevision, "replayed": result.Replayed,
	}
	if result.Activation != nil {
		activation := result.Activation
		response["operationId"] = activation.OperationID
		response["activationId"] = activation.ActivationID
		response["credentialRevision"] = activation.CredentialRevision
		response["leaseEpoch"] = activation.LeaseEpoch
		response["sourceCredentialRevision"] = activation.SourceCredentialRevision
		response["revocationEpoch"] = activation.RevocationEpoch
		response["bindingDigest"] = activation.BindingDigest
		response["activationToken"] = activation.ActivationToken
		response["expiresAt"] = activation.ExpiresAt
	}
	writeData(w, r, http.StatusOK, response)
}

func (s *Server) writeDesktopActivationError(w http.ResponseWriter, r *http.Request, err error, acknowledgement bool) {
	switch {
	case errors.Is(err, store.ErrDeviceProofReplayed):
		writeError(w, r, http.StatusConflict, deviceauth.DeviceProofReplayedCode, "device proof was replayed")
	case errors.Is(err, store.ErrRevisionConflict):
		writeError(w, r, http.StatusConflict, "revision_conflict", "authorization session revision changed")
	case errors.Is(err, store.ErrExecutorFenced):
		writeError(w, r, http.StatusConflict, "executor_fenced", "credential activation target is stale")
	case errors.Is(err, store.ErrExecutorBusy):
		writeError(w, r, http.StatusConflict, "executor_has_active_tasks", "executor has active tasks")
	case errors.Is(err, store.ErrDesktopAccountIntentConflict):
		writeError(w, r, http.StatusConflict, "account_intent_conflict", "authorized account conflicts with the requested intent")
	case errors.Is(err, store.ErrDesktopProofConflict):
		writeError(w, r, http.StatusConflict, "desktop_proof_conflict", "Desktop authorization proof conflicts with current state")
	case errors.Is(err, store.ErrDesktopActivationConflict), errors.Is(err, store.ErrConflict):
		writeError(w, r, http.StatusConflict, "desktop_activation_conflict", "Desktop credential activation conflicts with current state")
	case errors.Is(err, trustedtoken.ErrExpired), errors.Is(err, trustedtoken.ErrUnknownKey),
		errors.Is(err, store.ErrDesktopHandoffExpired),
		errors.Is(err, desktopactivation.ErrTokenKeyUnavailable), errors.Is(err, desktopactivation.ErrTokenReconstruction),
		errors.Is(err, store.ErrDesktopActivationTokenReconstruction):
		writeError(w, r, http.StatusGone, "desktop_authorization_gone", "Desktop authorization token is no longer available")
	case errors.Is(err, store.ErrDesktopClaimTokenMismatch), errors.Is(err, store.ErrDesktopActivationTokenMismatch),
		errors.Is(err, store.ErrDesktopHandoffTargetMismatch), errors.Is(err, store.ErrDeviceMismatch),
		errors.Is(err, store.ErrDeviceInactive), errors.Is(err, store.ErrDeviceKeyGenerationMismatch),
		errors.Is(err, deviceauth.ErrTimestampOutsideWindow), errors.Is(err, store.ErrNotFound),
		isTrustedTokenVerificationError(err):
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "Desktop authorization proof is invalid")
	case errors.Is(err, store.ErrExecutorDisabled):
		writeError(w, r, http.StatusConflict, "executor_disabled", "executor is disabled")
	case errors.Is(err, store.ErrExecutorRuntimeUnsupported):
		writeError(w, r, http.StatusUnprocessableEntity, "executor_runtime_unsupported", "executor runtime is unsupported")
	case errors.Is(err, store.ErrDesktopProofInputInvalid), errors.Is(err, store.ErrDesktopActivationInputInvalid),
		errors.Is(err, store.ErrDeviceLedgerRetentionInvalid), errors.Is(err, desktopactivation.ErrInvalidInput):
		writeError(w, r, http.StatusBadRequest, "validation_error", "Desktop authorization input is invalid")
	default:
		code := "desktop_proof_failed"
		message := "Desktop authorization proof failed"
		if acknowledgement {
			code = "desktop_activation_failed"
			message = "Desktop credential activation failed"
		}
		writeError(w, r, http.StatusInternalServerError, code, message)
	}
}

func desktopProofPath(sessionID string) string {
	return "/api/v1/ai-executor-authorization-sessions/" + sessionID + "/desktop-proofs"
}

func desktopActivationACKPath(sessionID, activationID string) string {
	return "/api/v1/ai-executor-authorization-sessions/" + sessionID + "/desktop-activations/" + activationID + "/ack"
}
