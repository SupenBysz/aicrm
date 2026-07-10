package store

import (
	"encoding/json"
	"time"
)

type Provider struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	ProviderType string    `json:"providerType"`
	BaseURL      string    `json:"baseUrl"`
	HasAPIKey    bool      `json:"hasApiKey"`
	APIKeyMasked string    `json:"apiKeyMasked"`
	Status       string    `json:"status"`
	Remark       string    `json:"remark"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`

	// APIKeyEncrypted is internal-only and never serialized to clients.
	APIKeyEncrypted string `json:"-"`
}

type Model struct {
	ID                string          `json:"id"`
	ProviderID        string          `json:"providerId"`
	Name              string          `json:"name"`
	ModelKey          string          `json:"modelKey"`
	ModelType         string          `json:"modelType"`
	ContextLength     int             `json:"contextLength"`
	DefaultParameters json.RawMessage `json:"defaultParameters"`
	Status            string          `json:"status"`
	Remark            string          `json:"remark"`
	CreatedAt         time.Time       `json:"createdAt"`
	UpdatedAt         time.Time       `json:"updatedAt"`
}

type Page struct {
	Page     int   `json:"page"`
	PageSize int   `json:"pageSize"`
	Total    int64 `json:"total"`
}

type ExecutorConfig struct {
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
	BoundDeviceID       string          `json:"boundDeviceId"`
	CodexVersion        string          `json:"codexVersion"`
	Capabilities        json.RawMessage `json:"capabilities"`
	LastHeartbeatAt     *time.Time      `json:"lastHeartbeatAt"`
	LastAuthCheckedAt   *time.Time      `json:"lastAuthCheckedAt"`
	Remark              string          `json:"remark"`
	CreatedBy           string          `json:"createdBy"`
	CreatedAt           time.Time       `json:"createdAt"`
	UpdatedAt           time.Time       `json:"updatedAt"`
}

type ExecutorConfigInput struct {
	Name                string `json:"name"`
	ExecutorType        string `json:"executorType"`
	RuntimeType         string `json:"runtimeType"`
	Status              string `json:"status"`
	IsDefault           *bool  `json:"isDefault"`
	Priority            int    `json:"priority"`
	AutoRepairEnabled   *bool  `json:"autoRepairEnabled"`
	TriggerFailureCount int    `json:"triggerFailureCount"`
	MaxAttempts         int    `json:"maxAttempts"`
	TaskTimeoutSeconds  int    `json:"taskTimeoutSeconds"`
	MaxConcurrency      int    `json:"maxConcurrency"`
	AllowPageActions    *bool  `json:"allowPageActions"`
	AllowStorageRead    *bool  `json:"allowStorageRead"`
	AllowCDPRuntime     *bool  `json:"allowCdpRuntime"`
	AllowScriptSave     *bool  `json:"allowScriptSave"`
	AllowAutoActivate   *bool  `json:"allowAutoActivate"`
	AppServerListen     string `json:"appServerListen"`
	Remark              string `json:"remark"`
}

type ExecutorAuthSession struct {
	ExecutorID      string     `json:"executorId"`
	RuntimeType     string     `json:"runtimeType"`
	AuthMode        string     `json:"authMode"`
	AuthStatus      string     `json:"authStatus"`
	Command         string     `json:"command"`
	CodexHome       string     `json:"codexHome"`
	VerificationURI string     `json:"verificationUri"`
	UserCode        string     `json:"userCode"`
	ExpiresAt       *time.Time `json:"expiresAt"`
	Message         string     `json:"message"`
}

type ExecutorTask struct {
	ID              string             `json:"id"`
	WorkspaceType   string             `json:"workspaceType"`
	WorkspaceID     string             `json:"workspaceId"`
	ExecutorID      string             `json:"executorId"`
	ExecutorType    string             `json:"executorType"`
	TaskType        string             `json:"taskType"`
	Purpose         string             `json:"purpose"`
	TriggerReason   string             `json:"triggerReason"`
	TargetType      string             `json:"targetType"`
	TargetID        string             `json:"targetId"`
	WebSpaceID      string             `json:"webSpaceId"`
	ScriptID        string             `json:"scriptId"`
	ScriptVersionID string             `json:"scriptVersionId"`
	Status          string             `json:"status"`
	CodexThreadID   string             `json:"codexThreadId"`
	ResultSummary   json.RawMessage    `json:"resultSummary"`
	ErrorMessage    string             `json:"errorMessage"`
	CreatedBy       string             `json:"createdBy"`
	StartedAt       *time.Time         `json:"startedAt"`
	CompletedAt     *time.Time         `json:"completedAt"`
	CreatedAt       time.Time          `json:"createdAt"`
	UpdatedAt       time.Time          `json:"updatedAt"`
	TokenUsage      ExecutorTokenUsage `json:"tokenUsage"`
}

type ExecutorTokenUsage struct {
	CachedInputTokens     int64 `json:"cachedInputTokens"`
	InputTokens           int64 `json:"inputTokens"`
	OutputTokens          int64 `json:"outputTokens"`
	ReasoningOutputTokens int64 `json:"reasoningOutputTokens"`
	TotalTokens           int64 `json:"totalTokens"`
}

type ExecutorTaskInput struct {
	ExecutorID      string         `json:"executorId"`
	ExecutorType    string         `json:"executorType"`
	TaskType        string         `json:"taskType"`
	Purpose         string         `json:"purpose"`
	TriggerReason   string         `json:"triggerReason"`
	TargetType      string         `json:"targetType"`
	TargetID        string         `json:"targetId"`
	WebSpaceID      string         `json:"webSpaceId"`
	ScriptID        string         `json:"scriptId"`
	ScriptVersionID string         `json:"scriptVersionId"`
	ResultSummary   map[string]any `json:"resultSummary"`
}

type ExecutorTaskEvent struct {
	ID        string          `json:"id"`
	TaskID    string          `json:"taskId"`
	Sequence  int64           `json:"sequence"`
	EventType string          `json:"eventType"`
	Level     string          `json:"level"`
	Message   string          `json:"message"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"createdAt"`
}

type ExecutorTaskRawLog struct {
	ID           string          `json:"id"`
	TaskID       string          `json:"taskId"`
	Sequence     int64           `json:"sequence"`
	Source       string          `json:"source"`
	Direction    string          `json:"direction"`
	RawText      string          `json:"rawText"`
	RawJSON      json.RawMessage `json:"rawJson"`
	TerminalLine string          `json:"terminalLine"`
	CreatedAt    time.Time       `json:"createdAt"`
}
