package store

import (
	"database/sql"
	"testing"
	"time"
)

func TestDesktopActivationRecoveryDecisionMatrix(t *testing.T) {
	now := time.Date(2026, time.July, 13, 8, 9, 10, 0, time.UTC)
	activation := DesktopCredentialActivationProjection{
		ID: "activation_1", SessionID: "session_1", ExecutorID: "executor_1",
		DeviceID: "device_1", OperationID: "operation_1", CredentialRevision: 1,
		LeaseEpoch: 2, SourceCredentialRevision: 0, RevocationEpoch: 0,
		DeviceBindingRevision: 1, BindingDigest: "digest_1", ExpiresAt: now.Add(time.Minute),
	}
	executor := storedDesktopActivationExecutor{
		RuntimeType: "desktop", Status: "enabled", CredentialRevisionCounter: 1,
	}
	session := storedDesktopActivationSession{
		ID: "session_1", ExecutorID: "executor_1", RuntimeType: "desktop",
		FlowType: "browser", Status: "verifying", BoundDeviceID: "device_1",
		OperationID: "operation_1", PreparedCredentialRevision: sql.NullInt64{Int64: 1, Valid: true},
		SessionDeadlineAt: now.Add(time.Minute),
	}
	lease := storedDesktopActivationLease{
		OperationID: "operation_1", OwnerInstanceID: "desktop_device_1",
		LeaseEpoch: 2, LeaseExpiresAt: now.Add(time.Minute), Status: "active",
	}
	binding := storedDesktopActivationCandidateBinding{Status: "prepared"}
	deviceBinding := storedDeviceBinding{
		ExecutorID: "executor_1", DeviceID: "device_1", Status: "active", Revision: 1,
	}
	device := storedDevice{Projection: DeviceProjection{
		ID: "device_1", Status: "active", WorkspaceType: "platform", WorkspaceID: "platform_root",
	}}

	if decision := decideDesktopActivationRecovery(executor, session, activation, lease, true,
		binding, deviceBinding, true, device, true, now); decision != (desktopActivationRecoveryDecision{}) {
		t.Fatalf("healthy decision=%#v", decision)
	}

	deadlineActivation := activation
	deadlineActivation.ExpiresAt = now
	assertDesktopActivationDecision(t, decideDesktopActivationRecovery(
		executor, session, deadlineActivation, lease, true, binding,
		deviceBinding, true, device, true, now,
	), "expired", "expired", "session_deadline_exceeded")

	expiredLease := lease
	expiredLease.LeaseExpiresAt = now
	assertDesktopActivationDecision(t, decideDesktopActivationRecovery(
		executor, session, activation, expiredLease, true, binding,
		deviceBinding, true, device, true, now,
	), "expired", "interrupted", "desktop_disconnected")

	takenOverLease := lease
	takenOverLease.OperationID = "new_operation"
	takenOverLease.OwnerInstanceID = "new_owner"
	takenOverLease.LeaseEpoch++
	assertDesktopActivationDecision(t, decideDesktopActivationRecovery(
		executor, session, activation, takenOverLease, true, binding,
		deviceBinding, true, device, true, now,
	), "fenced", "interrupted", "desktop_disconnected")

	terminalSession := session
	terminalSession.Status = "cancelled"
	assertDesktopActivationDecision(t, decideDesktopActivationRecovery(
		executor, terminalSession, activation, lease, true, binding,
		deviceBinding, true, device, true, now,
	), "quarantined", "", "")
}

func assertDesktopActivationDecision(
	t *testing.T,
	decision desktopActivationRecoveryDecision,
	activationStatus, sessionStatus, failureCode string,
) {
	t.Helper()
	if decision.ActivationStatus != activationStatus || decision.SessionStatus != sessionStatus ||
		decision.FailureCode != failureCode {
		t.Fatalf("decision=%#v", decision)
	}
}
