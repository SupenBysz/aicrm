package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
)

func (s *Server) listExecutors(w http.ResponseWriter, r *http.Request, actor actorContext) {
	items, err := s.control.ListExecutors(r.Context(), actor.WorkspaceType, actor.WorkspaceID)
	if err != nil {
		s.writeControlError(w, r, err)
		return
	}
	writeData(w, r, http.StatusOK, map[string]any{"items": items})
}

type createExecutorBody struct {
	Name                string  `json:"name"`
	RuntimeType         string  `json:"runtimeType"`
	Status              *string `json:"status,omitempty"`
	IsDefault           *bool   `json:"isDefault,omitempty"`
	AllowScriptSave     *bool   `json:"allowScriptSave,omitempty"`
	AutoRepairEnabled   *bool   `json:"autoRepairEnabled,omitempty"`
	TriggerFailureCount *int    `json:"triggerFailureCount,omitempty"`
	MaxAttempts         *int    `json:"maxAttempts,omitempty"`
	TaskTimeoutSeconds  *int    `json:"taskTimeoutSeconds,omitempty"`
}

func (s *Server) createExecutor(w http.ResponseWriter, r *http.Request, actor actorContext) {
	key, ok := idempotencyKey(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "idempotency_key_required", "a valid Idempotency-Key is required")
		return
	}
	var body createExecutorBody
	if !decodeStrictJSON(w, r, &body) {
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	body.RuntimeType = strings.TrimSpace(body.RuntimeType)
	if body.RuntimeType == "" {
		body.RuntimeType = "server"
	}
	status := "enabled"
	if body.Status != nil {
		status = strings.TrimSpace(*body.Status)
	}
	isDefault := body.IsDefault != nil && *body.IsDefault
	allowScriptSave := body.AllowScriptSave != nil && *body.AllowScriptSave
	autoRepair := body.AutoRepairEnabled != nil && *body.AutoRepairEnabled
	triggerFailures, maxAttempts, timeoutSeconds := 1, 2, 180
	if body.TriggerFailureCount != nil {
		triggerFailures = *body.TriggerFailureCount
	}
	if body.MaxAttempts != nil {
		maxAttempts = *body.MaxAttempts
	}
	if body.TaskTimeoutSeconds != nil {
		timeoutSeconds = *body.TaskTimeoutSeconds
	}
	if len(body.Name) < 1 || len(body.Name) > 120 ||
		(body.RuntimeType != "server" && body.RuntimeType != "desktop") ||
		(status != "enabled" && status != "disabled") ||
		(isDefault && status != "enabled") || triggerFailures < 1 || triggerFailures > 10 ||
		maxAttempts < 1 || maxAttempts > 10 || timeoutSeconds < 30 || timeoutSeconds > 3600 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "executor configuration is invalid")
		return
	}
	canonical, _ := json.Marshal(body)
	input := store.CreateExecutorInput{
		ID: newOpaqueID("aiexec"), Name: body.Name, RuntimeType: body.RuntimeType,
		Status: status, IsDefault: isDefault, AllowScriptSave: allowScriptSave,
		AutoRepairEnabled: autoRepair, TriggerFailureCount: triggerFailures,
		MaxAttempts: maxAttempts, TaskTimeoutSeconds: timeoutSeconds, ActorID: actor.ActorID,
		IdempotencyKeyHash: sha256Hex([]byte(key)), RequestHash: sha256Hex(canonical),
	}
	item, err := s.control.CreateExecutor(r.Context(), input, actor.WorkspaceType, actor.WorkspaceID)
	if errors.Is(err, store.ErrConflict) {
		// A concurrent retry may have committed the same idempotency record.
		item, err = s.control.CreateExecutor(r.Context(), input, actor.WorkspaceType, actor.WorkspaceID)
	}
	if err != nil {
		s.writeControlError(w, r, err)
		return
	}
	writeData(w, r, http.StatusCreated, item)
}

func (s *Server) getExecutor(w http.ResponseWriter, r *http.Request, actor actorContext) {
	id := r.PathValue("executorId")
	if !validOpaqueID(id) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "executorId is invalid")
		return
	}
	item, err := s.control.GetExecutor(r.Context(), id, actor.WorkspaceType, actor.WorkspaceID)
	if err != nil {
		s.writeControlError(w, r, err)
		return
	}
	writeData(w, r, http.StatusOK, item)
}

func (s *Server) patchExecutor(w http.ResponseWriter, r *http.Request, actor actorContext) {
	id := r.PathValue("executorId")
	if !validOpaqueID(id) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "executorId is invalid")
		return
	}
	object, ok := decodeRawObject(w, r)
	if !ok {
		return
	}
	allowed := map[string]bool{
		"expectedRevision": true, "name": true, "status": true, "isDefault": true,
		"defaultModelKey": true, "allowScriptSave": true, "autoRepairEnabled": true,
		"triggerFailureCount": true, "maxAttempts": true, "taskTimeoutSeconds": true,
	}
	for key := range object {
		if !allowed[key] {
			writeError(w, r, http.StatusBadRequest, "validation_error", "executor patch contains an unsupported field")
			return
		}
	}
	var patch store.ExecutorPatch
	patch.ActorID = actor.ActorID
	if raw, exists := object["expectedRevision"]; !exists || json.Unmarshal(raw, &patch.ExpectedRevision) != nil || patch.ExpectedRevision < 1 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "expectedRevision is required")
		return
	}
	changed := false
	if raw, exists := object["name"]; exists {
		patch.NameSet = true
		changed = true
		if json.Unmarshal(raw, &patch.Name) != nil {
			s.invalidPatch(w, r)
			return
		}
		patch.Name = strings.TrimSpace(patch.Name)
		if len(patch.Name) < 1 || len(patch.Name) > 120 {
			s.invalidPatch(w, r)
			return
		}
	}
	if raw, exists := object["status"]; exists {
		patch.StatusSet = true
		changed = true
		if json.Unmarshal(raw, &patch.Status) != nil || (patch.Status != "enabled" && patch.Status != "disabled") {
			s.invalidPatch(w, r)
			return
		}
	}
	if raw, exists := object["isDefault"]; exists {
		patch.IsDefaultSet = true
		changed = true
		if json.Unmarshal(raw, &patch.IsDefault) != nil {
			s.invalidPatch(w, r)
			return
		}
	}
	if raw, exists := object["defaultModelKey"]; exists {
		patch.DefaultModelKeySet = true
		changed = true
		if string(raw) != "null" {
			var value string
			if json.Unmarshal(raw, &value) != nil {
				s.invalidPatch(w, r)
				return
			}
			value = strings.TrimSpace(value)
			if value == "" || len(value) > 160 {
				s.invalidPatch(w, r)
				return
			}
			patch.DefaultModelKey = &value
		}
	}
	if raw, exists := object["allowScriptSave"]; exists {
		patch.AllowScriptSaveSet = true
		changed = true
		if json.Unmarshal(raw, &patch.AllowScriptSave) != nil {
			s.invalidPatch(w, r)
			return
		}
	}
	if raw, exists := object["autoRepairEnabled"]; exists {
		patch.AutoRepairEnabledSet = true
		changed = true
		if json.Unmarshal(raw, &patch.AutoRepairEnabled) != nil {
			s.invalidPatch(w, r)
			return
		}
	}
	if raw, exists := object["triggerFailureCount"]; exists {
		patch.TriggerFailureCountSet = true
		changed = true
		if json.Unmarshal(raw, &patch.TriggerFailureCount) != nil || patch.TriggerFailureCount < 1 || patch.TriggerFailureCount > 10 {
			s.invalidPatch(w, r)
			return
		}
	}
	if raw, exists := object["maxAttempts"]; exists {
		patch.MaxAttemptsSet = true
		changed = true
		if json.Unmarshal(raw, &patch.MaxAttempts) != nil || patch.MaxAttempts < 1 || patch.MaxAttempts > 10 {
			s.invalidPatch(w, r)
			return
		}
	}
	if raw, exists := object["taskTimeoutSeconds"]; exists {
		patch.TaskTimeoutSecondsSet = true
		changed = true
		if json.Unmarshal(raw, &patch.TaskTimeoutSeconds) != nil || patch.TaskTimeoutSeconds < 30 || patch.TaskTimeoutSeconds > 3600 {
			s.invalidPatch(w, r)
			return
		}
	}
	if !changed {
		s.invalidPatch(w, r)
		return
	}
	item, err := s.control.PatchExecutor(r.Context(), id, patch, actor.WorkspaceType, actor.WorkspaceID)
	if err != nil {
		s.writeControlError(w, r, err)
		return
	}
	writeData(w, r, http.StatusOK, item)
}

func (s *Server) invalidPatch(w http.ResponseWriter, r *http.Request) {
	writeError(w, r, http.StatusBadRequest, "validation_error", "executor patch is invalid")
}

func (s *Server) listExecutorModels(w http.ResponseWriter, r *http.Request, _ actorContext) {
	id := r.PathValue("executorId")
	if !validOpaqueID(id) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "executorId is invalid")
		return
	}
	includeHidden := r.URL.Query().Get("includeHidden") == "true"
	items, err := s.control.ListModels(r.Context(), id, includeHidden)
	if err != nil {
		s.writeControlError(w, r, err)
		return
	}
	writeData(w, r, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) listExecutorWorkspaceGrants(w http.ResponseWriter, r *http.Request, _ actorContext) {
	id := r.PathValue("executorId")
	if !validOpaqueID(id) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "executorId is invalid")
		return
	}
	items, err := s.control.ListWorkspaceGrants(r.Context(), id)
	if err != nil {
		s.writeControlError(w, r, err)
		return
	}
	writeData(w, r, http.StatusOK, map[string]any{"items": items})
}

type expectedRevisionBody struct {
	ExpectedRevision int64 `json:"expectedRevision"`
}

func (s *Server) putExecutorWorkspaceGrant(w http.ResponseWriter, r *http.Request, actor actorContext) {
	executorID, workspaceType, workspaceID, ok := grantPath(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "workspace grant path is invalid")
		return
	}
	var body expectedRevisionBody
	if !decodeStrictJSON(w, r, &body) || body.ExpectedRevision < 0 {
		if body.ExpectedRevision < 0 {
			s.invalidPatch(w, r)
		}
		return
	}
	id := newOpaqueID("grant")
	item, err := s.control.PutWorkspaceGrant(r.Context(), id, executorID, workspaceType, workspaceID, actor.ActorID, body.ExpectedRevision)
	if err != nil {
		s.writeControlError(w, r, err)
		return
	}
	writeData(w, r, http.StatusOK, item)
}

func (s *Server) deleteExecutorWorkspaceGrant(w http.ResponseWriter, r *http.Request, actor actorContext) {
	executorID, workspaceType, workspaceID, ok := grantPath(r)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "workspace grant path is invalid")
		return
	}
	var body expectedRevisionBody
	if !decodeStrictJSON(w, r, &body) {
		return
	}
	if body.ExpectedRevision < 1 {
		s.invalidPatch(w, r)
		return
	}
	item, err := s.control.DeleteWorkspaceGrant(r.Context(), executorID, workspaceType, workspaceID, actor.ActorID, body.ExpectedRevision)
	if err != nil {
		s.writeControlError(w, r, err)
		return
	}
	writeData(w, r, http.StatusOK, item)
}

func grantPath(r *http.Request) (string, string, string, bool) {
	executorID := r.PathValue("executorId")
	workspaceType := r.PathValue("workspaceType")
	workspaceID := r.PathValue("workspaceId")
	ok := validOpaqueID(executorID) && validOpaqueID(workspaceID) &&
		(workspaceType == "platform" || workspaceType == "agency" || workspaceType == "enterprise")
	return executorID, workspaceType, workspaceID, ok
}

func (s *Server) writeControlError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, r, http.StatusNotFound, "not_found", "resource was not found")
	case errors.Is(err, store.ErrRevisionConflict):
		writeError(w, r, http.StatusConflict, "revision_conflict", "resource revision changed")
	case errors.Is(err, store.ErrDefaultRequired):
		writeError(w, r, http.StatusConflict, "executor_default_required", "a default Codex executor is required")
	case errors.Is(err, store.ErrModelUnavailable):
		writeError(w, r, http.StatusConflict, "executor_model_unavailable", "model is unavailable")
	case errors.Is(err, store.ErrIdempotencyReuse):
		writeError(w, r, http.StatusConflict, "idempotency_key_reused", "Idempotency-Key was reused with another request")
	case errors.Is(err, store.ErrConflict):
		writeError(w, r, http.StatusConflict, "conflict", "resource conflict")
	default:
		writeError(w, r, http.StatusInternalServerError, "control_write_failed", "control-plane operation failed")
	}
}
