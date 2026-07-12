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

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/desktopcommand"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
)

const desktopAuthorizationCommandRequestLimit = 24 << 10

var desktopAuthorizationCommandFailurePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

type desktopAuthorizationCommandRuntime interface {
	Cancel(context.Context, desktopcommand.CreateInput) (store.CreateDesktopAuthorizationCommandResult, error)
	Reopen(context.Context, desktopcommand.CreateInput) (store.CreateDesktopAuthorizationCommandResult, error)
	Acknowledge(context.Context, store.AcknowledgeDesktopAuthorizationCommandInput, string) (store.AcknowledgeDesktopAuthorizationCommandResult, error)
}

type desktopAuthorizationCommandDeviceStore interface {
	GetDeviceVerificationKey(context.Context, string) (store.DeviceVerificationKey, error)
}

type desktopAuthorizationCommandACKRawBody struct {
	OperationID             json.RawMessage `json:"operationId"`
	Purpose                 json.RawMessage `json:"purpose"`
	ExpectedSessionRevision json.RawMessage `json:"expectedSessionRevision"`
	Result                  json.RawMessage `json:"result"`
	CompletedAt             json.RawMessage `json:"completedAt"`
	FailureCode             json.RawMessage `json:"failureCode"`
}

func (s *Server) registerDesktopAuthorizationCommandRoutes(mux *http.ServeMux) {
	mux.HandleFunc(
		"POST /api/v1/ai-executor-authorization-sessions/{sessionId}/desktop-commands/{operationId}/ack",
		s.acknowledgeDesktopAuthorizationCommand,
	)
}

func (s *Server) acknowledgeDesktopAuthorizationCommand(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	w.Header().Set("Referrer-Policy", "no-referrer")
	ensureRequestID(r)
	if !s.cfg.WriteEnabled || s.control == nil || s.desktopCommandRuntime == nil {
		writeError(w, r, http.StatusServiceUnavailable, "desktop_command_unavailable", "Desktop command is unavailable")
		return
	}
	deviceStore, ok := s.control.(desktopAuthorizationCommandDeviceStore)
	if !ok {
		writeError(w, r, http.StatusServiceUnavailable, "desktop_command_unavailable", "Desktop command is unavailable")
		return
	}
	sessionID, operationID := r.PathValue("sessionId"), r.PathValue("operationId")
	expectedPath := store.DesktopAuthorizationCommandACKPath(sessionID, operationID)
	if !validOpaqueID(sessionID) || !validOpaqueID(operationID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "Desktop command path is invalid")
		return
	}
	if !requireRawDevicePath(w, r, expectedPath) || !rejectDesktopCommandACKOverrides(w, r) {
		return
	}
	authorization, ok := strictSingleHeader(r.Header, "Authorization")
	if !ok || !validDesktopCommandAuthorization(authorization) {
		writeError(w, r, http.StatusUnauthorized, "desktop_command_unauthorized", "Desktop command authentication is required")
		return
	}
	var rawBody desktopAuthorizationCommandACKRawBody
	raw, ok := decodeDeviceJSON(w, r, desktopAuthorizationCommandRequestLimit, &rawBody)
	if !ok {
		return
	}
	input, ok := parseDesktopAuthorizationCommandACKBody(rawBody, sessionID, operationID)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "Desktop command acknowledgement input is invalid")
		return
	}
	parsed, err := deviceauth.ParseProofHeaders(r.Header)
	if err != nil {
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "device proof is invalid")
		return
	}
	key, err := deviceStore.GetDeviceVerificationKey(r.Context(), parsed.DeviceID)
	if err != nil || key.DeviceID != parsed.DeviceID || key.KeyGeneration == 0 {
		if err != nil && !errors.Is(err, store.ErrNotFound) && !errors.Is(err, store.ErrDeviceInactive) &&
			!errors.Is(err, store.ErrDeviceKeyGenerationMismatch) {
			writeError(w, r, http.StatusInternalServerError, "desktop_command_failed", "device verification is unavailable")
			return
		}
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "device proof is invalid")
		return
	}
	proof, err := deviceauth.VerifyRequestForPersistentLedger(deviceauth.VerifyInput{
		PublicKey: key.PublicKey, Method: r.Method, RequestTarget: r.RequestURI,
		Headers: r.Header, Body: raw, AllowedAuthorizationSchemes: []string{"AiCRM-Command"},
	})
	if err != nil || proof.DeviceID != key.DeviceID || proof.AuthorizationTokenHash == "" {
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "device proof is invalid")
		return
	}
	input.KeyGeneration = key.KeyGeneration
	input.Proof = proof
	input.LedgerExpiresAt = time.Now().UTC().Add(store.DeviceLedgerAuditRetention + deviceLedgerExpiryMargin)
	result, err := s.desktopCommandRuntime.Acknowledge(
		r.Context(), input, strings.TrimPrefix(authorization, "AiCRM-Command "),
	)
	if err != nil {
		s.writeDesktopAuthorizationCommandError(w, r, err, true)
		return
	}
	writeData(w, r, http.StatusOK, map[string]any{
		"operationId":             result.Command.OperationID,
		"sessionId":               result.Command.SessionID,
		"purpose":                 result.Command.Purpose,
		"expectedSessionRevision": result.Command.ExpectedSessionRevision,
		"status":                  result.Command.Status, "failureCode": safeCode(result.Command.FailureCode),
		"completedAt": result.Command.CompletedAt, "replayed": result.Replayed,
	})
}

func parseDesktopAuthorizationCommandACKBody(
	raw desktopAuthorizationCommandACKRawBody,
	sessionID string,
	operationID string,
) (store.AcknowledgeDesktopAuthorizationCommandInput, bool) {
	var bodyOperationID, purpose, result, completedAtText, failureCode string
	var expectedRevision int64
	if !decodeRequiredCredentialRevocationJSON(raw.OperationID, &bodyOperationID) || bodyOperationID != operationID ||
		!decodeRequiredCredentialRevocationJSON(raw.Purpose, &purpose) ||
		(purpose != trustedtoken.PurposeAuthorizationCancel && purpose != trustedtoken.PurposeAuthorizationReopen) ||
		!decodeRequiredCredentialRevocationJSON(raw.ExpectedSessionRevision, &expectedRevision) ||
		expectedRevision <= 0 || expectedRevision >= math.MaxInt64 ||
		!decodeRequiredCredentialRevocationJSON(raw.Result, &result) ||
		!decodeRequiredCredentialRevocationJSON(raw.CompletedAt, &completedAtText) {
		return store.AcknowledgeDesktopAuthorizationCommandInput{}, false
	}
	completedAt, err := time.Parse(time.RFC3339Nano, completedAtText)
	if err != nil || completedAt.IsZero() ||
		completedAtText != completedAt.UTC().Format(time.RFC3339Nano) {
		return store.AcknowledgeDesktopAuthorizationCommandInput{}, false
	}
	switch result {
	case "succeeded", "stale_target":
		if len(raw.FailureCode) != 0 {
			return store.AcknowledgeDesktopAuthorizationCommandInput{}, false
		}
	case "failed":
		if !decodeRequiredCredentialRevocationJSON(raw.FailureCode, &failureCode) ||
			!desktopAuthorizationCommandFailurePattern.MatchString(failureCode) {
			return store.AcknowledgeDesktopAuthorizationCommandInput{}, false
		}
	default:
		return store.AcknowledgeDesktopAuthorizationCommandInput{}, false
	}
	return store.AcknowledgeDesktopAuthorizationCommandInput{
		SessionID: sessionID, OperationID: operationID, Purpose: purpose,
		ExpectedSessionRevision: expectedRevision, Result: result,
		CompletedAt: completedAt.UTC(), FailureCode: failureCode,
	}, true
}

func rejectDesktopCommandACKOverrides(w http.ResponseWriter, r *http.Request) bool {
	for _, name := range []string{"X-KY-Workspace-Type", "X-KY-Workspace-Id", "Idempotency-Key"} {
		if len(r.Header.Values(name)) != 0 {
			writeError(w, r, http.StatusBadRequest, "device_header_forbidden", "workspace and idempotency headers are forbidden")
			return false
		}
	}
	return true
}

func validDesktopCommandAuthorization(value string) bool {
	if !strings.HasPrefix(value, "AiCRM-Command ") {
		return false
	}
	token := strings.TrimPrefix(value, "AiCRM-Command ")
	return token != "" && len(token) <= 16<<10 && strings.TrimSpace(token) == token &&
		!strings.ContainsAny(token, " \t\r\n")
}

func writeDesktopAuthorizationCommandCreateResult(
	w http.ResponseWriter,
	r *http.Request,
	result store.CreateDesktopAuthorizationCommandResult,
) {
	if !result.CommandCreated {
		writeData(w, r, http.StatusOK, result.Session)
		return
	}
	if result.CommandTicket == "" || result.Command.ExpiresAt == "" ||
		result.Command.OperationID == "" || result.Command.SessionID != result.Session.ID {
		writeError(w, r, http.StatusInternalServerError, "desktop_command_failed", "Desktop command result is invalid")
		return
	}
	writeData(w, r, http.StatusAccepted, map[string]any{
		"session": result.Session,
		"desktopCommand": map[string]any{
			"operationId":             result.Command.OperationID,
			"expectedSessionRevision": result.Command.ExpectedSessionRevision,
			"commandTicket":           result.CommandTicket,
			"expiresAt":               result.Command.ExpiresAt,
		},
	})
}

func (s *Server) writeDesktopAuthorizationCommandError(
	w http.ResponseWriter,
	r *http.Request,
	err error,
	acknowledgement bool,
) {
	switch {
	case errors.Is(err, store.ErrIdempotencyReuse):
		writeError(w, r, http.StatusConflict, "idempotency_key_reused", "Idempotency-Key was reused with another request")
	case errors.Is(err, store.ErrDeviceProofReplayed):
		writeError(w, r, http.StatusConflict, deviceauth.DeviceProofReplayedCode, "device proof was replayed")
	case errors.Is(err, store.ErrRevisionConflict):
		writeError(w, r, http.StatusConflict, "revision_conflict", "authorization session revision changed")
	case errors.Is(err, store.ErrRequesterMismatch):
		writeError(w, r, http.StatusForbidden, "permission_denied", "only the requester or platform owner may operate authorization")
	case errors.Is(err, store.ErrAuthorizationTerminal):
		writeError(w, r, http.StatusConflict, "authorization_session_terminal", "authorization session is terminal")
	case errors.Is(err, desktopcommand.ErrTokenKeyUnavailable), errors.Is(err, desktopcommand.ErrTokenReconstruction),
		acknowledgement && isTrustedTokenGone(err):
		writeError(w, r, http.StatusGone, "desktop_command_gone", "Desktop command is no longer available")
	case errors.Is(err, store.ErrDesktopAuthorizationCommandTicketMismatch),
		errors.Is(err, store.ErrDeviceInactive), errors.Is(err, store.ErrDeviceKeyGenerationMismatch),
		errors.Is(err, deviceauth.ErrTimestampOutsideWindow), acknowledgement && errors.Is(err, store.ErrNotFound),
		acknowledgement && isTrustedTokenVerificationError(err):
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "Desktop command proof is invalid")
	case errors.Is(err, store.ErrDeviceMismatch):
		writeError(w, r, http.StatusConflict, "desktop_device_mismatch", "bound Desktop device does not match")
	case errors.Is(err, store.ErrDesktopAuthorizationCommandACKRecorded),
		errors.Is(err, store.ErrDesktopAuthorizationCommandStateInvalid),
		errors.Is(err, store.ErrExecutorFenced), errors.Is(err, store.ErrConflict):
		writeError(w, r, http.StatusConflict, "desktop_command_conflict", "Desktop command conflicts with current state")
	case errors.Is(err, store.ErrNotFound):
		writeError(w, r, http.StatusNotFound, "not_found", "authorization session was not found")
	case errors.Is(err, store.ErrDesktopAuthorizationCommandInputInvalid),
		errors.Is(err, store.ErrDesktopAuthorizationCommandCompletedAt),
		errors.Is(err, store.ErrDeviceLedgerRetentionInvalid), errors.Is(err, desktopcommand.ErrInvalidInput):
		writeError(w, r, http.StatusBadRequest, "validation_error", "Desktop command input is invalid")
	default:
		writeError(w, r, http.StatusInternalServerError, "desktop_command_failed", "Desktop command failed")
	}
}
