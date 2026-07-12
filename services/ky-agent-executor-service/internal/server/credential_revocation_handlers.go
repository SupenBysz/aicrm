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

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/accessclient"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/credentialrevocation"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/operationconfirmation"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/shared/auth"
)

const (
	credentialRevocationRequestLimit     = 24 << 10
	credentialRevocationRequestDomain    = "AICRM-CREDENTIAL-REVOCATION-V1"
	permissionCredentialAuthorize        = "platform.ai_executors.authorize"
	permissionCredentialChangeAccount    = "platform.ai_executors.change_account"
	permissionCredentialForceRevoke      = "platform.ai_executors.force_revoke"
	credentialRevocationUnavailableCode  = "credential_revocation_unavailable"
	credentialRevocationUnavailableText  = "credential revocation is unavailable"
	credentialRevocationProofInvalidCode = "authorization_proof_invalid"
)

var credentialRevocationDigestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type credentialRevocationRuntime interface {
	Revoke(context.Context, credentialrevocation.RevokeInput) (store.CreateCredentialRevocationResult, error)
	Acknowledge(context.Context, store.AcknowledgeCredentialRevocationInput, string) (store.AcknowledgeCredentialRevocationResult, error)
}

type credentialRevocationDeviceStore interface {
	GetDeviceVerificationKey(context.Context, string) (store.DeviceVerificationKey, error)
}

type credentialRevocationRawBody struct {
	ExpectedCredentialRevision json.RawMessage `json:"expectedCredentialRevision"`
	Force                      json.RawMessage `json:"force"`
	ConfirmationToken          json.RawMessage `json:"confirmationToken"`
}

type credentialRevocationCanonicalBody struct {
	ExpectedCredentialRevision int64   `json:"expectedCredentialRevision"`
	Force                      bool    `json:"force"`
	ConfirmationToken          *string `json:"confirmationToken,omitempty"`
}

type credentialRevocationACKRawBody struct {
	OperationID        json.RawMessage `json:"operationId"`
	RevocationID       json.RawMessage `json:"revocationId"`
	CredentialRevision json.RawMessage `json:"credentialRevision"`
	RevocationEpoch    json.RawMessage `json:"revocationEpoch"`
	CompletedAt        json.RawMessage `json:"completedAt"`
	QuarantineDigest   json.RawMessage `json:"quarantineDigest"`
	Result             json.RawMessage `json:"result"`
}

type credentialRevocationActor struct {
	ActorID   string
	SessionID string
}

func (s *Server) registerCredentialRevocationRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/ai-executors/{executorId}/credential/revoke", s.revokeExecutorCredential)
	mux.HandleFunc(
		"POST /api/v1/ai-executors/{executorId}/credential-revocations/{revocationId}/ack",
		s.acknowledgeCredentialRevocation,
	)
}

func (s *Server) revokeExecutorCredential(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	w.Header().Set("Referrer-Policy", "no-referrer")
	ensureRequestID(r)
	if !s.credentialRevocationReady() {
		writeError(w, r, http.StatusServiceUnavailable, credentialRevocationUnavailableCode, credentialRevocationUnavailableText)
		return
	}
	executorID := r.PathValue("executorId")
	expectedPath := credentialRevocationPath(executorID)
	if !validOpaqueID(executorID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "executorId is invalid")
		return
	}
	if !requireRawDevicePath(w, r, expectedPath) || !rejectDeviceProofHeaders(w, r) {
		return
	}
	actor, ok := s.authenticateCredentialRevocationActor(w, r)
	if !ok {
		return
	}
	idempotencyKey, ok := strictIdempotencyKey(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "idempotency_key_required", "a valid Idempotency-Key is required")
		return
	}
	var rawBody credentialRevocationRawBody
	if _, ok = decodeDeviceJSON(w, r, credentialRevocationRequestLimit, &rawBody); !ok {
		return
	}
	body, ok := parseCredentialRevocationBody(rawBody)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "credential revocation input is invalid")
		return
	}
	if !s.authorizeCredentialRevocation(w, r, actor, body.Force) {
		return
	}
	canonical, err := json.Marshal(body)
	if err != nil {
		writeError(w, r, http.StatusInternalServerError, "credential_revocation_failed", "credential revocation failed")
		return
	}
	confirmationToken := ""
	if body.ConfirmationToken != nil {
		confirmationToken = *body.ConfirmationToken
	}
	result, err := s.revocationRuntime.Revoke(r.Context(), credentialrevocation.RevokeInput{
		ExecutorID: executorID, ActorID: actor.ActorID, ActorSessionID: actor.SessionID,
		ExpectedCredentialRevision: body.ExpectedCredentialRevision, Force: body.Force,
		IdempotencyKeyHash: sha256Hex([]byte(idempotencyKey)),
		RequestHash:        credentialRevocationRequestHash(r.Method, expectedPath, canonical),
		ConfirmationToken:  confirmationToken,
	})
	if err != nil {
		s.writeCredentialRevocationError(w, r, err, false)
		return
	}
	writeCredentialRevocationCreateResult(w, r, result)
}

func (s *Server) acknowledgeCredentialRevocation(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	w.Header().Set("Referrer-Policy", "no-referrer")
	ensureRequestID(r)
	if !s.credentialRevocationReady() {
		writeError(w, r, http.StatusServiceUnavailable, credentialRevocationUnavailableCode, credentialRevocationUnavailableText)
		return
	}
	deviceStore, ok := s.control.(credentialRevocationDeviceStore)
	if !ok {
		writeError(w, r, http.StatusServiceUnavailable, credentialRevocationUnavailableCode, credentialRevocationUnavailableText)
		return
	}
	executorID, revocationID := r.PathValue("executorId"), r.PathValue("revocationId")
	expectedPath := store.CredentialRevocationACKPath(executorID, revocationID)
	if !validOpaqueID(executorID) || !validOpaqueID(revocationID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "credential revocation path is invalid")
		return
	}
	if !requireRawDevicePath(w, r, expectedPath) || !rejectCredentialRevocationACKOverrides(w, r) {
		return
	}
	authorization, ok := strictSingleHeader(r.Header, "Authorization")
	if !ok || !validCredentialRevocationCommandAuthorization(authorization) {
		writeError(w, r, http.StatusUnauthorized, "credential_revocation_unauthorized", "credential revocation command authentication is required")
		return
	}
	var rawBody credentialRevocationACKRawBody
	raw, ok := decodeDeviceJSON(w, r, credentialRevocationRequestLimit, &rawBody)
	if !ok {
		return
	}
	input, ok := parseCredentialRevocationACKBody(rawBody, executorID, revocationID)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "credential revocation acknowledgement input is invalid")
		return
	}
	parsed, err := deviceauth.ParseProofHeaders(r.Header)
	if err != nil {
		writeError(w, r, http.StatusForbidden, credentialRevocationProofInvalidCode, "device proof is invalid")
		return
	}
	key, err := deviceStore.GetDeviceVerificationKey(r.Context(), parsed.DeviceID)
	if err != nil || key.DeviceID != parsed.DeviceID || key.KeyGeneration == 0 {
		if err != nil && !errors.Is(err, store.ErrNotFound) && !errors.Is(err, store.ErrDeviceInactive) &&
			!errors.Is(err, store.ErrDeviceKeyGenerationMismatch) {
			writeError(w, r, http.StatusInternalServerError, "credential_revocation_failed", "device verification is unavailable")
			return
		}
		writeError(w, r, http.StatusForbidden, credentialRevocationProofInvalidCode, "device proof is invalid")
		return
	}
	proof, err := deviceauth.VerifyRequestForPersistentLedger(deviceauth.VerifyInput{
		PublicKey: key.PublicKey, Method: r.Method, RequestTarget: r.RequestURI,
		Headers: r.Header, Body: raw, AllowedAuthorizationSchemes: []string{"AiCRM-Command"},
	})
	if err != nil || proof.DeviceID != key.DeviceID || proof.AuthorizationTokenHash == "" {
		writeError(w, r, http.StatusForbidden, credentialRevocationProofInvalidCode, "device proof is invalid")
		return
	}
	input.KeyGeneration = key.KeyGeneration
	input.Proof = proof
	input.LedgerExpiresAt = time.Now().UTC().Add(store.DeviceLedgerAuditRetention + deviceLedgerExpiryMargin)
	result, err := s.revocationRuntime.Acknowledge(
		r.Context(), input, strings.TrimPrefix(authorization, "AiCRM-Command "),
	)
	if err != nil {
		s.writeCredentialRevocationError(w, r, err, true)
		return
	}
	writeData(w, r, http.StatusOK, map[string]any{
		"revocationId":       result.Revocation.RevocationID,
		"operationId":        result.Revocation.OperationID,
		"credentialRevision": result.Revocation.CredentialRevision,
		"revocationEpoch":    result.Revocation.RevocationEpoch,
		"status":             result.Revocation.Status,
		"failureCode":        safeCode(result.Revocation.FailureCode),
		"completedAt":        result.Revocation.CompletedAt,
		"replayed":           result.Replayed,
	})
}

func (s *Server) credentialRevocationReady() bool {
	return s.cfg.WriteEnabled && s.control != nil && s.revocationRuntime != nil
}

func (s *Server) authenticateCredentialRevocationActor(
	w http.ResponseWriter,
	r *http.Request,
) (credentialRevocationActor, bool) {
	if s.authorizer == nil || s.cfg.AuthTokenSecret == "" {
		writeError(w, r, http.StatusServiceUnavailable, "authentication_unavailable", "authentication is unavailable")
		return credentialRevocationActor{}, false
	}
	workspaceType, workspaceTypeOK := strictSingleHeader(r.Header, "X-KY-Workspace-Type")
	workspaceID, workspaceIDOK := strictSingleHeader(r.Header, "X-KY-Workspace-Id")
	if !workspaceTypeOK || !workspaceIDOK || workspaceType != "platform" || workspaceID != "platform_root" {
		writeError(w, r, http.StatusForbidden, "workspace_forbidden", "platform workspace is required")
		return credentialRevocationActor{}, false
	}
	authorization, ok := strictSingleHeader(r.Header, "Authorization")
	if !ok || !strings.HasPrefix(authorization, "Bearer ") {
		writeError(w, r, http.StatusUnauthorized, "unauthorized", "authentication is required")
		return credentialRevocationActor{}, false
	}
	token := strings.TrimPrefix(authorization, "Bearer ")
	if token == "" || strings.ContainsAny(token, " \t\r\n") {
		writeError(w, r, http.StatusUnauthorized, "unauthorized", "authentication is invalid")
		return credentialRevocationActor{}, false
	}
	payload, err := auth.VerifyToken(s.cfg.AuthTokenSecret, token)
	if err != nil || !validOpaqueID(payload.UserID) || !validOpaqueID(payload.SessionID) {
		writeError(w, r, http.StatusUnauthorized, "unauthorized", "authentication is invalid")
		return credentialRevocationActor{}, false
	}
	return credentialRevocationActor{ActorID: payload.UserID, SessionID: payload.SessionID}, true
}

func (s *Server) authorizeCredentialRevocation(
	w http.ResponseWriter,
	r *http.Request,
	actor credentialRevocationActor,
	force bool,
) bool {
	permissions := []string{permissionCredentialAuthorize, permissionCredentialChangeAccount}
	if force {
		permissions = []string{permissionCredentialForceRevoke}
	}
	decision, err := s.authorizer.Evaluate(r.Context(), requestID(r), accessclient.Request{
		ActorID: actor.ActorID, SessionID: actor.SessionID,
		WorkspaceType: "platform", WorkspaceID: "platform_root",
		RequiredAllPermissions: permissions,
	})
	if errors.Is(err, accessclient.ErrDenied) {
		writeError(w, r, http.StatusForbidden, "permission_denied", "permission is denied")
		return false
	}
	if err != nil {
		writeError(w, r, http.StatusServiceUnavailable, "authorization_unavailable", "authorization decision is unavailable")
		return false
	}
	if !decision.Allowed || decision.ActorID != actor.ActorID || decision.WorkspaceType != "platform" ||
		decision.WorkspaceID != "platform_root" {
		writeError(w, r, http.StatusForbidden, "permission_denied", "permission is denied")
		return false
	}
	for _, permission := range permissions {
		if !containsExact(decision.GrantedRequiredPermissions, permission) {
			writeError(w, r, http.StatusForbidden, "permission_denied", "permission is denied")
			return false
		}
	}
	return true
}

func parseCredentialRevocationBody(raw credentialRevocationRawBody) (credentialRevocationCanonicalBody, bool) {
	var revision int64
	var force bool
	if !decodeRequiredCredentialRevocationJSON(raw.ExpectedCredentialRevision, &revision) || revision <= 0 || revision >= math.MaxInt64 ||
		!decodeRequiredCredentialRevocationJSON(raw.Force, &force) {
		return credentialRevocationCanonicalBody{}, false
	}
	body := credentialRevocationCanonicalBody{ExpectedCredentialRevision: revision, Force: force}
	if !force {
		return body, len(raw.ConfirmationToken) == 0
	}
	var token string
	if !decodeRequiredCredentialRevocationJSON(raw.ConfirmationToken, &token) || !validConfirmationToken(token) {
		return credentialRevocationCanonicalBody{}, false
	}
	body.ConfirmationToken = &token
	return body, true
}

func parseCredentialRevocationACKBody(
	raw credentialRevocationACKRawBody,
	executorID string,
	revocationID string,
) (store.AcknowledgeCredentialRevocationInput, bool) {
	var operationID, bodyRevocationID, completedAtText, quarantineDigest, result string
	var credentialRevision, revocationEpoch int64
	if !decodeRequiredCredentialRevocationJSON(raw.OperationID, &operationID) || !validOpaqueID(operationID) ||
		!decodeRequiredCredentialRevocationJSON(raw.RevocationID, &bodyRevocationID) || bodyRevocationID != revocationID ||
		!decodeRequiredCredentialRevocationJSON(raw.CredentialRevision, &credentialRevision) || credentialRevision <= 0 || credentialRevision >= math.MaxInt64 ||
		!decodeRequiredCredentialRevocationJSON(raw.RevocationEpoch, &revocationEpoch) || revocationEpoch <= 0 || revocationEpoch >= math.MaxInt64 ||
		!decodeRequiredCredentialRevocationJSON(raw.CompletedAt, &completedAtText) ||
		!decodeRequiredCredentialRevocationJSON(raw.QuarantineDigest, &quarantineDigest) ||
		!decodeRequiredCredentialRevocationJSON(raw.Result, &result) {
		return store.AcknowledgeCredentialRevocationInput{}, false
	}
	completedAt, err := time.Parse(time.RFC3339Nano, completedAtText)
	if err != nil || completedAt.IsZero() || completedAtText != completedAt.Format(time.RFC3339Nano) {
		return store.AcknowledgeCredentialRevocationInput{}, false
	}
	switch result {
	case "succeeded":
		if !credentialRevocationDigestPattern.MatchString(quarantineDigest) {
			return store.AcknowledgeCredentialRevocationInput{}, false
		}
	case "failed":
		if quarantineDigest != "" && !credentialRevocationDigestPattern.MatchString(quarantineDigest) {
			return store.AcknowledgeCredentialRevocationInput{}, false
		}
	case "stale_target":
		if quarantineDigest != "" {
			return store.AcknowledgeCredentialRevocationInput{}, false
		}
	default:
		return store.AcknowledgeCredentialRevocationInput{}, false
	}
	return store.AcknowledgeCredentialRevocationInput{
		ExecutorID: executorID, RevocationID: revocationID, OperationID: operationID,
		CredentialRevision: credentialRevision, RevocationEpoch: revocationEpoch,
		CompletedAt: completedAt.UTC(), QuarantineDigest: quarantineDigest, Result: result,
	}, true
}

func decodeRequiredCredentialRevocationJSON(raw json.RawMessage, target any) bool {
	return len(raw) != 0 && string(raw) != "null" && json.Unmarshal(raw, target) == nil
}

func rejectCredentialRevocationACKOverrides(w http.ResponseWriter, r *http.Request) bool {
	for _, name := range []string{"X-KY-Workspace-Type", "X-KY-Workspace-Id", "Idempotency-Key"} {
		if len(r.Header.Values(name)) != 0 {
			writeError(w, r, http.StatusBadRequest, "device_header_forbidden", "workspace and idempotency headers are forbidden")
			return false
		}
	}
	return true
}

func validCredentialRevocationCommandAuthorization(value string) bool {
	if !strings.HasPrefix(value, "AiCRM-Command ") {
		return false
	}
	token := strings.TrimPrefix(value, "AiCRM-Command ")
	return token != "" && len(token) <= 16<<10 && strings.TrimSpace(token) == token && !strings.ContainsAny(token, " \t\r\n")
}

func credentialRevocationRequestHash(method, path string, canonical []byte) string {
	return sha256Hex([]byte(strings.Join([]string{
		credentialRevocationRequestDomain, method, path, sha256Hex(canonical),
	}, "\n")))
}

func credentialRevocationPath(executorID string) string {
	return "/api/v1/ai-executors/" + executorID + "/credential/revoke"
}

func writeCredentialRevocationCreateResult(
	w http.ResponseWriter,
	r *http.Request,
	result store.CreateCredentialRevocationResult,
) {
	item := result.Revocation
	if item.RuntimeType == "server" && item.Status == "completed" && result.CommandTicket == "" {
		writeData(w, r, http.StatusOK, map[string]any{
			"credentialStatus": "revoked", "credentialRevision": item.CredentialRevision,
			"revocationEpoch": item.RevocationEpoch,
		})
		return
	}
	if item.RuntimeType != "desktop" || result.CommandTicket == "" || item.ExpiresAt == nil {
		writeError(w, r, http.StatusInternalServerError, "credential_revocation_failed", "credential revocation result is invalid")
		return
	}
	writeData(w, r, http.StatusAccepted, map[string]any{
		"operationId": item.OperationID, "revocationId": item.RevocationID,
		"credentialRevision": item.CredentialRevision, "revocationEpoch": item.RevocationEpoch,
		"status": "awaiting_device", "commandTicket": result.CommandTicket, "expiresAt": item.ExpiresAt,
	})
}

func (s *Server) writeCredentialRevocationError(w http.ResponseWriter, r *http.Request, err error, acknowledgement bool) {
	switch {
	case errors.Is(err, store.ErrIdempotencyReuse):
		writeError(w, r, http.StatusConflict, "idempotency_key_reused", "Idempotency-Key was reused with another request")
	case errors.Is(err, store.ErrDeviceProofReplayed):
		writeError(w, r, http.StatusConflict, deviceauth.DeviceProofReplayedCode, "device proof was replayed")
	case errors.Is(err, store.ErrRevisionConflict):
		writeError(w, r, http.StatusConflict, "revision_conflict", "credential revision changed")
	case errors.Is(err, store.ErrCredentialRevocationActiveWork):
		writeError(w, r, http.StatusConflict, "executor_has_active_tasks", "executor has active tasks")
	case errors.Is(err, credentialrevocation.ErrTokenKeyUnavailable), errors.Is(err, credentialrevocation.ErrTokenReconstruction),
		acknowledgement && isTrustedTokenGone(err):
		writeError(w, r, http.StatusGone, "credential_revocation_gone", "credential revocation authorization is no longer available")
	case !acknowledgement && (isTrustedTokenGone(err) ||
		errors.Is(err, store.ErrOperationConfirmationTokenExpired)):
		writeError(w, r, http.StatusGone, "operation_confirmation_gone", "operation confirmation is unavailable")
	case !acknowledgement && (errors.Is(err, store.ErrOperationConfirmationTokenMismatch) ||
		errors.Is(err, store.ErrCredentialRevocationConfirmation) ||
		errors.Is(err, operationconfirmation.ErrInvalidInput) || isTrustedTokenVerificationError(err)):
		writeError(w, r, http.StatusForbidden, "operation_confirmation_mismatch", "operation confirmation does not match")
	case errors.Is(err, store.ErrCredentialRevocationTicketMismatch), errors.Is(err, store.ErrDeviceMismatch),
		errors.Is(err, store.ErrDeviceInactive), errors.Is(err, store.ErrDeviceKeyGenerationMismatch),
		errors.Is(err, deviceauth.ErrTimestampOutsideWindow), acknowledgement && errors.Is(err, store.ErrNotFound),
		acknowledgement && isTrustedTokenVerificationError(err):
		writeError(w, r, http.StatusForbidden, credentialRevocationProofInvalidCode, "credential revocation proof is invalid")
	case errors.Is(err, store.ErrOperationConfirmationTokenConsumed):
		writeError(w, r, http.StatusConflict, "operation_confirmation_conflict", "operation confirmation is already used")
	case errors.Is(err, store.ErrCredentialRevocationReplayRace),
		errors.Is(err, store.ErrCredentialRevocationACKRecorded), errors.Is(err, store.ErrCredentialRevocationStateInvalid),
		errors.Is(err, store.ErrConflict):
		writeError(w, r, http.StatusConflict, "credential_revocation_conflict", "credential revocation conflicts with current state")
	case errors.Is(err, store.ErrNotFound):
		writeError(w, r, http.StatusNotFound, "not_found", "executor was not found")
	case errors.Is(err, store.ErrExecutorRuntimeUnsupported):
		writeError(w, r, http.StatusUnprocessableEntity, "executor_runtime_unsupported", "executor runtime is unsupported")
	case errors.Is(err, store.ErrExecutorDisabled):
		writeError(w, r, http.StatusConflict, "executor_disabled", "executor is disabled")
	case errors.Is(err, store.ErrCredentialRevocationInputInvalid), errors.Is(err, store.ErrCredentialRevocationCompletedAt),
		errors.Is(err, store.ErrDeviceLedgerRetentionInvalid), errors.Is(err, credentialrevocation.ErrInvalidInput):
		writeError(w, r, http.StatusBadRequest, "validation_error", "credential revocation input is invalid")
	default:
		writeError(w, r, http.StatusInternalServerError, "credential_revocation_failed", "credential revocation failed")
	}
}
