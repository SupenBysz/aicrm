package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestControlStoreAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("KY_AGENT_EXECUTOR_CONTROL_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set KY_AGENT_EXECUTOR_CONTROL_TEST_DATABASE_URL for PostgreSQL integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	control, err := OpenControl(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()

	if _, err := control.db.QueryContext(ctx, `SELECT id FROM ky_user LIMIT 1`); err == nil {
		t.Fatal("writer can read cross-service identity data")
	}

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	input := CreateExecutorInput{
		ID: "aiexec_test_" + suffix, Name: "P2A integration", RuntimeType: "server",
		Status: "enabled", ActorID: "user_platform_owner", TriggerFailureCount: 1,
		MaxAttempts: 2, TaskTimeoutSeconds: 180,
		IdempotencyKeyHash: "1111111111111111111111111111111111111111111111111111111111111111",
		RequestHash:        "2222222222222222222222222222222222222222222222222222222222222222",
	}
	created, err := control.CreateExecutor(ctx, input, "platform", "platform_root")
	if err != nil {
		t.Fatal(err)
	}
	if created.ID != input.ID || created.ScriptMaintenanceReady {
		t.Fatalf("unexpected create projection: %#v", created)
	}
	replayed, err := control.CreateExecutor(ctx, input, "platform", "platform_root")
	if err != nil || replayed.ID != created.ID {
		t.Fatalf("idempotent replay=%#v err=%v", replayed, err)
	}
	changed := input
	changed.RequestHash = "3333333333333333333333333333333333333333333333333333333333333333"
	if _, err := control.CreateExecutor(ctx, changed, "platform", "platform_root"); !errors.Is(err, ErrIdempotencyReuse) {
		t.Fatalf("expected idempotency reuse, got %v", err)
	}

	patched, err := control.PatchExecutor(ctx, created.ID, ExecutorPatch{
		ExpectedRevision: created.ConfigRevision, ActorID: "user_platform_owner",
		NameSet: true, Name: "P2A integration updated",
	}, "platform", "platform_root")
	if err != nil || patched.Name != "P2A integration updated" || patched.ConfigRevision != created.ConfigRevision+1 {
		t.Fatalf("patch=%#v err=%v", patched, err)
	}

	defaultExecutor, err := control.GetExecutor(ctx, "aiexec_platform_codex", "platform", "platform_root")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := control.PatchExecutor(ctx, defaultExecutor.ID, ExecutorPatch{
		ExpectedRevision: defaultExecutor.ConfigRevision, ActorID: "user_platform_owner",
		IsDefaultSet: true, IsDefault: false,
	}, "platform", "platform_root"); !errors.Is(err, ErrDefaultRequired) {
		t.Fatalf("default executor was cleared: %v", err)
	}

	authResult, err := control.CreateAuthorizationSession(ctx, CreateAuthorizationSessionInput{
		ID: "auth_session_" + suffix, ExecutorID: created.ID, Intent: "authorize",
		ActorID:            "user_platform_owner",
		IdempotencyKeyHash: "4444444444444444444444444444444444444444444444444444444444444444",
		RequestHash:        "5555555555555555555555555555555555555555555555555555555555555555",
		Deadline:           time.Now().Add(10 * time.Minute),
	})
	if err != nil || !authResult.Created || authResult.Session.Status != "starting" {
		t.Fatalf("authorization create=%#v err=%v", authResult, err)
	}
	waiting, err := control.MarkAuthorizationWaiting(ctx, authResult.Session.ID, "owner_test",
		"6666666666666666666666666666666666666666666666666666666666666666", authResult.Session.Revision)
	if err != nil || waiting.Status != "waiting_user" {
		t.Fatalf("waiting=%#v err=%v", waiting, err)
	}
	verifying, err := control.MarkAuthorizationVerifying(ctx, waiting.ID, "owner_test", waiting.Revision)
	if err != nil || verifying.Status != "verifying" {
		t.Fatalf("verifying=%#v err=%v", verifying, err)
	}
	prep, err := control.PrepareServerCredential(ctx, CredentialPreparationInput{
		SessionID: verifying.ID, ExpectedSessionRevision: verifying.Revision, OwnerInstanceID: "owner_test",
		OperationID: "auth_operation_" + suffix, RuntimeBindingID: "server_test", RuntimeBindingRevision: 1,
		AccountFingerprint: "7777777777777777777777777777777777777777777777777777777777777777",
		PlanType:           "plus", BindingDigest: "8888888888888888888888888888888888888888888888888888888888888888",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := control.MarkCredentialCommitting(ctx, prep, "auth_operation_"+suffix); err != nil {
		t.Fatal(err)
	}
	stalePrep := prep
	stalePrep.OwnerInstanceID = "stale_owner"
	if err := control.RenewServerCredentialLease(ctx, stalePrep, "auth_operation_"+suffix); !errors.Is(err, ErrExecutorFenced) {
		t.Fatalf("stale owner renewed lease: %v", err)
	}
	if err := control.RenewServerCredentialLease(ctx, prep, "auth_operation_"+suffix); err != nil {
		t.Fatalf("current owner could not renew lease: %v", err)
	}
	summary := []byte(`{"accountFingerprint":"7777777777777777777777777777777777777777777777777777777777777777","emailDomainHash":"9999999999999999999999999999999999999999999999999999999999999999","planType":"plus"}`)
	activated, err := control.ActivateServerCredential(ctx, ActivateServerCredentialInput{
		SessionID: verifying.ID, OwnerInstanceID: "owner_test", OperationID: "auth_operation_" + suffix,
		Preparation: prep, AccountSummaryJSON: summary,
		AccountFingerprint: "7777777777777777777777777777777777777777777777777777777777777777",
		RuntimeBindingID:   "server_test", RuntimeBindingRevision: 1, CodexVersion: "0.144.1",
		Models: []ModelCatalogEntry{{CatalogItemID: "catalog_1", ModelKey: "gpt-5.6", DisplayName: "GPT-5.6", InputModalitiesJSON: []byte(`["image","text"]`), SupportedReasoningJSON: []byte(`["high"]`)}},
	})
	if err != nil || activated.Status != "succeeded" || activated.Failure != nil {
		t.Fatalf("activated=%#v err=%v", activated, err)
	}
	authorized, err := control.GetExecutor(ctx, created.ID, "platform", "platform_root")
	if err != nil || authorized.CredentialStatus != "authorized" || authorized.CurrentCredentialRevision == nil || authorized.ScriptMaintenanceReady {
		t.Fatalf("authorized=%#v err=%v", authorized, err)
	}
	models, err := control.ListModels(ctx, created.ID, false)
	if err != nil || len(models) != 1 || models[0].ModelKey != "gpt-5.6" {
		t.Fatalf("models=%#v err=%v", models, err)
	}
	events, err := control.ListAuthorizationEvents(ctx, activated.ID, 0, 100)
	if err != nil || len(events) != 6 ||
		events[len(events)-2].EventType != AuthorizationEventTerminal ||
		events[len(events)-1].EventType != AuthorizationEventClosed {
		t.Fatalf("events=%#v err=%v", events, err)
	}

	cancelResult, err := control.CreateAuthorizationSession(ctx, CreateAuthorizationSessionInput{
		ID: "auth_cancel_" + suffix, ExecutorID: created.ID, Intent: "change_account", ActorID: "user_platform_owner",
		IdempotencyKeyHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RequestHash:        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		Deadline:           time.Now().Add(10 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, transitioned, err := control.CancelAuthorizationSession(ctx, CancelAuthorizationInput{
		SessionID: cancelResult.Session.ID, ActorID: "user_not_requester", ExpectedRevision: cancelResult.Session.Revision,
		IdempotencyKeyHash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
		RequestHash:        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
	}); !errors.Is(err, ErrRequesterMismatch) || transitioned {
		t.Fatalf("cross-requester cancel transitioned=%v err=%v", transitioned, err)
	}
	unchanged, err := control.GetAuthorizationSession(ctx, cancelResult.Session.ID)
	if err != nil || unchanged.Status != "starting" || unchanged.Revision != cancelResult.Session.Revision {
		t.Fatalf("rejected cancel changed session=%#v err=%v", unchanged, err)
	}
	cancelled, transitioned, err := control.CancelAuthorizationSession(ctx, CancelAuthorizationInput{
		SessionID: cancelResult.Session.ID, ActorID: "user_platform_owner", ExpectedRevision: cancelResult.Session.Revision,
		IdempotencyKeyHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		RequestHash:        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
	})
	if err != nil || !transitioned || cancelled.Status != "cancelled" {
		t.Fatalf("cancelled=%#v transitioned=%v err=%v", cancelled, transitioned, err)
	}
	cancelEvents, err := control.ListAuthorizationEvents(ctx, cancelled.ID, 0, 100)
	if err != nil || len(cancelEvents) != 4 ||
		cancelEvents[len(cancelEvents)-2].EventType != AuthorizationEventTerminal ||
		cancelEvents[len(cancelEvents)-1].EventType != AuthorizationEventClosed {
		t.Fatalf("cancel events=%#v err=%v", cancelEvents, err)
	}

	recoveryResult, err := control.CreateAuthorizationSession(ctx, CreateAuthorizationSessionInput{
		ID: "auth_recovery_" + suffix, ExecutorID: created.ID, Intent: "authorize",
		ActorID:            "user_platform_owner",
		IdempotencyKeyHash: "1212121212121212121212121212121212121212121212121212121212121212",
		RequestHash:        "3434343434343434343434343434343434343434343434343434343434343434",
		Deadline:           time.Now().Add(10 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	recoveryWaiting, err := control.MarkAuthorizationWaiting(ctx, recoveryResult.Session.ID, "owner_before_restart",
		"5656565656565656565656565656565656565656565656565656565656565656", recoveryResult.Session.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := control.RecoverInterruptedAuthorizationSessions(ctx, "owner_after_restart"); err != nil {
		t.Fatal(err)
	}
	recovered, err := control.GetAuthorizationSession(ctx, recoveryWaiting.ID)
	if err != nil || recovered.Status != "interrupted" || recovered.Failure == nil || recovered.Failure.Code != "service_restarted" {
		t.Fatalf("recovered=%#v err=%v", recovered, err)
	}
	recoveryEvents, err := control.ListAuthorizationEvents(ctx, recovered.ID, 0, 100)
	if err != nil || len(recoveryEvents) != 5 || recoveryEvents[3].EventType != AuthorizationEventTerminal || recoveryEvents[4].EventType != AuthorizationEventClosed {
		t.Fatalf("recovery events=%#v err=%v", recoveryEvents, err)
	}
	if _, err := control.RecoverInterruptedAuthorizationSessions(ctx, "owner_after_restart"); err != nil {
		t.Fatal(err)
	}
	replayedRecoveryEvents, err := control.ListAuthorizationEvents(ctx, recovered.ID, 0, 100)
	if err != nil || len(replayedRecoveryEvents) != len(recoveryEvents) {
		t.Fatalf("repeated recovery added events=%#v err=%v", replayedRecoveryEvents, err)
	}

	preparedRecovery, err := control.CreateAuthorizationSession(ctx, CreateAuthorizationSessionInput{
		ID: "auth_prepared_recovery_" + suffix, ExecutorID: created.ID, Intent: "change_account",
		ActorID:            "user_platform_owner",
		IdempotencyKeyHash: "7878787878787878787878787878787878787878787878787878787878787878",
		RequestHash:        "9090909090909090909090909090909090909090909090909090909090909090",
		Deadline:           time.Now().Add(10 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	preparedWaiting, err := control.MarkAuthorizationWaiting(ctx, preparedRecovery.Session.ID, "owner_prepared_restart",
		"abababababababababababababababababababababababababababababababab", preparedRecovery.Session.Revision)
	if err != nil {
		t.Fatal(err)
	}
	preparedVerifying, err := control.MarkAuthorizationVerifying(ctx, preparedWaiting.ID, "owner_prepared_restart", preparedWaiting.Revision)
	if err != nil {
		t.Fatal(err)
	}
	preparedCandidate, err := control.PrepareServerCredential(ctx, CredentialPreparationInput{
		SessionID: preparedVerifying.ID, ExpectedSessionRevision: preparedVerifying.Revision,
		OwnerInstanceID: "owner_prepared_restart", OperationID: "auth_prepared_operation_" + suffix,
		RuntimeBindingID: "server_test", RuntimeBindingRevision: 1,
		AccountFingerprint: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
		PlanType:           "plus", BindingDigest: "efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := control.RecoverInterruptedAuthorizationSessions(ctx, "owner_after_prepared_restart"); !errors.Is(err, ErrCredentialRecoveryRequired) {
		t.Fatalf("prepared recovery did not fail closed: %v", err)
	}
	stillVerifying, err := control.GetAuthorizationSession(ctx, preparedVerifying.ID)
	if err != nil || stillVerifying.Status != "verifying" || stillVerifying.PreparedCredentialRev == nil {
		t.Fatalf("prepared candidate changed during fail-closed recovery: %#v err=%v", stillVerifying, err)
	}
	staleCandidate := preparedCandidate
	staleCandidate.OwnerInstanceID = "stale_prepared_owner"
	if _, _, err := control.QuarantineServerCredential(ctx, preparedVerifying.ID, staleCandidate,
		"auth_prepared_operation_"+suffix, "failed", "credential_commit_failed"); !errors.Is(err, ErrExecutorFenced) {
		t.Fatalf("stale owner quarantined candidate: %v", err)
	}
	quarantined, shouldQuarantineFS, err := control.QuarantineServerCredential(ctx, preparedVerifying.ID, preparedCandidate,
		"auth_prepared_operation_"+suffix, "failed", "credential_commit_failed")
	if err != nil || !shouldQuarantineFS || quarantined.Status != "failed" {
		t.Fatalf("quarantined=%#v cleanup=%v err=%v", quarantined, shouldQuarantineFS, err)
	}
	var bindingStatus, leaseStatus string
	if err := control.db.QueryRowContext(ctx, `SELECT status FROM ky_ai_executor_credential_binding WHERE executor_id=$1 AND revision=$2`,
		preparedCandidate.ExecutorID, preparedCandidate.CredentialRevision).Scan(&bindingStatus); err != nil {
		t.Fatal(err)
	}
	if err := control.db.QueryRowContext(ctx, `SELECT status FROM ky_ai_executor_operation_lease WHERE executor_id=$1`,
		preparedCandidate.ExecutorID).Scan(&leaseStatus); err != nil {
		t.Fatal(err)
	}
	if bindingStatus != "quarantined" || leaseStatus != "fenced" {
		t.Fatalf("binding=%s lease=%s", bindingStatus, leaseStatus)
	}
}
