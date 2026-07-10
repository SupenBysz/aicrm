package store

import "encoding/json"

type Page struct {
	Page     int `json:"page"`
	PageSize int `json:"pageSize"`
	Total    int `json:"total"`
}

type MatrixAccount struct {
	ID                  string  `json:"id"`
	Platform            string  `json:"platform"`
	PlatformIdentityKey string  `json:"platformIdentityKey"`
	IdentitySource      string  `json:"identitySource"`
	DisplayName         string  `json:"displayName"`
	PlatformUID         string  `json:"platformUid"`
	Nickname            string  `json:"nickname"`
	AvatarURL           string  `json:"avatarUrl"`
	HomeURL             string  `json:"homeUrl"`
	BrowserPartition    string  `json:"browserPartition"`
	OwnerMemberID       string  `json:"ownerMemberId"`
	OwnerName           string  `json:"ownerName"`
	DepartmentName      string  `json:"departmentName"`
	TeamName            string  `json:"teamName"`
	LoginStatus         string  `json:"loginStatus"`
	Status              string  `json:"status"`
	Remark              string  `json:"remark"`
	LastLoginAt         *string `json:"lastLoginAt"`
	LastCheckAt         *string `json:"lastCheckAt"`
	CreatedAt           string  `json:"createdAt"`
	UpdatedAt           string  `json:"updatedAt"`
}

type MatrixAccountInput struct {
	Platform      string `json:"platform"`
	DisplayName   string `json:"displayName"`
	PlatformUID   string `json:"platformUid"`
	Nickname      string `json:"nickname"`
	HomeURL       string `json:"homeUrl"`
	OwnerMemberID string `json:"ownerMemberId"`
	DepartmentID  string `json:"departmentId"`
	TeamID        string `json:"teamId"`
	Remark        string `json:"remark"`
}

type MatrixAccountWebSpace struct {
	ID                  string  `json:"id"`
	WorkspaceType       string  `json:"workspaceType"`
	WorkspaceID         string  `json:"workspaceId"`
	Platform            string  `json:"platform"`
	MemberID            string  `json:"memberId"`
	DeviceID            string  `json:"deviceId"`
	BrowserPartition    string  `json:"browserPartition"`
	AccountID           string  `json:"accountId"`
	Status              string  `json:"status"`
	DetectedIdentityKey string  `json:"detectedIdentityKey"`
	DetectedPlatformUID string  `json:"detectedPlatformUid"`
	DetectedNickname    string  `json:"detectedNickname"`
	DetectedAvatarURL   string  `json:"detectedAvatarUrl"`
	DetectedHomeURL     string  `json:"detectedHomeUrl"`
	LastOpenedAt        *string `json:"lastOpenedAt"`
	DetectedAt          *string `json:"detectedAt"`
	CreatedAt           string  `json:"createdAt"`
	UpdatedAt           string  `json:"updatedAt"`
}

type MatrixAccountWebSpaceInput struct {
	Platform string `json:"platform"`
	DeviceID string `json:"deviceId"`
}

type MatrixAccountDetectResultInput struct {
	IdentityKey      string `json:"identityKey"`
	PlatformUID      string `json:"platformUid"`
	DisplayName      string `json:"displayName"`
	Nickname         string `json:"nickname"`
	AvatarURL        string `json:"avatarUrl"`
	HomeURL          string `json:"homeUrl"`
	BrowserPartition string `json:"browserPartition"`
	DeviceID         string `json:"deviceId"`
	LoginStatus      string `json:"loginStatus"`
}

type MatrixAccountBindResult struct {
	WebSpace MatrixAccountWebSpace `json:"webSpace"`
	Account  MatrixAccount         `json:"account"`
	Created  bool                  `json:"created"`
}

type MatrixAccountLoginAttempt struct {
	ID                      string         `json:"id"`
	WorkspaceType           string         `json:"workspaceType"`
	WorkspaceID             string         `json:"workspaceId"`
	Platform                string         `json:"platform"`
	MemberID                string         `json:"memberId"`
	DeviceID                string         `json:"deviceId"`
	WebSpaceID              string         `json:"webSpaceId"`
	Status                  string         `json:"status"`
	Phase                   string         `json:"phase"`
	Activity                string         `json:"activity"`
	CurrentStep             string         `json:"currentStep"`
	BlockedMethod           string         `json:"blockedMethod"`
	QRRevision              int            `json:"qrRevision"`
	AccountID               string         `json:"accountId"`
	SnapshotID              string         `json:"snapshotId"`
	RepairTaskID            string         `json:"repairTaskId"`
	AccountCandidate        map[string]any `json:"accountCandidate"`
	BindingInput            map[string]any `json:"bindingInput"`
	SnapshotVerified        bool           `json:"snapshotVerified"`
	SnapshotFingerprintHash string         `json:"-"`
	SnapshotContentHash     string         `json:"-"`
	Sequence                int64          `json:"sequence"`
	LastErrorCode           string         `json:"lastErrorCode"`
	LastErrorMessage        string         `json:"lastErrorMessage"`
	ExpiresAt               string         `json:"expiresAt"`
	CompletedAt             *string        `json:"completedAt"`
	CancelledAt             *string        `json:"cancelledAt"`
	CreatedAt               string         `json:"createdAt"`
	UpdatedAt               string         `json:"updatedAt"`
}

type MatrixAccountLoginAttemptInput struct {
	Platform       string `json:"platform"`
	DeviceID       string `json:"deviceId"`
	IdempotencyKey string `json:"idempotencyKey"`
	CommandID      string `json:"commandId"`
}

type MatrixAccountLoginAttemptEvent struct {
	ID          string         `json:"id"`
	AttemptID   string         `json:"attemptId"`
	Sequence    int64          `json:"sequence"`
	Type        string         `json:"type"`
	Phase       string         `json:"phase"`
	Recoverable bool           `json:"recoverable"`
	NextActions []string       `json:"nextActions"`
	Data        map[string]any `json:"data"`
	ActorType   string         `json:"actorType"`
	CreatedAt   string         `json:"createdAt"`
}

type MatrixAccountLoginCommand struct {
	ID          string         `json:"id"`
	AttemptID   string         `json:"attemptId"`
	CommandID   string         `json:"commandId"`
	CommandType string         `json:"commandType"`
	Status      string         `json:"status"`
	Result      map[string]any `json:"result"`
	CreatedAt   string         `json:"createdAt"`
	CompletedAt *string        `json:"completedAt"`
}

type MatrixAccountLoginCommandResult struct {
	Attempt MatrixAccountLoginAttempt       `json:"attempt"`
	Command MatrixAccountLoginCommand       `json:"command"`
	Event   *MatrixAccountLoginAttemptEvent `json:"event,omitempty"`
}

type MatrixAccountLoginStepResultInput struct {
	OperationID         string         `json:"operationId"`
	AttemptNo           int            `json:"attemptNo"`
	MethodKey           string         `json:"methodKey"`
	ScriptID            string         `json:"scriptId"`
	ScriptVersionID     string         `json:"scriptVersionId"`
	Status              string         `json:"status"`
	ObservedPhase       string         `json:"observedPhase"`
	ErrorCode           string         `json:"errorCode"`
	ErrorMessage        string         `json:"errorMessage"`
	DurationMs          int64          `json:"durationMs"`
	ResultSummary       map[string]any `json:"resultSummary"`
	VerificationReceipt string         `json:"verificationReceipt"`
}

type MatrixAccountLoginMethodRun struct {
	ID              string         `json:"id"`
	AttemptID       string         `json:"attemptId"`
	OperationID     string         `json:"operationId"`
	AttemptNo       int            `json:"attemptNo"`
	MethodKey       string         `json:"methodKey"`
	ScriptID        string         `json:"scriptId"`
	ScriptVersionID string         `json:"scriptVersionId"`
	Status          string         `json:"status"`
	ObservedPhase   string         `json:"observedPhase"`
	ErrorCode       string         `json:"errorCode"`
	ErrorMessage    string         `json:"errorMessage"`
	DurationMs      int64          `json:"durationMs"`
	ResultSummary   map[string]any `json:"resultSummary"`
	CreatedAt       string         `json:"createdAt"`
}

type MatrixAccountLoginStepResult struct {
	Attempt MatrixAccountLoginAttempt      `json:"attempt"`
	Run     MatrixAccountLoginMethodRun    `json:"run"`
	Event   MatrixAccountLoginAttemptEvent `json:"event"`
}

type LoginScript struct {
	ID                      string  `json:"id"`
	WorkspaceType           string  `json:"workspaceType"`
	WorkspaceID             string  `json:"workspaceId"`
	Platform                string  `json:"platform"`
	Purpose                 string  `json:"purpose"`
	URLPattern              string  `json:"urlPattern"`
	PageFingerprint         string  `json:"pageFingerprint"`
	ActiveVersionID         string  `json:"activeVersionId"`
	ModelID                 string  `json:"modelId"`
	Status                  string  `json:"status"`
	FailureThreshold        int     `json:"failureThreshold"`
	SuccessCount            int64   `json:"successCount"`
	FailureCount            int64   `json:"failureCount"`
	ConsecutiveFailureCount int64   `json:"consecutiveFailureCount"`
	GenerationCount         int64   `json:"generationCount"`
	TotalPromptTokens       int64   `json:"totalPromptTokens"`
	TotalCompletionTokens   int64   `json:"totalCompletionTokens"`
	TotalTokens             int64   `json:"totalTokens"`
	LastSuccessAt           *string `json:"lastSuccessAt"`
	LastFailedAt            *string `json:"lastFailedAt"`
	LastFailureReason       string  `json:"lastFailureReason"`
	CreatedAt               string  `json:"createdAt"`
	UpdatedAt               string  `json:"updatedAt"`
}

type LoginScriptListParams struct {
	WorkspaceType string
	WorkspaceID   string
	Platform      string
	Purpose       string
	Status        string
	Page          int
	PageSize      int
}

type LoginScriptVersion struct {
	ID               string          `json:"id"`
	ScriptID         string          `json:"scriptId"`
	Version          int             `json:"version"`
	ModelID          string          `json:"modelId"`
	DSL              json.RawMessage `json:"dsl"`
	Source           string          `json:"source"`
	Status           string          `json:"status"`
	PromptTokens     int64           `json:"promptTokens"`
	CompletionTokens int64           `json:"completionTokens"`
	TotalTokens      int64           `json:"totalTokens"`
	UsageSource      string          `json:"usageSource"`
	GenerationReason string          `json:"generationReason"`
	CreatedAt        string          `json:"createdAt"`
}

type LoginScriptResolveInput struct {
	Purpose         string `json:"purpose"`
	PageFingerprint string `json:"pageFingerprint"`
	URL             string `json:"url"`
	ModelID         string `json:"modelId"`
}

type LoginScriptResolveResult struct {
	Script           *LoginScript        `json:"script"`
	Version          *LoginScriptVersion `json:"version"`
	ShouldGenerate   bool                `json:"shouldGenerate"`
	Reason           string              `json:"reason"`
	FailureThreshold int                 `json:"failureThreshold"`
	ModelID          string              `json:"modelId"`
}

type LoginScriptRunResultInput struct {
	ScriptID        string         `json:"scriptId"`
	ScriptVersionID string         `json:"scriptVersionId"`
	Purpose         string         `json:"purpose"`
	Status          string         `json:"status"`
	ErrorCode       string         `json:"errorCode"`
	ErrorMessage    string         `json:"errorMessage"`
	DurationMs      int64          `json:"durationMs"`
	ResultSummary   map[string]any `json:"resultSummary"`
}

type LoginScriptRunLog struct {
	Purpose       string         `json:"purpose"`
	Version       int            `json:"version"`
	VersionStatus string         `json:"versionStatus"`
	VersionSource string         `json:"versionSource"`
	Status        string         `json:"status"`
	ErrorCode     string         `json:"errorCode"`
	ReasonCode    string         `json:"reasonCode"`
	DurationMs    int64          `json:"durationMs"`
	ResultSummary map[string]any `json:"resultSummary"`
	CreatedAt     string         `json:"createdAt"`
}

type LoginScriptGenerateInput struct {
	Purpose          string          `json:"purpose"`
	PageFingerprint  string          `json:"pageFingerprint"`
	URL              string          `json:"url"`
	Title            string          `json:"title"`
	Snapshot         json.RawMessage `json:"snapshot"`
	ModelID          string          `json:"modelId"`
	GenerationReason string          `json:"generationReason"`
}

type GeneratedLoginScript struct {
	ModelID          string          `json:"modelId"`
	ModelType        string          `json:"modelType"`
	DSL              json.RawMessage `json:"dsl"`
	PromptTokens     int64           `json:"promptTokens"`
	CompletionTokens int64           `json:"completionTokens"`
	TotalTokens      int64           `json:"totalTokens"`
	UsageSource      string          `json:"usageSource"`
	GenerationReason string          `json:"generationReason"`
}

type ListAccountsParams struct {
	WorkspaceType string
	WorkspaceID   string
	Platform      string
	Keyword       string
	LoginStatus   string
	Status        string
	Page          int
	PageSize      int
}

type LoginTask struct {
	ID               string  `json:"id"`
	AccountID        string  `json:"accountId"`
	Status           string  `json:"status"`
	PlatformLoginURL string  `json:"platformLoginUrl"`
	ErrorMessage     string  `json:"errorMessage"`
	CreatedAt        string  `json:"createdAt"`
	ExpiredAt        *string `json:"expiredAt"`
	CompletedAt      *string `json:"completedAt"`
}
