package server

import (
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/store"
)

func (s *Server) createLoginAttempt(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in store.MatrixAccountLoginAttemptInput
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Platform = strings.TrimSpace(in.Platform)
	in.DeviceID = strings.TrimSpace(in.DeviceID)
	in.IdempotencyKey = firstNonEmpty(strings.TrimSpace(r.Header.Get("Idempotency-Key")), strings.TrimSpace(in.IdempotencyKey), strings.TrimSpace(in.CommandID))
	if !validOneOf(in.Platform, "douyin", "kuaishou", "xiaohongshu") || in.IdempotencyKey == "" || len(in.IdempotencyKey) > 160 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "平台或幂等键无效")
		return
	}
	item, err := s.store.CreateLoginAttempt(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, wc.UserID, in)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.login_attempt_created", "matrix_account_login_attempt", item.ID, map[string]any{"platform": item.Platform})
	writeData(w, r, item)
}

func (s *Server) getLoginAttempt(w http.ResponseWriter, r *http.Request, wc wsContext) {
	item, err := s.store.GetLoginAttempt(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, item)
}

func (s *Server) listLoginAttemptEvents(w http.ResponseWriter, r *http.Request, wc wsContext) {
	after, err := strconv.ParseInt(firstNonEmpty(strings.TrimSpace(r.URL.Query().Get("afterSequence")), "0"), 10, 64)
	if err != nil || after < 0 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "事件游标无效")
		return
	}
	limit := atoiDefault(r.URL.Query().Get("limit"), 100)
	attempt, err := s.store.GetLoginAttempt(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	events, err := s.store.ListLoginAttemptEvents(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, attempt.ID, after, limit)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	lastSequence := after
	if len(events) > 0 {
		lastSequence = events[len(events)-1].Sequence
	}
	writeData(w, r, map[string]any{
		"attempt":      attempt,
		"events":       events,
		"lastSequence": lastSequence,
		"hasMore":      lastSequence < attempt.Sequence,
	})
}

func (s *Server) runLoginAttemptCommand(w http.ResponseWriter, r *http.Request, wc wsContext) {
	commandType := strings.ReplaceAll(strings.TrimSpace(r.PathValue("command")), "-", "_")
	if !validOneOf(commandType, "refresh_qr", "retry", "cancel") {
		writeError(w, r, http.StatusNotFound, "not_found", "命令不存在")
		return
	}
	var in struct {
		CommandID        string `json:"commandId"`
		IdempotencyKey   string `json:"idempotencyKey"`
		ExpectedRevision *int   `json:"expectedRevision"`
		ExpectedSequence *int64 `json:"expectedSequence"`
		Reason           string `json:"reason"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	commandID := firstNonEmpty(strings.TrimSpace(r.Header.Get("Idempotency-Key")), strings.TrimSpace(in.IdempotencyKey), strings.TrimSpace(in.CommandID))
	if commandID == "" || len(commandID) > 160 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "命令幂等键无效")
		return
	}
	reason := strings.ToUpper(strings.NewReplacer("-", "_", ".", "_").Replace(strings.TrimSpace(in.Reason)))
	if reason != "" && !loginStepErrorCodePattern.MatchString(reason) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "命令原因码无效")
		return
	}
	result, err := s.store.ApplyLoginAttemptCommand(
		r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, wc.UserID,
		r.PathValue("id"), commandID, commandType, in.ExpectedRevision, in.ExpectedSequence, reason,
	)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.login_attempt_command", "matrix_account_login_attempt", result.Attempt.ID, map[string]any{"command": commandType})
	writeData(w, r, result)
}

func (s *Server) submitLoginAttemptStepResult(w http.ResponseWriter, r *http.Request, wc wsContext) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var wire struct {
		store.MatrixAccountLoginStepResultInput
		Method string `json:"method"`
	}
	if !decodeJSON(w, r, &wire) {
		return
	}
	in := wire.MatrixAccountLoginStepResultInput
	in.OperationID = firstNonEmpty(strings.TrimSpace(in.OperationID), strings.TrimSpace(r.Header.Get("Idempotency-Key")))
	in.MethodKey = firstNonEmpty(strings.TrimSpace(in.MethodKey), strings.TrimSpace(wire.Method))
	in.Status = strings.TrimSpace(in.Status)
	in.ObservedPhase = strings.TrimSpace(in.ObservedPhase)
	in.ErrorCode = strings.ToUpper(strings.NewReplacer("-", "_", ".", "_").Replace(strings.TrimSpace(in.ErrorCode)))
	if in.ErrorCode != "" && !loginStepErrorCodePattern.MatchString(in.ErrorCode) {
		writeError(w, r, http.StatusBadRequest, "validation_error", "步骤错误码无效")
		return
	}
	// Raw browser/adapter errors can contain URLs, cookies or storage values.
	// Persist the bounded machine code only; detailed diagnostics stay local.
	in.ErrorMessage = ""
	if in.AttemptNo < 1 {
		in.AttemptNo = 1
	}
	if in.OperationID == "" || len(in.OperationID) > 160 || in.MethodKey == "" || !validOneOf(in.Status, "success", "failed", "timeout", "cancelled") || in.DurationMs < 0 {
		writeError(w, r, http.StatusBadRequest, "validation_error", "步骤结果无效")
		return
	}
	if code, message, blocked := publicTrustedStepSuccessBlock(in.MethodKey, in.Status); blocked {
		writeError(w, r, http.StatusServiceUnavailable, code, message)
		return
	}
	projected, ok := normalizeLoginStepSummary(in.MethodKey, in.Status, in.ResultSummary)
	if !ok {
		writeError(w, r, http.StatusBadRequest, "validation_error", "步骤结果包含无效字段")
		return
	}
	in.ResultSummary = projected
	if in.MethodKey == "business.binding.confirm.v1" && in.Status == "success" {
		binding, _ := projected["bindingInput"].(map[string]any)
		decision, _ := binding["decision"].(string)
		accountID, _ := binding["accountId"].(string)
		if !validOneOf(decision, "create_new", "attach_existing", "replace_device_session") ||
			(decision == "create_new" && strings.TrimSpace(accountID) != "") ||
			(decision != "create_new" && strings.TrimSpace(accountID) == "") {
			writeError(w, r, http.StatusBadRequest, "validation_error", "账号绑定决策无效")
			return
		}
		if decision == "create_new" {
			allowed, err := s.store.HasAny(r.Context(), wc.MembershipID, []string{workspacePermissionCode(wc.WorkspaceType, "create")})
			if err != nil {
				writeStoreError(w, r, err)
				return
			}
			if !allowed {
				writeError(w, r, http.StatusForbidden, "permission_denied", "当前后台身份无权创建矩阵账号")
				return
			}
		}
		if hasAssignmentMutation(binding) {
			allowed, err := s.store.HasAny(r.Context(), wc.MembershipID, []string{workspacePermissionCode(wc.WorkspaceType, "update")})
			if err != nil {
				writeStoreError(w, r, err)
				return
			}
			if !allowed {
				writeError(w, r, http.StatusForbidden, "permission_denied", "当前后台身份无权修改账号归属资料")
				return
			}
		}
	}
	if in.MethodKey == "account.identity.get.v1" && in.Status == "success" {
		identity, _ := projected["identityKey"].(string)
		if identity == "" || invalidDetectedIdentity(identity) {
			writeError(w, r, http.StatusBadRequest, "validation_error", "账号身份无效")
			return
		}
	}
	result, err := s.store.SubmitLoginAttemptStepResult(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, wc.UserID, r.PathValue("id"), in)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.login_attempt_step_result", "matrix_account_login_attempt", result.Attempt.ID, map[string]any{"methodKey": in.MethodKey, "status": in.Status})
	writeData(w, r, result)
}

var loginStepErrorCodePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
var loginStepDigestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var loginStepIdentifierPattern = regexp.MustCompile(`^[a-zA-Z0-9_.:-]{1,160}$`)

func publicTrustedStepSuccessBlock(methodKey, status string) (string, string, bool) {
	if status != "success" {
		return "", "", false
	}
	switch methodKey {
	case "business.onboarding.complete.v1":
		return "snapshot_verifier_unavailable", "可信快照验签器尚未启用，当前流程不能提交账号绑定", true
	case "session.snapshot.seal.v1", "web_space.cleanup.v1":
		return "trusted_runtime_proof_unavailable", "可信桌面证明通道尚未启用，当前步骤不能由普通登录请求确认", true
	default:
		return "", "", false
	}
}

func normalizeLoginStepSummary(methodKey, status string, source map[string]any) (map[string]any, bool) {
	projected, ok := projectLoginStepSummary(methodKey, source)
	if !ok {
		return nil, false
	}
	if status == "success" {
		return projected, validateProjectedLoginStepSummary(methodKey, projected)
	}
	// Failure details are represented by the bounded machine error code.
	// Never persist partial method output from a failed/timeout/cancelled run.
	return map[string]any{}, true
}

func projectLoginStepSummary(methodKey string, source map[string]any) (map[string]any, bool) {
	source = nonNilSummary(source)
	switch methodKey {
	case "login.open.v1", "login.qr.refresh.v1":
		return map[string]any{}, true
	case "login.qr.get.v1":
		return pickSummary(source, "qrRevision", "qrHash", "expiresAt", "readable"), true
	case "login.status.probe.v1":
		return pickSummary(source, "phase", "confidence"), true
	case "account.identity.get.v1":
		if candidate, ok := source["accountCandidate"].(map[string]any); ok {
			source = candidate
		}
		projected := pickSummary(source, "identityKey", "platformUid", "homeUrl")
		normalizeProjectedPublicURL(projected, "homeUrl")
		return projected, true
	case "account.profile.get.v1":
		if candidate, ok := source["accountCandidate"].(map[string]any); ok {
			source = candidate
		}
		projected := pickSummary(source, "displayName", "nickname", "avatarUrl", "homeUrl")
		normalizeProjectedPublicURL(projected, "avatarUrl")
		normalizeProjectedPublicURL(projected, "homeUrl")
		return projected, true
	case "business.binding.confirm.v1":
		binding, _ := source["bindingInput"].(map[string]any)
		if len(binding) == 0 {
			binding, _ = source["businessAssignment"].(map[string]any)
		}
		binding = pickSummary(binding, "decision", "accountId", "ownerMemberId", "departmentId", "teamId", "remark")
		if decision, ok := source["bindingDecision"].(string); ok && strings.TrimSpace(decision) != "" {
			binding["decision"] = strings.TrimSpace(decision)
		}
		return map[string]any{"bindingInput": binding}, true
	case "session.snapshot.seal.v1":
		return pickSummary(source, "snapshotId", "fingerprintHash", "contentHash", "verified", "size", "sourceBytes", "fileCount", "schemaVersion"), true
	case "business.onboarding.complete.v1":
		return pickSummary(source, "accountId", "snapshotVerified"), true
	case "web_space.cleanup.v1":
		return pickSummary(source, "cleared", "releasedBytes"), true
	default:
		return nil, false
	}
}

func pickSummary(source map[string]any, keys ...string) map[string]any {
	result := make(map[string]any)
	for _, key := range keys {
		if value, ok := source[key]; ok {
			result[key] = value
		}
	}
	return result
}

func nonNilSummary(source map[string]any) map[string]any {
	if source == nil {
		return map[string]any{}
	}
	return source
}

func validateProjectedLoginStepSummary(methodKey string, summary map[string]any) bool {
	switch methodKey {
	case "login.open.v1", "login.qr.refresh.v1":
		return len(summary) == 0
	case "login.qr.get.v1":
		return optionalInteger(summary, "qrRevision", 0, 1_000_000) &&
			optionalDigest(summary, "qrHash") && optionalString(summary, "expiresAt", 80) &&
			optionalBool(summary, "readable")
	case "login.status.probe.v1":
		phase, ok := summary["phase"].(string)
		return ok && validOneOf(strings.TrimSpace(phase), "login_page", "qr_ready", "waiting_scan", "scanned", "confirming", "authenticated", "verification_required", "risk_controlled", "qr_expired", "unknown") &&
			optionalNumber(summary, "confidence", 0, 1)
	case "account.identity.get.v1":
		return requiredString(summary, "identityKey", 512) && optionalString(summary, "platformUid", 256) && optionalURL(summary, "homeUrl", 2_048)
	case "account.profile.get.v1":
		return optionalString(summary, "displayName", 200) && optionalString(summary, "nickname", 200) &&
			optionalURL(summary, "avatarUrl", 2_048) && optionalURL(summary, "homeUrl", 2_048)
	case "business.binding.confirm.v1":
		binding, ok := summary["bindingInput"].(map[string]any)
		return ok && requiredString(binding, "decision", 32) && optionalString(binding, "accountId", 160) &&
			optionalString(binding, "ownerMemberId", 160) && optionalString(binding, "departmentId", 160) &&
			optionalString(binding, "teamId", 160) && optionalString(binding, "remark", 1_000)
	case "session.snapshot.seal.v1":
		return requiredIdentifier(summary, "snapshotId") && requiredDigest(summary, "fingerprintHash") &&
			requiredDigest(summary, "contentHash") && requiredTrue(summary, "verified") &&
			optionalNumber(summary, "size", 0, 100*1024*1024*1024) &&
			optionalNumber(summary, "sourceBytes", 0, 100*1024*1024*1024) &&
			optionalNumber(summary, "fileCount", 0, 10_000_000) &&
			optionalNumber(summary, "schemaVersion", 1, 100)
	case "business.onboarding.complete.v1":
		return optionalString(summary, "accountId", 160) && requiredTrue(summary, "snapshotVerified")
	case "web_space.cleanup.v1":
		return requiredTrue(summary, "cleared") && optionalNumber(summary, "releasedBytes", 0, 100*1024*1024*1024)
	default:
		return false
	}
}

func requiredString(summary map[string]any, key string, max int) bool {
	value, ok := summary[key].(string)
	return ok && strings.TrimSpace(value) != "" && len(value) <= max
}

func optionalString(summary map[string]any, key string, max int) bool {
	value, exists := summary[key]
	if !exists {
		return true
	}
	text, ok := value.(string)
	return ok && len(text) <= max
}

func requiredIdentifier(summary map[string]any, key string) bool {
	value, ok := summary[key].(string)
	return ok && loginStepIdentifierPattern.MatchString(strings.TrimSpace(value))
}

func requiredDigest(summary map[string]any, key string) bool {
	value, ok := summary[key].(string)
	return ok && loginStepDigestPattern.MatchString(strings.ToLower(strings.TrimSpace(value)))
}

func optionalDigest(summary map[string]any, key string) bool {
	if _, exists := summary[key]; !exists {
		return true
	}
	return requiredDigest(summary, key)
}

func optionalBool(summary map[string]any, key string) bool {
	value, exists := summary[key]
	if !exists {
		return true
	}
	_, ok := value.(bool)
	return ok
}

func requiredTrue(summary map[string]any, key string) bool {
	value, ok := summary[key].(bool)
	return ok && value
}

func optionalInteger(summary map[string]any, key string, min, max int64) bool {
	value, exists := summary[key]
	if !exists {
		return true
	}
	number, ok := value.(float64)
	return ok && number == float64(int64(number)) && int64(number) >= min && int64(number) <= max
}

func optionalNumber(summary map[string]any, key string, min, max float64) bool {
	value, exists := summary[key]
	if !exists {
		return true
	}
	number, ok := value.(float64)
	return ok && number >= min && number <= max
}

func optionalURL(summary map[string]any, key string, max int) bool {
	value, exists := summary[key]
	if !exists {
		return true
	}
	text, ok := value.(string)
	if !ok || len(text) > max {
		return false
	}
	if strings.TrimSpace(text) == "" {
		return true
	}
	parsed, err := url.Parse(text)
	return err == nil && (parsed.Scheme == "https" || parsed.Scheme == "http") &&
		parsed.Host != "" && parsed.User == nil && parsed.RawQuery == "" && parsed.Fragment == ""
}

func normalizeProjectedPublicURL(summary map[string]any, key string) {
	raw, ok := summary[key].(string)
	if !ok || strings.TrimSpace(raw) == "" {
		return
	}
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" || parsed.User != nil {
		return
	}
	parsed.RawQuery = ""
	parsed.ForceQuery = false
	parsed.Fragment = ""
	summary[key] = parsed.String()
}

func hasAssignmentMutation(binding map[string]any) bool {
	for _, key := range []string{"ownerMemberId", "departmentId", "teamId", "remark"} {
		if _, exists := binding[key]; exists {
			return true
		}
	}
	return false
}
