package store

import (
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
)

func TestDesktopAuthorizationCommandTicketRequiresJTIMatchOperationID(t *testing.T) {
	issuedAt := time.Date(2026, 7, 13, 4, 0, 0, 0, time.UTC)
	item := DesktopAuthorizationCommandProjection{
		OperationID: "desktop_command_jti_1", SessionID: "auth_session_jti_1",
		ExecutorID: "executor_jti_1", DeviceID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ActorID: "actor_jti_1", Purpose: "authorization_cancel",
		ExpectedSessionRevision: 2,
		CommandTicketHash:       "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		TokenNonceHash:          "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		TokenIssuedAt:           issuedAt,
		ExpiresAt:               issuedAt.Add(DesktopAuthorizationCommandTicketLifetime).Format(time.RFC3339Nano),
	}
	input := AcknowledgeDesktopAuthorizationCommandInput{
		Purpose: item.Purpose, ExpectedSessionRevision: item.ExpectedSessionRevision,
		Proof: deviceauth.VerifiedRequest{AuthorizationTokenHash: item.CommandTicketHash},
	}
	verified := VerifiedDesktopAuthorizationCommandTicket{
		TokenHash: item.CommandTicketHash, NonceHash: item.TokenNonceHash,
		TokenID: "desktop_command_different_jti", ActorID: item.ActorID,
		SessionID: item.SessionID, ExecutorID: item.ExecutorID, DeviceID: item.DeviceID,
		OperationID: item.OperationID, Purpose: item.Purpose,
		ExpectedSessionRevision: item.ExpectedSessionRevision,
		IssuedAt:                issuedAt, ExpiresAt: issuedAt.Add(DesktopAuthorizationCommandTicketLifetime),
	}
	if matchesDesktopAuthorizationCommandTicket(item, input, verified) {
		t.Fatal("ticket with a different jti must not match even when operationId matches")
	}
	verified.TokenID = item.OperationID
	if !matchesDesktopAuthorizationCommandTicket(item, input, verified) {
		t.Fatal("fully target-bound ticket should match")
	}
}
