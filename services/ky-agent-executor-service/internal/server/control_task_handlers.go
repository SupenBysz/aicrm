package server

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
)

type modelCatalogRefreshBody struct {
	ExpectedExecutorRevision int64 `json:"expectedExecutorRevision"`
	ExpectedCatalogRevision  int64 `json:"expectedCatalogRevision"`
}

type readinessCheckBody struct {
	ExpectedExecutorRevision   int64 `json:"expectedExecutorRevision"`
	ExpectedCredentialRevision int64 `json:"expectedCredentialRevision"`
	ExpectedCatalogRevision    int64 `json:"expectedCatalogRevision"`
}

type credentialVerifyBody struct {
	ExpectedExecutorRevision   int64 `json:"expectedExecutorRevision"`
	ExpectedCredentialRevision int64 `json:"expectedCredentialRevision"`
}

func (s *Server) registerControlTaskRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/ai-executors/{executorId}/model-catalog/refresh",
		s.public([]string{"platform.ai_executors.update"}, nil, s.refreshModelCatalog))
	mux.HandleFunc("POST /api/v1/ai-executors/{executorId}/readiness/check",
		s.public([]string{"platform.ai_executors.update"}, nil, s.checkExecutorReadiness))
	mux.HandleFunc("POST /api/v1/ai-executors/{executorId}/credential/verify",
		s.public([]string{"platform.ai_executors.update"}, nil, s.verifyExecutorCredential))
}

func (s *Server) refreshModelCatalog(w http.ResponseWriter, r *http.Request, actor actorContext) {
	var body modelCatalogRefreshBody
	if !decodeStrictJSON(w, r, &body) {
		return
	}
	if body.ExpectedExecutorRevision < 1 || body.ExpectedCatalogRevision < 0 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "model catalog refresh request is invalid")
		return
	}
	s.createServerControlTask(w, r, actor, store.CreateControlTaskInput{
		TaskType: "model_catalog_refresh", ExpectedExecutorRevision: body.ExpectedExecutorRevision,
		ExpectedCatalogRevision: int64Pointer(body.ExpectedCatalogRevision),
	}, body)
}

func (s *Server) checkExecutorReadiness(w http.ResponseWriter, r *http.Request, actor actorContext) {
	var body readinessCheckBody
	if !decodeStrictJSON(w, r, &body) {
		return
	}
	if body.ExpectedExecutorRevision < 1 || body.ExpectedCredentialRevision < 1 || body.ExpectedCatalogRevision < 0 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "readiness check request is invalid")
		return
	}
	s.createServerControlTask(w, r, actor, store.CreateControlTaskInput{
		TaskType: "readiness_check", ExpectedExecutorRevision: body.ExpectedExecutorRevision,
		ExpectedCredentialRevision: int64Pointer(body.ExpectedCredentialRevision),
		ExpectedCatalogRevision:    int64Pointer(body.ExpectedCatalogRevision),
	}, body)
}

func (s *Server) verifyExecutorCredential(w http.ResponseWriter, r *http.Request, actor actorContext) {
	var body credentialVerifyBody
	if !decodeStrictJSON(w, r, &body) {
		return
	}
	if body.ExpectedExecutorRevision < 1 || body.ExpectedCredentialRevision < 1 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "credential verification request is invalid")
		return
	}
	s.createServerControlTask(w, r, actor, store.CreateControlTaskInput{
		TaskType: "credential_verify", ExpectedExecutorRevision: body.ExpectedExecutorRevision,
		ExpectedCredentialRevision: int64Pointer(body.ExpectedCredentialRevision),
	}, body)
}

func (s *Server) createServerControlTask(w http.ResponseWriter, r *http.Request, actor actorContext, input store.CreateControlTaskInput, canonicalBody any) {
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
	canonical, _ := json.Marshal(canonicalBody)
	input.ID = newOpaqueID("task")
	input.ExecutorID = executorID
	input.ActorID = actor.ActorID
	input.WorkspaceType = actor.WorkspaceType
	input.WorkspaceID = actor.WorkspaceID
	input.IdempotencyKeyHash = sha256Hex([]byte(key))
	input.RequestHash = sha256Hex(canonical)
	result, err := s.control.CreateControlTask(r.Context(), input)
	if errors.Is(err, store.ErrConflict) {
		result, err = s.control.CreateControlTask(r.Context(), input)
	}
	if err != nil {
		s.writeTaskStoreError(w, r, err)
		return
	}
	if result.Created && s.taskRuntime != nil {
		s.taskRuntime.Wake()
	}
	writeData(w, r, http.StatusAccepted, map[string]any{
		"taskId": result.Task.ID, "status": "pending",
	})
}

func int64Pointer(value int64) *int64 { return &value }
