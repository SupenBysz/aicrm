package server

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/Kysion/KyaiCRM/services/ky-matrix-account-service/internal/store"
)

func (s *Server) createWebSpace(w http.ResponseWriter, r *http.Request, wc wsContext) {
	var in store.MatrixAccountWebSpaceInput
	if !decodeJSON(w, r, &in) {
		return
	}
	in.Platform = strings.TrimSpace(in.Platform)
	in.DeviceID = strings.TrimSpace(in.DeviceID)
	if !validOneOf(in.Platform, "douyin", "kuaishou", "xiaohongshu") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "平台类型无效")
		return
	}
	item, err := s.store.CreateWebSpace(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, wc.UserID, in)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.web_space_created", "matrix_account_web_space", item.ID, map[string]any{"platform": item.Platform})
	writeData(w, r, item)
}

func (s *Server) getWebSpace(w http.ResponseWriter, r *http.Request, wc wsContext) {
	item, err := s.store.GetWebSpace(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	writeData(w, r, item)
}

func (s *Server) submitWebSpaceDetectResult(w http.ResponseWriter, r *http.Request, wc wsContext) {
	managed, err := s.store.HasLoginAttemptForWebSpace(
		r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, r.PathValue("id"),
	)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	if managed {
		writeError(w, r, http.StatusConflict, "login_attempt_required", "该登录空间由业务登录流程管理，必须在快照验证后完成绑定")
		return
	}
	var in store.MatrixAccountDetectResultInput
	if !decodeJSON(w, r, &in) {
		return
	}
	normalizeDetectResultInput(&in)
	if in.LoginStatus != "" && !validOneOf(in.LoginStatus, "not_logged_in", "login_pending", "online", "expired", "verify_required", "risk", "unknown") {
		writeError(w, r, http.StatusBadRequest, "validation_error", "登录状态无效")
		return
	}
	if in.IdentityKey == "" {
		item, err := s.store.MarkWebSpaceDetectFailed(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, wc.UserID, r.PathValue("id"), in)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		s.audit(r.Context(), r, wc, "matrix_account.web_space_detect_failed", "matrix_account_web_space", item.ID, nil)
		writeData(w, r, map[string]any{"webSpace": item, "account": nil, "created": false})
		return
	}
	if isIncompleteDetectedAccount(in) {
		item, err := s.store.MarkWebSpaceDetectFailed(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, wc.UserID, r.PathValue("id"), in)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		s.audit(r.Context(), r, wc, "matrix_account.web_space_detect_incomplete", "matrix_account_web_space", item.ID, nil)
		writeData(w, r, map[string]any{"webSpace": item, "account": nil, "created": false})
		return
	}
	result, err := s.store.BindDetectedWebSpace(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, wc.UserID, r.PathValue("id"), in)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.web_space_bound", "matrix_account_web_space", result.WebSpace.ID, map[string]any{
		"accountId": result.Account.ID,
		"created":   result.Created,
		"platform":  result.Account.Platform,
	})
	writeData(w, r, result)
}

func (s *Server) abandonWebSpace(w http.ResponseWriter, r *http.Request, wc wsContext) {
	if s.rejectLoginAttemptManagedWebSpace(w, r, wc) {
		return
	}
	item, err := s.store.AbandonWebSpace(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, wc.UserID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.web_space_abandoned", "matrix_account_web_space", item.ID, nil)
	writeData(w, r, item)
}

func (s *Server) clearWebSpace(w http.ResponseWriter, r *http.Request, wc wsContext) {
	if s.rejectLoginAttemptManagedWebSpace(w, r, wc) {
		return
	}
	item, err := s.store.ClearWebSpace(r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, wc.UserID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	s.audit(r.Context(), r, wc, "matrix_account.web_space_cleared", "matrix_account_web_space", item.ID, nil)
	writeData(w, r, item)
}

func (s *Server) rejectLoginAttemptManagedWebSpace(w http.ResponseWriter, r *http.Request, wc wsContext) bool {
	managed, err := s.store.HasLoginAttemptForWebSpace(
		r.Context(), wc.WorkspaceType, wc.WorkspaceID, wc.MembershipID, r.PathValue("id"),
	)
	if err != nil {
		writeStoreError(w, r, err)
		return true
	}
	if !managed {
		return false
	}
	writeError(w, r, http.StatusConflict, "login_attempt_required", "该登录空间由业务登录流程管理，请通过登录流程命令操作")
	return true
}

func normalizeDetectResultInput(in *store.MatrixAccountDetectResultInput) {
	in.IdentityKey = strings.TrimSpace(in.IdentityKey)
	in.PlatformUID = strings.TrimSpace(in.PlatformUID)
	in.DisplayName = strings.TrimSpace(in.DisplayName)
	in.Nickname = strings.TrimSpace(in.Nickname)
	in.AvatarURL = strings.TrimSpace(in.AvatarURL)
	in.HomeURL = strings.TrimSpace(in.HomeURL)
	in.BrowserPartition = strings.TrimSpace(in.BrowserPartition)
	in.DeviceID = strings.TrimSpace(in.DeviceID)
	in.LoginStatus = strings.TrimSpace(in.LoginStatus)
}

func isIncompleteDetectedAccount(in store.MatrixAccountDetectResultInput) bool {
	identity := strings.TrimSpace(in.IdentityKey)
	if len(identity) < 6 || invalidDetectedIdentity(identity) {
		return true
	}
	display := firstNonEmpty(in.DisplayName, in.Nickname)
	if looksLikeProfileURL(in.HomeURL) {
		return false
	}
	uid := strings.TrimSpace(in.PlatformUID)
	hasDisplay := len([]rune(display)) >= 2 && !looksLikeGenericDisplay(display)
	hasUsefulUID := uid != "" && uid != identity && len(uid) >= 6 && !invalidDetectedIdentity(uid)
	return !(hasDisplay && hasUsefulUID) && !(hasDisplay && strings.TrimSpace(in.AvatarURL) != "")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		normalized := strings.TrimSpace(value)
		if normalized != "" {
			return normalized
		}
	}
	return ""
}

func invalidDetectedIdentity(value string) bool {
	normalized := strings.TrimSpace(value)
	if detectedSessionTokenPattern.MatchString(normalized) {
		return true
	}
	switch strings.ToLower(normalized) {
	case "0", "null", "undefined", "false", "true", "login", "profile", "default", "anonymous", "guest":
		return true
	default:
		return false
	}
}

var detectedSessionTokenPattern = regexp.MustCompile(`(?i)^([a-f0-9]{24,}|[a-z0-9_-]{40,})$`)

func looksLikeLoginText(value string) bool {
	lower := strings.ToLower(strings.TrimSpace(value))
	return strings.Contains(lower, "登录") || strings.Contains(lower, "扫码") || strings.Contains(lower, "二维码") ||
		strings.Contains(lower, "login") || strings.Contains(lower, "scan")
}

func looksLikeGenericDisplay(value string) bool {
	if looksLikeLoginText(value) {
		return true
	}
	lower := strings.ToLower(strings.TrimSpace(value))
	return strings.Contains(lower, "创作服务平台") || strings.Contains(lower, "创作者中心") ||
		strings.Contains(lower, "工作台") || strings.Contains(lower, "开放平台") ||
		strings.Contains(lower, "账号中心") || strings.Contains(lower, "管理后台") ||
		strings.Contains(lower, "dashboard") || strings.Contains(lower, "creator")
}

func looksLikeProfileURL(value string) bool {
	lower := strings.ToLower(strings.TrimSpace(value))
	return strings.Contains(lower, "/user/") || strings.Contains(lower, "/profile/") ||
		strings.Contains(lower, "/creator-micro/user/")
}
