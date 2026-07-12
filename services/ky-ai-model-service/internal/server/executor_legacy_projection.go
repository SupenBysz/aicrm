package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-ai-model-service/internal/store"
)

var legacyExecutorCapabilityBooleanAllowlist = map[string]struct{}{
	"supportsAppServerAuth":          {},
	"supportsDeviceCodeAuth":         {},
	"supportsDesktopAuth":            {},
	"supportsModelCatalog":           {},
	"supportsReadiness":              {},
	"supportsTaskTransport":          {},
	"supportsCredentialVerification": {},
	"supportsScriptMaintenance":      {},
}

// legacyExecutorConfigProjection is the one-release compatibility shape for
// model-service executor reads. It deliberately excludes the legacy bound
// device identifier and only carries a redacted account summary.
type legacyExecutorConfigProjection struct {
	ID                  string          `json:"id"`
	Name                string          `json:"name"`
	ScopeType           string          `json:"scopeType"`
	ScopeID             string          `json:"scopeId"`
	ExecutorType        string          `json:"executorType"`
	RuntimeType         string          `json:"runtimeType"`
	Status              string          `json:"status"`
	IsDefault           bool            `json:"isDefault"`
	Priority            int             `json:"priority"`
	AutoRepairEnabled   bool            `json:"autoRepairEnabled"`
	TriggerFailureCount int             `json:"triggerFailureCount"`
	MaxAttempts         int             `json:"maxAttempts"`
	TaskTimeoutSeconds  int             `json:"taskTimeoutSeconds"`
	MaxConcurrency      int             `json:"maxConcurrency"`
	AllowPageActions    bool            `json:"allowPageActions"`
	AllowStorageRead    bool            `json:"allowStorageRead"`
	AllowCDPRuntime     bool            `json:"allowCdpRuntime"`
	AllowScriptSave     bool            `json:"allowScriptSave"`
	AllowAutoActivate   bool            `json:"allowAutoActivate"`
	AppServerListen     string          `json:"appServerListen"`
	AuthStatus          string          `json:"authStatus"`
	AuthMethod          string          `json:"authMethod"`
	AuthAccountLabel    string          `json:"authAccountLabel"`
	CodexVersion        string          `json:"codexVersion"`
	Capabilities        map[string]bool `json:"capabilities"`
	LastHeartbeatAt     *time.Time      `json:"lastHeartbeatAt"`
	LastAuthCheckedAt   *time.Time      `json:"lastAuthCheckedAt"`
	Remark              string          `json:"remark"`
	CreatedBy           string          `json:"createdBy"`
	CreatedAt           time.Time       `json:"createdAt"`
	UpdatedAt           time.Time       `json:"updatedAt"`
}

func toLegacyExecutorConfigProjection(item store.ExecutorConfig) legacyExecutorConfigProjection {
	return legacyExecutorConfigProjection{
		ID:                  item.ID,
		Name:                item.Name,
		ScopeType:           item.ScopeType,
		ScopeID:             item.ScopeID,
		ExecutorType:        item.ExecutorType,
		RuntimeType:         item.RuntimeType,
		Status:              item.Status,
		IsDefault:           item.IsDefault,
		Priority:            item.Priority,
		AutoRepairEnabled:   item.AutoRepairEnabled,
		TriggerFailureCount: item.TriggerFailureCount,
		MaxAttempts:         item.MaxAttempts,
		TaskTimeoutSeconds:  item.TaskTimeoutSeconds,
		MaxConcurrency:      item.MaxConcurrency,
		AllowPageActions:    item.AllowPageActions,
		AllowStorageRead:    item.AllowStorageRead,
		AllowCDPRuntime:     item.AllowCDPRuntime,
		AllowScriptSave:     item.AllowScriptSave,
		AllowAutoActivate:   item.AllowAutoActivate,
		AppServerListen:     "stdio://",
		AuthStatus:          legacyExecutorAuthStatus(item.AuthStatus),
		AuthMethod:          legacyExecutorAuthMethod(item.AuthMethod),
		AuthAccountLabel:    legacyExecutorAccountSummary(item.AuthAccountLabel),
		CodexVersion:        item.CodexVersion,
		Capabilities:        legacyExecutorSafeCapabilities(item.Capabilities),
		LastHeartbeatAt:     item.LastHeartbeatAt,
		LastAuthCheckedAt:   item.LastAuthCheckedAt,
		Remark:              item.Remark,
		CreatedBy:           item.CreatedBy,
		CreatedAt:           item.CreatedAt,
		UpdatedAt:           item.UpdatedAt,
	}
}

func toLegacyExecutorConfigProjections(items []store.ExecutorConfig) []legacyExecutorConfigProjection {
	out := make([]legacyExecutorConfigProjection, 0, len(items))
	for _, item := range items {
		out = append(out, toLegacyExecutorConfigProjection(item))
	}
	return out
}

func legacyExecutorAuthStatus(value string) string {
	switch strings.TrimSpace(value) {
	case "authorized":
		return "authorized"
	case "expired":
		return "expired"
	default:
		// A legacy authorizing value is not proof of an active trusted session.
		return "not_authorized"
	}
}

func legacyExecutorAuthMethod(value string) string {
	switch strings.TrimSpace(value) {
	case "desktop":
		return "desktop"
	case "device_auth":
		return "device_auth"
	default:
		return ""
	}
}

func legacyExecutorAccountSummary(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	digest := sha256.Sum256([]byte(value))
	return "sha256:" + hex.EncodeToString(digest[:8])
}

func legacyExecutorSafeCapabilities(raw json.RawMessage) map[string]bool {
	out := make(map[string]bool)
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return out
	}
	for key := range legacyExecutorCapabilityBooleanAllowlist {
		value, exists := decoded[key]
		if !exists {
			continue
		}
		booleanValue, ok := value.(bool)
		if ok {
			out[key] = booleanValue
		}
	}
	return out
}
