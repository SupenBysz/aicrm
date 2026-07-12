package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/accessclient"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/authorization"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/desktopcommand"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
)

var (
	authorizationStreamPollInterval      = time.Second
	authorizationStreamHeartbeatInterval = 15 * time.Second
)

type createAuthorizationBody struct {
	Intent string `json:"intent"`
}

type authorizationExpectedRevisionBody struct {
	ExpectedSessionRevision int64 `json:"expectedSessionRevision"`
}

func (s *Server) createAuthorizationSession(w http.ResponseWriter, r *http.Request, actor actorContext) {
	executorID := r.PathValue("executorId")
	if !validOpaqueID(executorID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "executorId is invalid")
		return
	}
	key, ok := idempotencyKey(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "idempotency_key_required", "a valid Idempotency-Key is required")
		return
	}
	var body createAuthorizationBody
	if !decodeStrictJSON(w, r, &body) {
		return
	}
	body.Intent = strings.TrimSpace(body.Intent)
	requiredPermission := "platform.ai_executors.authorize"
	if body.Intent == "change_account" {
		requiredPermission = "platform.ai_executors.change_account"
	} else if body.Intent != "authorize" {
		writeError(w, r, http.StatusBadRequest, "validation_error", "authorization intent is invalid")
		return
	}
	if !actor.GrantedPermissions[requiredPermission] {
		writeError(w, r, http.StatusForbidden, "permission_denied", "permission is denied")
		return
	}
	canonical, _ := json.Marshal(body)
	input := store.CreateAuthorizationSessionInput{
		ID: newOpaqueID("auth_session"), ExecutorID: executorID, Intent: body.Intent,
		ActorID: actor.ActorID, IdempotencyKeyHash: sha256Hex([]byte(key)),
		RequestHash: sha256Hex(canonical), Deadline: time.Now().UTC().Add(10 * time.Minute),
	}
	result, err := s.control.CreateAuthorizationSession(r.Context(), input)
	if errors.Is(err, store.ErrConflict) {
		result, err = s.control.CreateAuthorizationSession(r.Context(), input)
	}
	if err != nil {
		s.writeAuthorizationStoreError(w, r, err)
		return
	}
	if result.Created && result.Session.RuntimeType == "server" {
		if s.authRuntime == nil {
			_, _ = s.control.FailAuthorizationSession(r.Context(), result.Session.ID, s.cfg.OwnerInstanceID, "failed", "executor_app_server_unavailable")
			writeError(w, r, http.StatusServiceUnavailable, "executor_app_server_unavailable", "server authorization runtime is unavailable")
			return
		}
		if err := s.authRuntime.Start(result.Session); err != nil {
			_, _ = s.control.FailAuthorizationSession(r.Context(), result.Session.ID, s.cfg.OwnerInstanceID, "failed", "executor_app_server_unavailable")
			writeError(w, r, http.StatusServiceUnavailable, "executor_app_server_unavailable", "server authorization runtime could not start")
			return
		}
	}
	status := http.StatusCreated
	if !result.Created {
		status = http.StatusOK
	}
	writeData(w, r, status, result.Session)
}

func (s *Server) getCurrentAuthorizationSession(w http.ResponseWriter, r *http.Request, _ actorContext) {
	executorID := r.PathValue("executorId")
	if !validOpaqueID(executorID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "executorId is invalid")
		return
	}
	item, err := s.control.GetCurrentAuthorizationSession(r.Context(), executorID)
	if err != nil {
		s.writeAuthorizationStoreError(w, r, err)
		return
	}
	writeData(w, r, http.StatusOK, item)
}

func (s *Server) getAuthorizationSession(w http.ResponseWriter, r *http.Request, _ actorContext) {
	item, ok := s.authorizationSessionFromPath(w, r)
	if !ok {
		return
	}
	writeData(w, r, http.StatusOK, item)
}

func (s *Server) getAuthorizationUserAction(w http.ResponseWriter, r *http.Request, actor actorContext) {
	w.Header().Set("Referrer-Policy", "no-referrer")
	item, ok := s.authorizationSessionFromPath(w, r)
	if !ok {
		return
	}
	if item.FlowType != "device_code" || item.RuntimeType != "server" {
		writeError(w, r, http.StatusConflict, "authorization_user_action_not_server_managed", "authorization is not server managed")
		return
	}
	if item.RequestedBy != actor.ActorID {
		writeError(w, r, http.StatusForbidden, "permission_denied", "only the authorization requester may view the challenge")
		return
	}
	if item.Status != "waiting_user" || s.authRuntime == nil {
		writeError(w, r, http.StatusGone, "authorization_challenge_gone", "authorization challenge is no longer available")
		return
	}
	action, err := s.authRuntime.UserAction(item.ID, actor.ActorID)
	if err != nil {
		s.writeAuthorizationRuntimeError(w, r, err)
		return
	}
	writeData(w, r, http.StatusOK, action)
}

func (s *Server) reopenAuthorizationSession(w http.ResponseWriter, r *http.Request, actor actorContext) {
	w.Header().Set("Referrer-Policy", "no-referrer")
	sessionID := r.PathValue("sessionId")
	if !validOpaqueID(sessionID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "sessionId is invalid")
		return
	}
	if !requireRawDevicePath(w, r, authorizationSessionActionPath(sessionID, "reopen")) ||
		!requireStrictDesktopHandoffUserHeaders(w, r) || !rejectDeviceProofHeaders(w, r) {
		return
	}
	key, ok := strictIdempotencyKey(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "idempotency_key_required", "a valid Idempotency-Key is required")
		return
	}
	var body authorizationExpectedRevisionBody
	if _, ok := decodeDeviceJSON(w, r, desktopAuthorizationCommandRequestLimit, &body); !ok {
		return
	}
	if body.ExpectedSessionRevision < 1 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "reopen request is invalid")
		return
	}
	item, ok := s.authorizationSessionFromPath(w, r)
	if !ok {
		return
	}
	if item.Revision != body.ExpectedSessionRevision {
		s.writeAuthorizationStoreError(w, r, store.ErrRevisionConflict)
		return
	}
	if item.RequestedBy != actor.ActorID {
		writeError(w, r, http.StatusForbidden, "permission_denied", "only the authorization requester may reopen the challenge")
		return
	}
	canonical, _ := json.Marshal(body)
	if item.RuntimeType == "desktop" && item.FlowType == "browser" {
		if s.desktopCommandRuntime == nil {
			writeError(w, r, http.StatusServiceUnavailable, "desktop_command_unavailable", "Desktop command is unavailable")
			return
		}
		result, err := s.desktopCommandRuntime.Reopen(r.Context(), desktopcommand.CreateInput{
			SessionID: item.ID, ActorID: actor.ActorID, ActorSessionID: actor.SessionID,
			ExpectedSessionRevision: body.ExpectedSessionRevision,
			IdempotencyKeyHash:      sha256Hex([]byte(key)), RequestHash: sha256Hex(canonical),
		})
		if err != nil {
			s.writeDesktopAuthorizationCommandError(w, r, err, false)
			return
		}
		writeDesktopAuthorizationCommandCreateResult(w, r, result)
		return
	}
	if item.RuntimeType != "server" || item.FlowType != "device_code" {
		writeError(w, r, http.StatusConflict, "authorization_user_action_not_server_managed", "authorization is not server managed")
		return
	}
	if err := s.control.RecordAuthorizationReopen(r.Context(), item.ID, actor.ActorID, sha256Hex([]byte(key)), sha256Hex(canonical)); err != nil {
		s.writeAuthorizationStoreError(w, r, err)
		return
	}
	if s.authRuntime == nil {
		writeError(w, r, http.StatusServiceUnavailable, "executor_app_server_unavailable", "authorization runtime is unavailable")
		return
	}
	action, err := s.authRuntime.UserAction(item.ID, actor.ActorID)
	if err != nil {
		s.writeAuthorizationRuntimeError(w, r, err)
		return
	}
	writeData(w, r, http.StatusOK, action)
}

func (s *Server) cancelAuthorizationSession(w http.ResponseWriter, r *http.Request, actor actorContext) {
	w.Header().Set("Referrer-Policy", "no-referrer")
	sessionID := r.PathValue("sessionId")
	if !validOpaqueID(sessionID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "sessionId is invalid")
		return
	}
	if !requireRawDevicePath(w, r, authorizationSessionActionPath(sessionID, "cancel")) ||
		!requireStrictDesktopHandoffUserHeaders(w, r) || !rejectDeviceProofHeaders(w, r) {
		return
	}
	key, ok := strictIdempotencyKey(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "idempotency_key_required", "a valid Idempotency-Key is required")
		return
	}
	var body authorizationExpectedRevisionBody
	if _, ok := decodeDeviceJSON(w, r, desktopAuthorizationCommandRequestLimit, &body); !ok {
		return
	}
	if body.ExpectedSessionRevision < 1 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "cancel request is invalid")
		return
	}
	canonical, _ := json.Marshal(body)
	current, ok := s.authorizationSessionFromPath(w, r)
	if !ok {
		return
	}
	if current.RuntimeType == "desktop" && current.FlowType == "browser" {
		if s.desktopCommandRuntime == nil {
			writeError(w, r, http.StatusServiceUnavailable, "desktop_command_unavailable", "Desktop command is unavailable")
			return
		}
		result, err := s.desktopCommandRuntime.Cancel(r.Context(), desktopcommand.CreateInput{
			SessionID: sessionID, ActorID: actor.ActorID, ActorSessionID: actor.SessionID,
			ExpectedSessionRevision: body.ExpectedSessionRevision,
			IdempotencyKeyHash:      sha256Hex([]byte(key)), RequestHash: sha256Hex(canonical),
			CanCancelAny: actor.GrantedPermissions["platform.ai_executors.force_revoke"],
		})
		if err != nil {
			s.writeDesktopAuthorizationCommandError(w, r, err, false)
			return
		}
		writeDesktopAuthorizationCommandCreateResult(w, r, result)
		return
	}
	item, transitioned, err := s.control.CancelAuthorizationSession(r.Context(), store.CancelAuthorizationInput{
		SessionID: sessionID, ActorID: actor.ActorID, ExpectedRevision: body.ExpectedSessionRevision,
		IdempotencyKeyHash: sha256Hex([]byte(key)), RequestHash: sha256Hex(canonical),
		CanCancelAny: actor.GrantedPermissions["platform.ai_executors.force_revoke"],
	})
	if err != nil {
		s.writeAuthorizationStoreError(w, r, err)
		return
	}
	if transitioned && s.authRuntime != nil {
		s.authRuntime.Cancel(sessionID)
	}
	writeData(w, r, http.StatusOK, item)
}

func authorizationSessionActionPath(sessionID, action string) string {
	return "/api/v1/ai-executor-authorization-sessions/" + sessionID + "/" + action
}

func (s *Server) listAuthorizationSessionEvents(w http.ResponseWriter, r *http.Request, _ actorContext) {
	sessionID := r.PathValue("sessionId")
	if !validOpaqueID(sessionID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "sessionId is invalid")
		return
	}
	after, limit, ok := authorizationCursor(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "invalid_event_cursor", "event cursor is invalid")
		return
	}
	session, err := s.control.GetAuthorizationSession(r.Context(), sessionID)
	if err != nil {
		s.writeAuthorizationStoreError(w, r, err)
		return
	}
	items, err := s.control.ListAuthorizationEvents(r.Context(), sessionID, after, limit+1)
	if err != nil {
		s.writeAuthorizationStoreError(w, r, err)
		return
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	nextSequence := after
	if len(items) > 0 {
		nextSequence = items[len(items)-1].Sequence
	}
	historyItems := make([]map[string]any, 0, len(items))
	for _, item := range items {
		historyItems = append(historyItems, map[string]any{
			"sequence": item.Sequence, "event": item.EventType,
			"occurredAt": item.OccurredAt,
			"data":       authorizationEventData(sessionID, item, session),
		})
	}
	writeData(w, r, http.StatusOK, map[string]any{
		"items": historyItems, "nextSequence": nextSequence, "hasMore": hasMore,
	})
}

func (s *Server) streamAuthorizationSessionEvents(w http.ResponseWriter, r *http.Request, actor actorContext) {
	sessionID := r.PathValue("sessionId")
	if !validOpaqueID(sessionID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "sessionId is invalid")
		return
	}
	after, _, queryCursorOK := authorizationCursor(r)
	ok := queryCursorOK
	lastEventIDs := r.Header.Values("Last-Event-ID")
	if len(lastEventIDs) > 0 {
		ok = true
		if len(lastEventIDs) != 1 {
			ok = false
		} else {
			last := strings.TrimSpace(lastEventIDs[0])
			parsed, err := strconv.ParseInt(last, 10, 64)
			if err != nil || parsed < 0 || last == "" {
				ok = false
			} else {
				after = parsed
			}
		}
	}
	if !ok {
		writeError(w, r, http.StatusBadRequest, "invalid_event_cursor", "event cursor is invalid")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, r, http.StatusNotImplemented, "stream_unavailable", "event stream is unavailable")
		return
	}
	session, err := s.control.GetAuthorizationSession(r.Context(), sessionID)
	if err != nil {
		s.writeAuthorizationStoreError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	poll := time.NewTicker(authorizationStreamPollInterval)
	defer poll.Stop()
	heartbeat := time.NewTicker(authorizationStreamHeartbeatInterval)
	defer heartbeat.Stop()
	cursor := after
	for {
		for {
			items, err := s.control.ListAuthorizationEvents(r.Context(), sessionID, cursor, 100)
			if err != nil {
				return
			}
			session, err = s.control.GetAuthorizationSession(r.Context(), sessionID)
			if err != nil {
				return
			}
			for _, item := range items {
				encoded, err := json.Marshal(authorizationEventData(sessionID, item, session))
				if err != nil {
					return
				}
				if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", item.Sequence, item.EventType, encoded); err != nil {
					return
				}
				cursor = item.Sequence
			}
			if len(items) > 0 {
				flusher.Flush()
			}
			if len(items) < 100 {
				break
			}
		}
		if terminalAuthorizationStatus(session.Status) && cursor >= session.Sequence {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-poll.C:
		case <-heartbeat.C:
			if !s.authorizationStreamPermissionValid(r, actor) {
				writeConnectionClosed(w, store.AuthorizationEventClosed, "sessionId", sessionID, "permission_revoked")
				flusher.Flush()
				return
			}
			if _, err := fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *Server) authorizationStreamPermissionValid(r *http.Request, actor actorContext) bool {
	if s.authorizer == nil {
		return false
	}
	_, err := s.authorizer.Evaluate(r.Context(), requestID(r), accessclient.Request{
		ActorID: actor.ActorID, SessionID: actor.SessionID,
		WorkspaceType: actor.WorkspaceType, WorkspaceID: actor.WorkspaceID,
		RequiredAllPermissions: []string{"platform.ai_executors.view"},
	})
	return err == nil
}

func authorizationEventData(sessionID string, item store.AuthorizationEventProjection, session store.AuthorizationSessionProjection) map[string]any {
	if item.EventType == store.AuthorizationEventClosed {
		return map[string]any{
			"sessionId": sessionID, "sequence": item.Sequence, "reason": "terminal",
		}
	}
	var persisted struct {
		Session store.AuthorizationSessionProjection `json:"session"`
	}
	if json.Unmarshal(item.SafePayload, &persisted) == nil && persisted.Session.ID == sessionID {
		session = persisted.Session
	}
	return map[string]any{
		"sessionId": sessionID, "sequence": item.Sequence,
		"occurredAt": item.OccurredAt, "session": session,
	}
}

func (s *Server) authorizationSessionFromPath(w http.ResponseWriter, r *http.Request) (store.AuthorizationSessionProjection, bool) {
	sessionID := r.PathValue("sessionId")
	if !validOpaqueID(sessionID) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "sessionId is invalid")
		return store.AuthorizationSessionProjection{}, false
	}
	item, err := s.control.GetAuthorizationSession(r.Context(), sessionID)
	if err != nil {
		s.writeAuthorizationStoreError(w, r, err)
		return store.AuthorizationSessionProjection{}, false
	}
	return item, true
}

func authorizationCursor(r *http.Request) (int64, int, bool) {
	after, limit := int64(0), 100
	var err error
	if value := r.URL.Query().Get("after"); value != "" {
		after, err = strconv.ParseInt(value, 10, 64)
		if err != nil || after < 0 {
			return 0, 0, false
		}
	}
	if value := r.URL.Query().Get("limit"); value != "" {
		limit, err = strconv.Atoi(value)
		if err != nil || limit < 1 || limit > 200 {
			return 0, 0, false
		}
	}
	return after, limit, true
}

func terminalAuthorizationStatus(status string) bool {
	switch status {
	case "succeeded", "failed", "cancelled", "expired", "interrupted", "superseded":
		return true
	default:
		return false
	}
}

func (s *Server) writeAuthorizationStoreError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, r, http.StatusNotFound, "not_found", "authorization resource was not found")
	case errors.Is(err, store.ErrAuthorizationConflict):
		writeError(w, r, http.StatusConflict, "authorization_session_conflict", "another authorization session is active")
	case errors.Is(err, store.ErrRevisionConflict):
		writeError(w, r, http.StatusConflict, "revision_conflict", "authorization session revision changed")
	case errors.Is(err, store.ErrRequesterMismatch):
		writeError(w, r, http.StatusForbidden, "permission_denied", "only the requester or platform owner may cancel authorization")
	case errors.Is(err, store.ErrIdempotencyReuse):
		writeError(w, r, http.StatusConflict, "idempotency_key_reused", "Idempotency-Key was reused with another request")
	case errors.Is(err, store.ErrExecutorBusy):
		writeError(w, r, http.StatusConflict, "executor_has_active_tasks", "executor is busy")
	case errors.Is(err, store.ErrConflict):
		writeError(w, r, http.StatusConflict, "conflict", "authorization operation conflicts with executor state")
	default:
		writeError(w, r, http.StatusInternalServerError, "authorization_operation_failed", "authorization operation failed")
	}
}

func (s *Server) writeAuthorizationRuntimeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, authorization.ErrChallengeGone):
		writeError(w, r, http.StatusGone, "authorization_challenge_gone", "authorization challenge is no longer available")
	case errors.Is(err, authorization.ErrRequesterMismatch):
		writeError(w, r, http.StatusForbidden, "permission_denied", "only the authorization requester may view the challenge")
	default:
		writeError(w, r, http.StatusServiceUnavailable, "executor_app_server_unavailable", "authorization runtime is unavailable")
	}
}
