package appserver

import "encoding/json"

const (
	MethodInitialize            = "initialize"
	MethodInitialized           = "initialized"
	MethodAccountRead           = "account/read"
	MethodAccountLoginStart     = "account/login/start"
	MethodAccountLoginCancel    = "account/login/cancel"
	MethodAccountLogout         = "account/logout"
	MethodModelList             = "model/list"
	MethodLoginCompleted        = "account/login/completed"
	MethodAccountUpdated        = "account/updated"
	maximumProtocolMessageBytes = 8 << 20
)

var RequiredMethods = []string{
	MethodInitialize,
	MethodInitialized,
	MethodAccountRead,
	MethodAccountLoginStart,
	MethodAccountLoginCancel,
	MethodAccountLogout,
	MethodModelList,
	MethodLoginCompleted,
	MethodAccountUpdated,
}

type initializeParams struct {
	ClientInfo   clientInfo             `json:"clientInfo"`
	Capabilities initializeCapabilities `json:"capabilities"`
}

type clientInfo struct {
	Name    string `json:"name"`
	Title   string `json:"title"`
	Version string `json:"version"`
}

type initializeCapabilities struct {
	ExperimentalAPI bool `json:"experimentalApi"`
}

type DeviceCodeChallenge struct {
	LoginID         string
	VerificationURL string
	UserCode        string
}

type loginStartResponse struct {
	Type            string `json:"type"`
	LoginID         string `json:"loginId"`
	VerificationURL string `json:"verificationUrl"`
	UserCode        string `json:"userCode"`
	AuthURL         string `json:"authUrl"`
}

type loginCompletedNotification struct {
	LoginID *string `json:"loginId"`
	Success bool    `json:"success"`
	Error   *string `json:"error"`
}

type LoginCompletion struct {
	LoginID string
	Success bool
}

type Account struct {
	Type     string  `json:"type"`
	Email    *string `json:"email"`
	PlanType string  `json:"planType"`
}

type AccountReadResult struct {
	Account            *Account `json:"account"`
	RequiresOpenAIAuth bool     `json:"requiresOpenaiAuth"`
}

type Model struct {
	CatalogItemID            string            `json:"id"`
	ModelKey                 string            `json:"model"`
	DisplayName              string            `json:"displayName"`
	Description              string            `json:"description"`
	Hidden                   bool              `json:"hidden"`
	IsDefault                bool              `json:"isDefault"`
	InputModalities          []string          `json:"inputModalities"`
	DefaultReasoningEffort   string            `json:"defaultReasoningEffort"`
	SupportedReasoningEffort []ReasoningEffort `json:"supportedReasoningEfforts"`
	Upgrade                  *string           `json:"upgrade"`
}

type ReasoningEffort struct {
	ReasoningEffort string `json:"reasoningEffort"`
	Description     string `json:"description"`
}

type modelListResponse struct {
	Data       []Model `json:"data"`
	NextCursor *string `json:"nextCursor"`
}

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc,omitempty"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type Notification struct {
	Method string
	Params json.RawMessage
}
