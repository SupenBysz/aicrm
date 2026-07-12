package server

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/desktophandoff"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
)

const desktopHandoffRequestLimit = 24 << 10

type desktopHandoffRuntime interface {
	Create(context.Context, desktophandoff.CreateInput) (desktophandoff.CreateResult, error)
	Claim(context.Context, desktophandoff.ClaimInput) (desktophandoff.ClaimResult, error)
}

type desktopHandoffDeviceStore interface {
	GetDeviceVerificationKey(context.Context, string) (store.DeviceVerificationKey, error)
}

type createDesktopHandoffBody struct {
	DeviceID                string `json:"deviceId"`
	ExpectedSessionRevision *int64 `json:"expectedSessionRevision"`
}

type claimDesktopHandoffBody struct {
	HandoffID string `json:"handoffId"`
	ClaimedAt string `json:"claimedAt"`
}

func (s *Server) registerDesktopHandoffRoutes(mux *http.ServeMux) {
	mux.HandleFunc(
		"POST /api/v1/ai-executor-authorization-sessions/{sessionId}/desktop-handoffs",
		s.public(nil, []string{"platform.ai_executors.authorize", "platform.ai_executors.change_account"}, s.createDesktopHandoff),
	)
	mux.HandleFunc(
		"POST /api/v1/ai-executor-authorization-sessions/{sessionId}/desktop-handoffs/{handoffId}/claim",
		s.claimDesktopHandoff,
	)
}

func (s *Server) createDesktopHandoff(w http.ResponseWriter, r *http.Request, actor actorContext) {
	if s.handoffRuntime == nil {
		writeError(w, r, http.StatusServiceUnavailable, "desktop_handoff_unavailable", "Desktop authorization handoff is unavailable")
		return
	}
	sessionID := r.PathValue("sessionId")
	expectedPath := desktopHandoffCreatePath(sessionID)
	if !validOpaqueID(sessionID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "sessionId is invalid")
		return
	}
	if !requireRawDevicePath(w, r, expectedPath) {
		return
	}
	if !requireStrictDesktopHandoffUserHeaders(w, r) || !rejectDeviceProofHeaders(w, r) {
		return
	}
	key, ok := strictIdempotencyKey(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "idempotency_key_required", "a valid Idempotency-Key is required")
		return
	}
	var body createDesktopHandoffBody
	_, ok = decodeDeviceJSON(w, r, desktopHandoffRequestLimit, &body)
	if !ok {
		return
	}
	if body.ExpectedSessionRevision == nil || *body.ExpectedSessionRevision <= 0 ||
		*body.ExpectedSessionRevision >= math.MaxInt64 || deviceauth.ValidateDeviceID(body.DeviceID) != nil {
		writeError(w, r, http.StatusBadRequest, "validation_error", "Desktop handoff input is invalid")
		return
	}
	canonical, _ := json.Marshal(body)
	result, err := s.handoffRuntime.Create(r.Context(), desktophandoff.CreateInput{
		SessionID: sessionID, ActorID: actor.ActorID, DeviceID: body.DeviceID,
		ExpectedSessionRevision: *body.ExpectedSessionRevision,
		IdempotencyKeyHash:      sha256Hex([]byte(key)),
		RequestHash:             sha256Hex(canonical),
	})
	if err != nil {
		s.writeDesktopHandoffError(w, r, err, false)
		return
	}
	status := http.StatusCreated
	if !result.Created {
		status = http.StatusOK
	}
	writeData(w, r, status, map[string]any{
		"handoffId": result.HandoffID, "handoffTicket": result.HandoffTicket,
		"nonce": result.Nonce, "expiresAt": result.ExpiresAt,
	})
}

func (s *Server) claimDesktopHandoff(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	ensureRequestID(r)
	if !s.cfg.WriteEnabled || s.control == nil || s.handoffRuntime == nil {
		writeError(w, r, http.StatusServiceUnavailable, "desktop_handoff_unavailable", "Desktop authorization handoff is unavailable")
		return
	}
	deviceStore, ok := s.control.(desktopHandoffDeviceStore)
	if !ok {
		writeError(w, r, http.StatusServiceUnavailable, "desktop_handoff_unavailable", "Desktop authorization handoff is unavailable")
		return
	}
	sessionID, handoffID := r.PathValue("sessionId"), r.PathValue("handoffId")
	expectedPath := desktopHandoffClaimPath(sessionID, handoffID)
	if !validOpaqueID(sessionID) || !validOpaqueID(handoffID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "Desktop handoff path is invalid")
		return
	}
	if !requireRawDevicePath(w, r, expectedPath) {
		return
	}
	if !rejectDesktopHandoffClaimOverrides(w, r) {
		return
	}
	authorization, ok := strictSingleHeader(r.Header, "Authorization")
	if !ok || !validDesktopHandoffAuthorization(authorization) {
		writeError(w, r, http.StatusUnauthorized, "desktop_handoff_unauthorized", "Desktop handoff authentication is required")
		return
	}
	var body claimDesktopHandoffBody
	raw, ok := decodeDeviceJSON(w, r, desktopHandoffRequestLimit, &body)
	if !ok {
		return
	}
	claimedAt, err := time.Parse(time.RFC3339Nano, body.ClaimedAt)
	if body.HandoffID != handoffID || err != nil {
		writeError(w, r, http.StatusBadRequest, "validation_error", "Desktop handoff claim input is invalid")
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
			writeError(w, r, http.StatusInternalServerError, "desktop_handoff_failed", "device verification is unavailable")
			return
		}
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "device proof is invalid")
		return
	}
	proof, err := deviceauth.VerifyRequestForPersistentLedger(deviceauth.VerifyInput{
		PublicKey: key.PublicKey, Method: r.Method, RequestTarget: r.RequestURI,
		Headers: r.Header, Body: raw, AllowedAuthorizationSchemes: []string{"AiCRM-Handoff"},
	})
	if err != nil || proof.DeviceID != key.DeviceID || proof.AuthorizationTokenHash == "" {
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "device proof is invalid")
		return
	}
	now := time.Now().UTC()
	result, err := s.handoffRuntime.Claim(r.Context(), desktophandoff.ClaimInput{
		HandoffTicket: strings.TrimPrefix(authorization, "AiCRM-Handoff "),
		SessionID:     sessionID, HandoffID: handoffID, TargetDeviceID: proof.DeviceID,
		KeyGeneration: key.KeyGeneration, Proof: proof, ClaimedAt: claimedAt,
		LedgerExpiresAt: now.Add(store.DeviceLedgerAuditRetention + deviceLedgerExpiryMargin),
	})
	if err != nil {
		s.writeDesktopHandoffError(w, r, err, true)
		return
	}
	writeData(w, r, http.StatusOK, map[string]any{
		"handoffId": result.HandoffID, "claimToken": result.ClaimToken,
		"expiresAt": result.ExpiresAt, "sessionRevision": result.SessionRevision,
		"replayed": result.Replayed,
	})
}

func requireStrictDesktopHandoffUserHeaders(w http.ResponseWriter, r *http.Request) bool {
	authorization, authorizationOK := strictSingleHeader(r.Header, "Authorization")
	workspaceType, workspaceTypeOK := strictSingleHeader(r.Header, "X-KY-Workspace-Type")
	workspaceID, workspaceIDOK := strictSingleHeader(r.Header, "X-KY-Workspace-Id")
	if !authorizationOK || !strings.HasPrefix(authorization, "Bearer ") ||
		!workspaceTypeOK || workspaceType != "platform" || !workspaceIDOK || workspaceID != "platform_root" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "Desktop handoff request headers are invalid")
		return false
	}
	return true
}

func rejectDesktopHandoffClaimOverrides(w http.ResponseWriter, r *http.Request) bool {
	for _, name := range []string{"X-KY-Workspace-Type", "X-KY-Workspace-Id", "Idempotency-Key"} {
		if len(r.Header.Values(name)) != 0 {
			writeError(w, r, http.StatusBadRequest, "device_header_forbidden", "workspace and idempotency headers are forbidden")
			return false
		}
	}
	return true
}

func validDesktopHandoffAuthorization(value string) bool {
	if !strings.HasPrefix(value, "AiCRM-Handoff ") {
		return false
	}
	token := strings.TrimPrefix(value, "AiCRM-Handoff ")
	return token != "" && len(token) <= 16<<10 && strings.TrimSpace(token) == token && !strings.ContainsAny(token, " \t\r\n")
}

func (s *Server) writeDesktopHandoffError(w http.ResponseWriter, r *http.Request, err error, claim bool) {
	switch {
	case errors.Is(err, store.ErrIdempotencyReuse):
		writeError(w, r, http.StatusConflict, "idempotency_key_reused", "Idempotency-Key was reused with another request")
	case errors.Is(err, store.ErrDeviceProofReplayed):
		writeError(w, r, http.StatusConflict, deviceauth.DeviceProofReplayedCode, "device proof was replayed")
	case errors.Is(err, store.ErrRevisionConflict):
		writeError(w, r, http.StatusConflict, "revision_conflict", "authorization session revision changed")
	case errors.Is(err, store.ErrDesktopHandoffExpired), errors.Is(err, trustedtoken.ErrExpired),
		errors.Is(err, trustedtoken.ErrUnknownKey):
		writeError(w, r, http.StatusGone, "desktop_handoff_gone", "Desktop authorization handoff is no longer available")
	case errors.Is(err, store.ErrDesktopDeviceOffline):
		writeError(w, r, http.StatusConflict, "desktop_device_offline", "the bound Desktop device is offline")
	case errors.Is(err, store.ErrDesktopHandoffConflict), errors.Is(err, store.ErrDesktopHandoffClaimConflict):
		writeError(w, r, http.StatusConflict, "desktop_handoff_conflict", "Desktop authorization handoff conflicts with current state")
	case errors.Is(err, store.ErrDesktopHandoffTargetMismatch), errors.Is(err, store.ErrDesktopHandoffTokenMismatch),
		errors.Is(err, store.ErrDeviceInactive), errors.Is(err, store.ErrDeviceKeyGenerationMismatch),
		errors.Is(err, deviceauth.ErrTimestampOutsideWindow), claim && errors.Is(err, store.ErrNotFound),
		isTrustedTokenVerificationError(err):
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "Desktop authorization proof is invalid")
	case errors.Is(err, store.ErrNotFound):
		writeError(w, r, http.StatusNotFound, "not_found", "authorization session was not found")
	case errors.Is(err, store.ErrExecutorDisabled):
		writeError(w, r, http.StatusConflict, "executor_disabled", "executor is disabled")
	case errors.Is(err, store.ErrExecutorRuntimeUnsupported):
		writeError(w, r, http.StatusUnprocessableEntity, "executor_runtime_unsupported", "executor runtime is unsupported")
	case errors.Is(err, store.ErrDesktopHandoffInputInvalid), errors.Is(err, desktophandoff.ErrInvalidInput),
		errors.Is(err, store.ErrDeviceLedgerRetentionInvalid):
		writeError(w, r, http.StatusBadRequest, "validation_error", "Desktop handoff input is invalid")
	case errors.Is(err, desktophandoff.ErrTokenKeyUnavailable), errors.Is(err, desktophandoff.ErrTokenReconstruction),
		errors.Is(err, store.ErrDesktopHandoffTokenReconstruction):
		writeError(w, r, http.StatusGone, "desktop_handoff_gone", "Desktop authorization handoff is no longer available")
	default:
		writeError(w, r, http.StatusInternalServerError, "desktop_handoff_failed", "Desktop authorization handoff failed")
	}
}

func desktopHandoffCreatePath(sessionID string) string {
	return "/api/v1/ai-executor-authorization-sessions/" + sessionID + "/desktop-handoffs"
}

func desktopHandoffClaimPath(sessionID, handoffID string) string {
	return desktopHandoffCreatePath(sessionID) + "/" + handoffID + "/claim"
}
