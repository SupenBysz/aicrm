package brokerprotocol

const (
	Version        = 1
	MessageLaunch  = "launch"
	MessageCancel  = "cancel"
	MessageStarted = "started"
	MessageExited  = "exited"
	MessageFailed  = "failed"
	MaximumBytes   = 4096
)

type Message struct {
	Version        int    `json:"version"`
	Type           string `json:"type"`
	OperationID    string `json:"operationId,omitempty"`
	CredentialHome string `json:"credentialHome,omitempty"`
	FailureCode    string `json:"failureCode,omitempty"`
}
