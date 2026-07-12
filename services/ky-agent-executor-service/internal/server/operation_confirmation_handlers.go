package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/accessclient"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/operationconfirmation"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/shared/auth"
)

const (
	operationConfirmationPath              = "/api/v1/ai-executor-operation-confirmations"
	operationConfirmationRequestLimit      = 8 << 10
	operationConfirmationMaxAuthAgeSeconds = 600
	permissionOperationConfirmationForce   = "platform.ai_executors.force_revoke"
	permissionOperationConfirmationRebind  = "platform.ai_executors.rebind_device"
)

var operationConfirmationDeviceIDPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type operationConfirmationRuntime interface {
	Create(context.Context, operationconfirmation.CreateInput) (operationconfirmation.CreateResult, error)
	Confirm(context.Context, operationconfirmation.ConfirmInput) (operationconfirmation.ConfirmResult, error)
}

// operationConfirmationActionResolver is intentionally separate from the
// mutation interface: confirm must resolve the persisted action bound to the
// same actor/session before asking Membership for action-specific assurance.
type operationConfirmationActionResolver interface {
	ResolveOperationConfirmationAction(context.Context, string, string, string) (string, error)
}

type operationConfirmationActor struct {
	ActorID   string
	SessionID string
}

type operationConfirmationHandler func(http.ResponseWriter, *http.Request, operationConfirmationActor)

type createOperationConfirmationBody struct {
	Action           string          `json:"action"`
	ExecutorID       string          `json:"executorId"`
	ExpectedRevision int64           `json:"expectedRevision"`
	TargetDeviceID   json.RawMessage `json:"targetDeviceId"`
}

type confirmOperationConfirmationBody struct {
	ChallengeText string `json:"challengeText"`
}

type operationConfirmationAssurance struct {
	OwnerVerified        bool
	LoginAuthenticatedAt time.Time
	MFARequired          bool
	MFAVerified          bool
}

var (
	errOperationConfirmationAssuranceDenied  = errors.New("operation confirmation assurance denied")
	errOperationConfirmationAssuranceInvalid = errors.New("operation confirmation assurance invalid")
)

func (s *Server) registerOperationConfirmationRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST "+operationConfirmationPath,
		s.operationConfirmation(s.createOperationConfirmation))
	mux.HandleFunc("POST "+operationConfirmationPath+"/{confirmationId}/confirm",
		s.operationConfirmation(s.confirmOperationConfirmation))
}

func (s *Server) createOperationConfirmation(
	w http.ResponseWriter,
	r *http.Request,
	actor operationConfirmationActor,
) {
	if !requireRawOperationConfirmationPath(w, r, operationConfirmationPath) ||
		!rejectDeviceProofHeaders(w, r) {
		return
	}
	idempotencyKey, ok := strictIdempotencyKey(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "idempotency_key_required", "a valid Idempotency-Key is required")
		return
	}
	var body createOperationConfirmationBody
	raw, ok := decodeDeviceJSON(w, r, operationConfirmationRequestLimit, &body)
	if !ok {
		return
	}
	targetDeviceID, permission, ok := validateOperationConfirmationCreateBody(body)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "operation confirmation input is invalid")
		return
	}
	assurance, err := s.operationConfirmationAssurance(r, actor, permission)
	if err != nil {
		s.writeOperationConfirmationAssuranceError(w, r, err)
		return
	}
	result, err := s.confirmationRuntime.Create(r.Context(), operationconfirmation.CreateInput{
		Action: body.Action, ExecutorID: body.ExecutorID,
		ActorID: actor.ActorID, ActorSessionID: actor.SessionID,
		ExpectedRevision: body.ExpectedRevision, TargetDeviceID: targetDeviceID,
		OwnerVerified: assurance.OwnerVerified, LoginAuthenticatedAt: assurance.LoginAuthenticatedAt,
		MFARequired: assurance.MFARequired, MFAVerified: assurance.MFAVerified,
		IdempotencyKeyHash: sha256Hex([]byte(idempotencyKey)), RequestHash: sha256Hex(raw),
	})
	if err != nil {
		s.writeOperationConfirmationError(w, r, err)
		return
	}
	writeData(w, r, http.StatusCreated, map[string]any{
		"confirmationId": result.ConfirmationID,
		"challengeText":  result.ChallengeText,
		"expiresAt":      result.ExpiresAt,
	})
}

func (s *Server) confirmOperationConfirmation(
	w http.ResponseWriter,
	r *http.Request,
	actor operationConfirmationActor,
) {
	confirmationID := r.PathValue("confirmationId")
	if !validOpaqueID(confirmationID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "confirmationId is invalid")
		return
	}
	expectedPath := operationConfirmationPath + "/" + confirmationID + "/confirm"
	if !requireRawOperationConfirmationPath(w, r, expectedPath) ||
		!rejectDeviceProofHeaders(w, r) {
		return
	}
	if len(r.Header.Values("Idempotency-Key")) != 0 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "Idempotency-Key is not accepted for confirmation")
		return
	}
	var body confirmOperationConfirmationBody
	if _, ok := decodeDeviceJSON(w, r, operationConfirmationRequestLimit, &body); !ok {
		return
	}
	if body.ChallengeText == "" || len(body.ChallengeText) > 128 || strings.TrimSpace(body.ChallengeText) != body.ChallengeText {
		writeError(w, r, http.StatusBadRequest, "validation_error", "operation confirmation challenge is invalid")
		return
	}
	resolver, ok := s.confirmationRuntime.(operationConfirmationActionResolver)
	if !ok {
		writeError(w, r, http.StatusServiceUnavailable, "operation_confirmation_unavailable", "operation confirmation is unavailable")
		return
	}
	action, err := resolver.ResolveOperationConfirmationAction(r.Context(), confirmationID, actor.ActorID, actor.SessionID)
	if err != nil {
		s.writeOperationConfirmationError(w, r, err)
		return
	}
	permission, ok := operationConfirmationPermission(action)
	if !ok {
		writeError(w, r, http.StatusServiceUnavailable, "operation_confirmation_unavailable", "operation confirmation action is invalid")
		return
	}
	assurance, err := s.operationConfirmationAssurance(r, actor, permission)
	if err != nil {
		s.writeOperationConfirmationAssuranceError(w, r, err)
		return
	}
	result, err := s.confirmationRuntime.Confirm(r.Context(), operationconfirmation.ConfirmInput{
		ConfirmationID: confirmationID, ActorID: actor.ActorID, ActorSessionID: actor.SessionID,
		ChallengeText: body.ChallengeText,
		OwnerVerified: assurance.OwnerVerified, LoginAuthenticatedAt: assurance.LoginAuthenticatedAt,
		MFARequired: assurance.MFARequired, MFAVerified: assurance.MFAVerified,
	})
	if err != nil {
		s.writeOperationConfirmationError(w, r, err)
		return
	}
	writeData(w, r, http.StatusOK, map[string]any{
		"confirmationToken": result.ConfirmationToken,
		"expiresAt":         result.ExpiresAt,
	})
}

func (s *Server) operationConfirmation(next operationConfirmationHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		noStore(w)
		ensureRequestID(r)
		if !s.cfg.WriteEnabled || s.control == nil || s.authorizer == nil || !operationConfirmationRuntimeReady(s.confirmationRuntime) {
			writeError(w, r, http.StatusServiceUnavailable, "operation_confirmation_unavailable", "operation confirmation is unavailable")
			return
		}
		if s.cfg.AuthTokenSecret == "" {
			writeError(w, r, http.StatusServiceUnavailable, "authentication_unavailable", "authentication is unavailable")
			return
		}
		if r.URL.RawQuery != "" {
			writeError(w, r, http.StatusBadRequest, "validation_error", "query parameters are not accepted")
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
		next(w, r, operationConfirmationActor{ActorID: payload.UserID, SessionID: payload.SessionID})
	}
}

func (s *Server) operationConfirmationAssurance(
	r *http.Request,
	actor operationConfirmationActor,
	permission string,
) (operationConfirmationAssurance, error) {
	decision, err := s.authorizer.Evaluate(r.Context(), requestID(r), accessclient.Request{
		ActorID: actor.ActorID, SessionID: actor.SessionID,
		WorkspaceType: "platform", WorkspaceID: "platform_root",
		RequiredAllPermissions: []string{permission},
		Assurance: &accessclient.AssuranceRequirements{
			RequireWorkspaceOwner: true, MaxAuthenticationAgeSeconds: operationConfirmationMaxAuthAgeSeconds,
			RequireMFAIfEnabled: true,
		},
	})
	if errors.Is(err, accessclient.ErrDenied) {
		return operationConfirmationAssurance{}, errOperationConfirmationAssuranceDenied
	}
	if err != nil {
		return operationConfirmationAssurance{}, errOperationConfirmationAssuranceInvalid
	}
	if !decision.Allowed || decision.ActorID != actor.ActorID || decision.WorkspaceType != "platform" ||
		decision.WorkspaceID != "platform_root" || !containsExact(decision.GrantedRequiredPermissions, permission) {
		return operationConfirmationAssurance{}, errOperationConfirmationAssuranceDenied
	}
	facts := decision.Assurance
	if facts == nil || !facts.Verified || facts.AuthenticatedAt == "" {
		return operationConfirmationAssurance{}, errOperationConfirmationAssuranceInvalid
	}
	authenticatedAt, err := time.Parse(time.RFC3339Nano, facts.AuthenticatedAt)
	if err != nil || authenticatedAt.IsZero() {
		return operationConfirmationAssurance{}, errOperationConfirmationAssuranceInvalid
	}
	authenticatedAt = authenticatedAt.UTC()
	if !facts.WorkspaceOwner || (facts.MFARequired && !facts.MFAVerified) {
		return operationConfirmationAssurance{}, errOperationConfirmationAssuranceDenied
	}
	return operationConfirmationAssurance{
		OwnerVerified: facts.WorkspaceOwner, LoginAuthenticatedAt: authenticatedAt,
		MFARequired: facts.MFARequired, MFAVerified: facts.MFAVerified,
	}, nil
}

func operationConfirmationRuntimeReady(runtime operationConfirmationRuntime) bool {
	if runtime == nil {
		return false
	}
	_, ok := runtime.(operationConfirmationActionResolver)
	return ok
}

func validateOperationConfirmationCreateBody(body createOperationConfirmationBody) (string, string, bool) {
	if !validOpaqueID(body.ExecutorID) || body.ExpectedRevision <= 0 {
		return "", "", false
	}
	permission, ok := operationConfirmationPermission(body.Action)
	if !ok {
		return "", "", false
	}
	switch body.Action {
	case store.OperationConfirmationRebindDevice:
		if len(body.TargetDeviceID) == 0 {
			return "", "", false
		}
		var targetDeviceID string
		if json.Unmarshal(body.TargetDeviceID, &targetDeviceID) != nil ||
			!operationConfirmationDeviceIDPattern.MatchString(targetDeviceID) {
			return "", "", false
		}
		return targetDeviceID, permission, true
	case store.OperationConfirmationForceRevoke, store.OperationConfirmationUnbindDevice:
		if len(body.TargetDeviceID) != 0 {
			return "", "", false
		}
		return "", permission, true
	default:
		return "", "", false
	}
}

func operationConfirmationPermission(action string) (string, bool) {
	switch action {
	case store.OperationConfirmationForceRevoke:
		return permissionOperationConfirmationForce, true
	case store.OperationConfirmationRebindDevice, store.OperationConfirmationUnbindDevice:
		return permissionOperationConfirmationRebind, true
	default:
		return "", false
	}
}

func requireRawOperationConfirmationPath(w http.ResponseWriter, r *http.Request, expected string) bool {
	if r.URL.RawQuery != "" || r.RequestURI == "" || r.RequestURI != expected {
		writeError(w, r, http.StatusBadRequest, "validation_error", "operation confirmation path is invalid")
		return false
	}
	return true
}

func containsExact(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func (s *Server) writeOperationConfirmationAssuranceError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, errOperationConfirmationAssuranceDenied) {
		writeError(w, r, http.StatusForbidden, "operation_confirmation_assurance_required", "fresh owner assurance is required")
		return
	}
	writeError(w, r, http.StatusServiceUnavailable, "authorization_unavailable", "trusted assurance is unavailable")
}

func (s *Server) writeOperationConfirmationError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, operationconfirmation.ErrInvalidInput), errors.Is(err, store.ErrOperationConfirmationInputInvalid):
		writeError(w, r, http.StatusBadRequest, "validation_error", "operation confirmation input is invalid")
	case errors.Is(err, store.ErrOperationConfirmationOwnerRequired),
		errors.Is(err, store.ErrOperationConfirmationFreshLogin),
		errors.Is(err, store.ErrOperationConfirmationMFARequired):
		writeError(w, r, http.StatusForbidden, "operation_confirmation_assurance_required", "fresh owner assurance is required")
	case errors.Is(err, store.ErrOperationConfirmationTargetMismatch),
		errors.Is(err, store.ErrOperationConfirmationChallengeInvalid):
		writeError(w, r, http.StatusForbidden, "operation_confirmation_mismatch", "operation confirmation does not match")
	case errors.Is(err, store.ErrIdempotencyReuse):
		writeError(w, r, http.StatusConflict, "idempotency_key_reused", "Idempotency-Key was already used with different input")
	case errors.Is(err, store.ErrRevisionConflict):
		writeError(w, r, http.StatusConflict, "revision_conflict", "executor device binding revision changed")
	case errors.Is(err, store.ErrConflict),
		errors.Is(err, store.ErrOperationConfirmationChallengeUsed),
		errors.Is(err, store.ErrOperationConfirmationTokenConsumed):
		writeError(w, r, http.StatusConflict, "operation_confirmation_conflict", "operation confirmation is already used")
	case errors.Is(err, store.ErrNotFound),
		errors.Is(err, store.ErrDeviceInactive),
		errors.Is(err, store.ErrOperationConfirmationChallengeExpired),
		errors.Is(err, store.ErrOperationConfirmationTokenExpired):
		writeError(w, r, http.StatusGone, "operation_confirmation_gone", "operation confirmation is unavailable")
	case errors.Is(err, operationconfirmation.ErrInvalidConfiguration),
		errors.Is(err, operationconfirmation.ErrChallengeSecret):
		writeError(w, r, http.StatusServiceUnavailable, "operation_confirmation_unavailable", "operation confirmation is unavailable")
	default:
		writeError(w, r, http.StatusServiceUnavailable, "operation_confirmation_unavailable", "operation confirmation is unavailable")
	}
}
