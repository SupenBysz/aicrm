package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/accessclient"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/shared/auth"
)

const (
	deviceChallengeRequestLimit = 8 << 10
	deviceCreateRequestLimit    = 16 << 10
	deviceHeartbeatRequestLimit = 16 << 10
	deviceLedgerExpiryMargin    = time.Hour
)

type deviceControlStore interface {
	CreateDeviceRegistrationChallenge(context.Context, store.CreateDeviceRegistrationChallengeInput) (store.CreateDeviceRegistrationChallengeResult, error)
	RegisterDevice(context.Context, store.RegisterDeviceInput) (store.RegisterDeviceResult, error)
	GetDeviceVerificationKey(context.Context, string) (store.DeviceVerificationKey, error)
	RecordDeviceHeartbeat(context.Context, store.RecordDeviceHeartbeatInput) (store.DeviceHeartbeatResult, error)
}

type deviceRegistrationActor struct {
	actorContext
	TokenExpiresAt time.Time
}

type deviceRegistrationHandler func(http.ResponseWriter, *http.Request, deviceRegistrationActor)

type registrationChallengeBody struct {
	PublicKey   string `json:"publicKey"`
	DeviceLabel string `json:"deviceLabel,omitempty"`
	AppVersion  string `json:"appVersion,omitempty"`
}

type registerDeviceBody struct {
	ChallengeID string  `json:"challengeId"`
	Challenge   string  `json:"challenge"`
	PublicKey   string  `json:"publicKey"`
	DeviceLabel *string `json:"deviceLabel"`
	AppVersion  *string `json:"appVersion"`
}

type deviceHeartbeatBody struct {
	BridgeVersion int             `json:"bridgeVersion"`
	AppVersion    string          `json:"appVersion"`
	Capabilities  map[string]bool `json:"capabilities"`
	OccurredAt    string          `json:"occurredAt"`
}

func (s *Server) registerDeviceRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/ai-executor-devices/registration-challenges", s.deviceRegistration(s.createDeviceRegistrationChallenge))
	mux.HandleFunc("POST /api/v1/ai-executor-devices", s.deviceRegistration(s.registerDevice))
	mux.HandleFunc("POST /api/v1/ai-executor-devices/{deviceId}/heartbeat", s.recordDeviceHeartbeat)
}

func (s *Server) createDeviceRegistrationChallenge(w http.ResponseWriter, r *http.Request, actor deviceRegistrationActor) {
	deviceStore, ok := s.control.(deviceControlStore)
	if !ok {
		writeError(w, r, http.StatusServiceUnavailable, "control_plane_disabled", "device trust control plane is unavailable")
		return
	}
	if !requireRawDevicePath(w, r, store.DeviceRegistrationPath+"/registration-challenges") ||
		!requireSingleExistingHeader(w, r, "Authorization") ||
		!rejectDeviceProofHeaders(w, r) {
		return
	}
	key, ok := strictIdempotencyKey(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "idempotency_key_required", "a valid Idempotency-Key is required")
		return
	}
	var body registrationChallengeBody
	raw, ok := decodeDeviceJSON(w, r, deviceChallengeRequestLimit, &body)
	if !ok {
		return
	}
	if _, err := deviceauth.ParsePublicKey(body.PublicKey); err != nil ||
		!validDeviceLabel(body.DeviceLabel) || !validOptionalDeviceAppVersion(body.AppVersion) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "device registration challenge input is invalid")
		return
	}
	requestHash := sha256Hex(raw)
	idempotencyHash := sha256Hex([]byte(key))
	candidateID := newOpaqueID("device_challenge")
	candidateChallenge := deriveRegistrationChallenge(s.cfg.DeviceChallengeSecret, candidateID)
	result, err := deviceStore.CreateDeviceRegistrationChallenge(r.Context(), store.CreateDeviceRegistrationChallengeInput{
		ID: candidateID, PublicKey: body.PublicKey,
		ActorID: actor.ActorID, WorkspaceType: actor.WorkspaceType, WorkspaceID: actor.WorkspaceID,
		ChallengeHash: sha256Hex([]byte(candidateChallenge)), RequestHash: requestHash,
		IdempotencyKeyHash: idempotencyHash, DeviceLabel: body.DeviceLabel, AppVersion: body.AppVersion,
	})
	if err != nil {
		s.writeDeviceStoreError(w, r, err)
		return
	}
	// The store may return the persisted ID from an idempotent first request.
	// Rebuilding from that ID makes the plaintext response deterministic while
	// keeping it out of PostgreSQL.
	challenge := deriveRegistrationChallenge(s.cfg.DeviceChallengeSecret, result.Challenge.ID)
	writeData(w, r, http.StatusCreated, map[string]any{
		"challengeId": result.Challenge.ID,
		"challenge":   challenge,
		"expiresAt":   result.Challenge.ExpiresAt,
		"algorithm":   "Ed25519",
	})
}

func (s *Server) registerDevice(w http.ResponseWriter, r *http.Request, actor deviceRegistrationActor) {
	deviceStore, ok := s.control.(deviceControlStore)
	if !ok {
		writeError(w, r, http.StatusServiceUnavailable, "control_plane_disabled", "device trust control plane is unavailable")
		return
	}
	if !requireRawDevicePath(w, r, store.DeviceRegistrationPath) {
		return
	}
	if len(r.Header.Values("Idempotency-Key")) != 0 {
		writeError(w, r, http.StatusBadRequest, "device_header_forbidden", "Idempotency-Key is not accepted for signed device registration")
		return
	}
	var body registerDeviceBody
	raw, ok := decodeDeviceJSON(w, r, deviceCreateRequestLimit, &body)
	if !ok {
		return
	}
	if !validOpaqueID(body.ChallengeID) || !validRegistrationChallenge(body.Challenge) ||
		body.DeviceLabel == nil || !validDeviceLabel(*body.DeviceLabel) ||
		body.AppVersion == nil || !validOptionalDeviceAppVersion(*body.AppVersion) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "device registration input is invalid")
		return
	}
	expectedChallenge := deriveRegistrationChallenge(s.cfg.DeviceChallengeSecret, body.ChallengeID)
	if !hmac.Equal([]byte(expectedChallenge), []byte(body.Challenge)) {
		writeError(w, r, http.StatusForbidden, "desktop_device_mismatch", "device registration challenge is invalid")
		return
	}
	proof, err := deviceauth.VerifyRequestForPersistentLedger(deviceauth.VerifyInput{
		PublicKey: body.PublicKey, Method: r.Method, RequestTarget: r.RequestURI,
		Headers: r.Header, Body: raw, AllowedAuthorizationSchemes: []string{"Bearer"},
	})
	if err != nil || proof.Sequence != 1 {
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "device proof is invalid")
		return
	}
	result, err := deviceStore.RegisterDevice(r.Context(), store.RegisterDeviceInput{
		ChallengeID: body.ChallengeID, ActorID: actor.ActorID,
		WorkspaceType: "platform", WorkspaceID: "platform_root",
		PublicKey: body.PublicKey, ChallengeHash: sha256Hex([]byte(body.Challenge)),
		DeviceLabel: *body.DeviceLabel, AppVersion: *body.AppVersion, Proof: proof,
		LedgerExpiresAt: ledgerExpiry(time.Now().UTC(), actor.TokenExpiresAt),
	})
	if err != nil {
		s.writeDeviceStoreError(w, r, err)
		return
	}
	writeData(w, r, http.StatusCreated, map[string]any{
		"deviceId": result.ResponseReference,
	})
}

func (s *Server) recordDeviceHeartbeat(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	ensureRequestID(r)
	if !s.cfg.WriteEnabled || s.control == nil {
		writeError(w, r, http.StatusServiceUnavailable, "control_plane_disabled", "device trust control plane is disabled")
		return
	}
	if !validDeviceChallengeSecret(s.cfg.DeviceChallengeSecret, s.cfg.AuthTokenSecret, s.cfg.InternalToken) {
		writeError(w, r, http.StatusServiceUnavailable, "device_trust_unavailable", "device trust challenge service is unavailable")
		return
	}
	deviceStore, ok := s.control.(deviceControlStore)
	if !ok {
		writeError(w, r, http.StatusServiceUnavailable, "control_plane_disabled", "device trust control plane is unavailable")
		return
	}
	deviceID := r.PathValue("deviceId")
	if deviceauth.ValidateDeviceID(deviceID) != nil {
		writeError(w, r, http.StatusBadRequest, "validation_error", "deviceId is invalid")
		return
	}
	expectedPath := store.DeviceRegistrationPath + "/" + deviceID + "/heartbeat"
	if !requireRawDevicePath(w, r, expectedPath) || !rejectDeviceOnlyForbiddenHeaders(w, r) {
		return
	}
	var body deviceHeartbeatBody
	raw, ok := decodeDeviceJSON(w, r, deviceHeartbeatRequestLimit, &body)
	if !ok {
		return
	}
	if !validHeartbeatBody(body) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "device heartbeat input is invalid")
		return
	}
	parsedHeaders, err := deviceauth.ParseProofHeaders(r.Header)
	if err != nil || parsedHeaders.DeviceID != deviceID {
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "device proof is invalid")
		return
	}
	verificationKey, err := deviceStore.GetDeviceVerificationKey(r.Context(), deviceID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrDeviceInactive) {
			writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "device proof is invalid")
			return
		}
		writeError(w, r, http.StatusInternalServerError, "internal_error", "device verification is unavailable")
		return
	}
	proof, err := deviceauth.VerifyRequestForPersistentLedger(deviceauth.VerifyInput{
		PublicKey: verificationKey.PublicKey, Method: r.Method, RequestTarget: r.RequestURI,
		Headers: r.Header, Body: raw,
	})
	if err != nil {
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "device proof is invalid")
		return
	}
	result, err := deviceStore.RecordDeviceHeartbeat(r.Context(), store.RecordDeviceHeartbeatInput{
		TargetDeviceID: deviceID, KeyGeneration: verificationKey.KeyGeneration,
		Proof: proof, AppVersion: body.AppVersion,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + deviceLedgerExpiryMargin),
	})
	if err != nil {
		s.writeDeviceHeartbeatStoreError(w, r, err)
		return
	}
	writeData(w, r, http.StatusOK, map[string]any{
		"deviceId":   deviceID,
		"sequence":   result.Sequence,
		"acceptedAt": result.AcceptedAt,
	})
}

func (s *Server) deviceRegistration(next deviceRegistrationHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		noStore(w)
		ensureRequestID(r)
		if !s.cfg.WriteEnabled || s.control == nil || s.authorizer == nil {
			writeError(w, r, http.StatusServiceUnavailable, "control_plane_disabled", "device trust control plane is disabled")
			return
		}
		if s.cfg.AuthTokenSecret == "" {
			writeError(w, r, http.StatusServiceUnavailable, "authentication_unavailable", "authentication is unavailable")
			return
		}
		if !validDeviceChallengeSecret(s.cfg.DeviceChallengeSecret, s.cfg.AuthTokenSecret, s.cfg.InternalToken) {
			writeError(w, r, http.StatusServiceUnavailable, "device_trust_unavailable", "device trust challenge service is unavailable")
			return
		}
		if r.URL.RawQuery != "" {
			writeError(w, r, http.StatusBadRequest, "validation_error", "device request path is invalid")
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
			RequiredAllPermissions: []string{"platform.ai_executors.bind_device"},
		})
		if errors.Is(err, accessclient.ErrDenied) {
			writeError(w, r, http.StatusForbidden, "permission_denied", "permission is denied")
			return
		}
		if err != nil {
			writeError(w, r, http.StatusServiceUnavailable, "authorization_unavailable", "authorization decision is unavailable")
			return
		}
		next(w, r, deviceRegistrationActor{
			actorContext: actorContext{
				ActorID: payload.UserID, SessionID: payload.SessionID, MembershipID: decision.MembershipID,
				WorkspaceType: "platform", WorkspaceID: "platform_root",
				GrantedPermissions: permissionSet(decision.GrantedRequiredPermissions),
			},
			TokenExpiresAt: time.Unix(payload.Exp, 0).UTC(),
		})
	}
}

func (s *Server) writeDeviceStoreError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrIdempotencyReuse):
		writeError(w, r, http.StatusConflict, "idempotency_key_reused", "Idempotency-Key was already used with different input")
	case errors.Is(err, store.ErrDeviceProofReplayed):
		writeError(w, r, http.StatusConflict, deviceauth.DeviceProofReplayedCode, "device proof was replayed")
	case errors.Is(err, store.ErrDeviceChallengeExpired), errors.Is(err, store.ErrDeviceChallengeConsumed), errors.Is(err, store.ErrNotFound):
		writeError(w, r, http.StatusGone, "authorization_challenge_gone", "device registration challenge is unavailable")
	case errors.Is(err, store.ErrDeviceChallengeMismatch), errors.Is(err, store.ErrDeviceMismatch):
		writeError(w, r, http.StatusForbidden, "desktop_device_mismatch", "device proof does not match the target")
	case errors.Is(err, store.ErrDeviceInactive), errors.Is(err, store.ErrDeviceKeyGenerationMismatch):
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "device proof is invalid")
	case errors.Is(err, deviceauth.ErrTimestampOutsideWindow):
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "device proof is invalid")
	case errors.Is(err, store.ErrDeviceAlreadyRegistered):
		writeError(w, r, http.StatusConflict, "conflict", "device is already registered")
	case errors.Is(err, store.ErrDeviceStoreInputInvalid), errors.Is(err, store.ErrDeviceLedgerRetentionInvalid):
		writeError(w, r, http.StatusBadRequest, "validation_error", "device request is invalid")
	default:
		writeError(w, r, http.StatusInternalServerError, "internal_error", "device trust operation failed")
	}
}

func (s *Server) writeDeviceHeartbeatStoreError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, r, http.StatusForbidden, "authorization_proof_invalid", "device proof is invalid")
		return
	}
	s.writeDeviceStoreError(w, r, err)
}

func requireRawDevicePath(w http.ResponseWriter, r *http.Request, expected string) bool {
	if r.URL.RawQuery != "" || r.RequestURI == "" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "device request path is invalid")
		return false
	}
	path, err := deviceauth.CanonicalPath(r.RequestURI)
	if err != nil || path != expected {
		writeError(w, r, http.StatusBadRequest, "validation_error", "device request path is invalid")
		return false
	}
	return true
}

func decodeDeviceJSON(w http.ResponseWriter, r *http.Request, limit int64, target any) ([]byte, bool) {
	contentType, contentTypeOK := strictSingleHeader(r.Header, "Content-Type")
	if !contentTypeOK || len(r.Header.Values("Content-Encoding")) != 0 || !validJSONContentType(contentType) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "Content-Type must be application/json without content encoding")
		return nil, false
	}
	if r.ContentLength > limit {
		writeError(w, r, http.StatusRequestEntityTooLarge, "validation_error", "request body is too large")
		return nil, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, r, http.StatusRequestEntityTooLarge, "validation_error", "request body is too large")
		} else {
			writeError(w, r, http.StatusBadRequest, "validation_error", "request body is invalid")
		}
		return nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := validateNoDuplicateJSONKeys(raw); err != nil {
		writeError(w, r, http.StatusBadRequest, "validation_error", "request JSON contains duplicate fields")
		return nil, false
	}
	if err := decoder.Decode(target); err != nil {
		writeError(w, r, http.StatusBadRequest, "validation_error", "request JSON is invalid")
		return nil, false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, r, http.StatusBadRequest, "validation_error", "request must contain one JSON object")
		return nil, false
	}
	return raw, true
}

func validateNoDuplicateJSONKeys(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := consumeUniqueJSONValue(decoder, 0); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("trailing JSON value")
	}
	return nil
}

func consumeUniqueJSONValue(decoder *json.Decoder, depth int) error {
	if depth > 32 {
		return errors.New("JSON nesting is too deep")
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		seen := map[string]struct{}{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("JSON object key is invalid")
			}
			if _, duplicate := seen[key]; duplicate {
				return errors.New("duplicate JSON object key")
			}
			seen[key] = struct{}{}
			if err := consumeUniqueJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim('}') {
			return errors.New("JSON object is not closed")
		}
	case '[':
		for decoder.More() {
			if err := consumeUniqueJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim(']') {
			return errors.New("JSON array is not closed")
		}
	default:
		return errors.New("unexpected JSON delimiter")
	}
	return nil
}

func validJSONContentType(value string) bool {
	mediaType, parameters, err := mime.ParseMediaType(value)
	if err != nil || mediaType != "application/json" {
		return false
	}
	for key, parameter := range parameters {
		if !strings.EqualFold(key, "charset") || !strings.EqualFold(parameter, "utf-8") {
			return false
		}
	}
	return true
}

func strictIdempotencyKey(r *http.Request) (string, bool) {
	value, ok := strictSingleHeader(r.Header, "Idempotency-Key")
	return value, ok && idempotencyKeyPattern.MatchString(value)
}

func strictSingleHeader(headers http.Header, name string) (string, bool) {
	values := headers.Values(name)
	returnValue := ""
	if len(values) == 1 {
		returnValue = values[0]
	}
	return returnValue, len(values) == 1 && returnValue != "" && strings.TrimSpace(returnValue) == returnValue
}

func requireSingleExistingHeader(w http.ResponseWriter, r *http.Request, name string) bool {
	if _, ok := strictSingleHeader(r.Header, name); !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "required request header is invalid")
		return false
	}
	return true
}

func rejectDeviceProofHeaders(w http.ResponseWriter, r *http.Request) bool {
	for _, name := range []string{
		deviceauth.HeaderDeviceID, deviceauth.HeaderTimestamp, deviceauth.HeaderNonce,
		deviceauth.HeaderSequence, deviceauth.HeaderContentSHA256, deviceauth.HeaderSignature,
	} {
		if len(r.Header.Values(name)) != 0 {
			writeError(w, r, http.StatusBadRequest, "validation_error", "device proof headers are not accepted for this endpoint")
			return false
		}
	}
	return true
}

func rejectDeviceOnlyForbiddenHeaders(w http.ResponseWriter, r *http.Request) bool {
	for _, name := range []string{"Authorization", "X-KY-Workspace-Type", "X-KY-Workspace-Id", "Idempotency-Key"} {
		if len(r.Header.Values(name)) != 0 {
			writeError(w, r, http.StatusBadRequest, "device_header_forbidden", "user authorization and workspace headers are forbidden")
			return false
		}
	}
	return true
}

func deriveRegistrationChallenge(secret, challengeID string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(strings.Join([]string{
		"AICRM-DEVICE-REGISTRATION-CHALLENGE-V1",
		challengeID,
	}, "\n")))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func validDeviceChallengeSecret(secret, authSecret, internalToken string) bool {
	return len(secret) >= 32 && secret != authSecret && secret != internalToken
}

func validRegistrationChallenge(value string) bool {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(raw) == sha256.Size && base64.RawURLEncoding.EncodeToString(raw) == value
}

func validDeviceLabel(value string) bool {
	if !utf8.ValidString(value) || len(value) > 120 {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}

func validDeviceAppVersion(value string) bool {
	return value != "" && validOptionalDeviceAppVersion(value)
}

func validOptionalDeviceAppVersion(value string) bool {
	if len(value) > 64 || strings.TrimSpace(value) != value {
		return false
	}
	for index := 0; index < len(value); index++ {
		if value[index] < 0x21 || value[index] > 0x7e {
			return false
		}
	}
	return true
}

func validHeartbeatBody(body deviceHeartbeatBody) bool {
	if body.BridgeVersion < 2 || body.BridgeVersion > 100 || !validDeviceAppVersion(body.AppVersion) ||
		len(body.Capabilities) == 0 || len(body.Capabilities) > 32 {
		return false
	}
	for name := range body.Capabilities {
		if name == "" || len(name) > 64 || !opaqueIDPattern.MatchString(name) || forbiddenSafeKey(name) {
			return false
		}
	}
	_, err := time.Parse(time.RFC3339Nano, body.OccurredAt)
	return err == nil
}

func ledgerExpiry(now, tokenExpiresAt time.Time) time.Time {
	expiresAt := now.Add(store.DeviceLedgerAuditRetention + deviceLedgerExpiryMargin)
	minimum := tokenExpiresAt.Add(deviceauth.ClockWindow)
	if minimum.After(expiresAt) {
		return minimum
	}
	return expiresAt
}
