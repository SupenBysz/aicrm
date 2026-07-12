package store_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/desktopactivation"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/desktophandoff"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
	_ "github.com/jackc/pgx/v5/stdlib"
)

func TestDesktopCredentialActivationRecoveryAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("KY_AGENT_EXECUTOR_DESKTOP_ACTIVATION_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set KY_AGENT_EXECUTOR_DESKTOP_ACTIVATION_TEST_DATABASE_URL for PostgreSQL integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	control, err := store.OpenControl(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = control.Close() }()

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	actorID := "owner_activation_recovery_" + suffix
	signer, publicKey := desktopTokenSigner(t, 177, "desktop-activation-recovery")
	keys := trustedtoken.KeySet{"desktop-activation-recovery": publicKey}
	nonceSecret := []byte("desktop-activation-recovery-secret-v1")
	handoffManager, err := desktophandoff.New(control, signer, keys, nonceSecret)
	if err != nil {
		t.Fatal(err)
	}
	activationManager, err := desktopactivation.New(control, signer, keys, nonceSecret)
	if err != nil {
		t.Fatal(err)
	}

	t.Run("expired exact lease interrupts session and is replay safe", func(t *testing.T) {
		flow, proof := prepareDesktopActivationFixture(t, ctx, db, control,
			handoffManager, activationManager, actorID, "lease_expired_"+suffix, 181,
			"authorize", "", desktopDigest("lease-expired-account-"+suffix))
		if _, err := db.ExecContext(ctx, `
			UPDATE ky_ai_executor_operation_lease
			SET lease_expires_at=transaction_timestamp()-interval '1 second'
			WHERE executor_id=$1
		`, flow.executorID); err != nil {
			t.Fatal(err)
		}
		if result, err := control.ReconcileDesktopCredentialActivations(ctx, 64); err != nil || result.Reconciled != 1 {
			t.Fatalf("reconciled=%#v err=%v", result, err)
		}
		assertDesktopActivationRecoveryState(t, ctx, db, flow, proof,
			"expired", "quarantined", "expired", "interrupted", "desktop_disconnected", 4, 6)
		if result, err := control.ReconcileDesktopCredentialActivations(ctx, 64); err != nil || result != (store.DesktopActivationReconciliationResult{}) {
			t.Fatalf("replay reconciled=%#v err=%v", result, err)
		}
	})

	t.Run("session deadline expires activation and session", func(t *testing.T) {
		flow, proof := prepareDesktopActivationFixture(t, ctx, db, control,
			handoffManager, activationManager, actorID, "deadline_"+suffix, 183,
			"authorize", "", desktopDigest("deadline-account-"+suffix))
		if _, err := db.ExecContext(ctx, `
			UPDATE ky_ai_executor_authorization_session
			SET session_deadline_at=transaction_timestamp()-interval '1 second'
			WHERE id=$1
		`, flow.session.ID); err != nil {
			t.Fatal(err)
		}
		if result, err := control.ReconcileDesktopCredentialActivations(ctx, 64); err != nil || result.Reconciled != 1 {
			t.Fatalf("reconciled=%#v err=%v", result, err)
		}
		assertDesktopActivationRecoveryState(t, ctx, db, flow, proof,
			"expired", "quarantined", "expired", "expired", "session_deadline_exceeded", 4, 6)
	})

	t.Run("new lease owner is never overwritten", func(t *testing.T) {
		flow, proof := prepareDesktopActivationFixture(t, ctx, db, control,
			handoffManager, activationManager, actorID, "takeover_"+suffix, 185,
			"authorize", "", desktopDigest("takeover-account-"+suffix))
		takeoverOperation := "takeover_operation_" + suffix
		takeoverOwner := "takeover_owner_" + suffix
		if _, err := db.ExecContext(ctx, `
			UPDATE ky_ai_executor_operation_lease
			SET operation_id=$2,owner_instance_id=$3,lease_epoch=lease_epoch+1,
			    lease_expires_at=transaction_timestamp()+interval '30 seconds',status='active'
			WHERE executor_id=$1
		`, flow.executorID, takeoverOperation, takeoverOwner); err != nil {
			t.Fatal(err)
		}
		if result, err := control.ReconcileDesktopCredentialActivations(ctx, 64); err != nil || result.Reconciled != 1 {
			t.Fatalf("reconciled=%#v err=%v", result, err)
		}
		assertDesktopActivationRecoveryState(t, ctx, db, flow, proof,
			"fenced", "quarantined", "active", "interrupted", "desktop_disconnected", 4, 6)
		var operationID, owner, status string
		var leaseEpoch int64
		if err := db.QueryRowContext(ctx, `
			SELECT operation_id,owner_instance_id,lease_epoch,status
			FROM ky_ai_executor_operation_lease WHERE executor_id=$1
		`, flow.executorID).Scan(&operationID, &owner, &leaseEpoch, &status); err != nil {
			t.Fatal(err)
		}
		if operationID != takeoverOperation || owner != takeoverOwner ||
			leaseEpoch != proof.Activation.LeaseEpoch+1 || status != "active" {
			t.Fatalf("new lease changed operation=%s owner=%s epoch=%d status=%s",
				operationID, owner, leaseEpoch, status)
		}
	})

	t.Run("terminal session quarantines orphan without rewriting terminal events", func(t *testing.T) {
		flow, proof := prepareDesktopActivationFixture(t, ctx, db, control,
			handoffManager, activationManager, actorID, "terminal_"+suffix, 187,
			"authorize", "", desktopDigest("terminal-account-"+suffix))
		cancelled, transitioned, err := control.CancelAuthorizationSession(ctx, store.CancelAuthorizationInput{
			SessionID: flow.session.ID, ActorID: actorID,
			ExpectedRevision:   proof.SessionRevision,
			IdempotencyKeyHash: desktopDigest("terminal-cancel-key-" + suffix),
			RequestHash:        desktopDigest("terminal-cancel-body-" + suffix),
		})
		if err != nil || !transitioned || cancelled.Status != "cancelled" {
			t.Fatalf("cancelled=%#v transitioned=%v err=%v", cancelled, transitioned, err)
		}
		if result, err := control.ReconcileDesktopCredentialActivations(ctx, 64); err != nil || result.Reconciled != 1 {
			t.Fatalf("reconciled=%#v err=%v", result, err)
		}
		assertDesktopActivationRecoveryState(t, ctx, db, flow, proof,
			"quarantined", "quarantined", "expired", "cancelled", "", 4, 6)
	})

	t.Run("expired lease ACK race has one terminal winner", func(t *testing.T) {
		flow, proof := prepareDesktopActivationFixture(t, ctx, db, control,
			handoffManager, activationManager, actorID, "ack_race_"+suffix, 189,
			"authorize", "", desktopDigest("ack-race-account-"+suffix))
		if _, err := db.ExecContext(ctx, `
			UPDATE ky_ai_executor_operation_lease
			SET lease_expires_at=transaction_timestamp()-interval '1 second'
			WHERE executor_id=$1
		`, flow.executorID); err != nil {
			t.Fatal(err)
		}
		barrier := time.Now().UTC().Truncate(time.Millisecond)
		ackInput := desktopACKInputForFixture(t, flow, proof,
			proof.Activation.ActivationToken, barrier)
		start := make(chan struct{})
		var group sync.WaitGroup
		var reconcileResult store.DesktopActivationReconciliationResult
		var reconcileErr, ackErr error
		group.Add(2)
		go func() {
			defer group.Done()
			<-start
			reconcileResult, reconcileErr = control.ReconcileDesktopCredentialActivations(ctx, 64)
		}()
		go func() {
			defer group.Done()
			<-start
			_, ackErr = activationManager.Acknowledge(ctx, ackInput)
		}()
		close(start)
		group.Wait()
		if reconcileErr != nil || reconcileResult.Reconciled != 1 {
			t.Fatalf("reconciled=%#v err=%v", reconcileResult, reconcileErr)
		}
		if !errors.Is(ackErr, store.ErrExecutorFenced) &&
			!errors.Is(ackErr, store.ErrRevisionConflict) &&
			!errors.Is(ackErr, store.ErrDesktopActivationConflict) {
			t.Fatalf("ACK race error=%v", ackErr)
		}
		assertDesktopActivationRecoveryState(t, ctx, db, flow, proof,
			"expired", "quarantined", "expired", "interrupted", "desktop_disconnected", 4, 6)
		var activeAudits int
		if err := db.QueryRowContext(ctx, `
			SELECT count(*) FROM ky_ai_executor_credential_activation_audit
			WHERE activation_id=$1 AND event_type='activated'
		`, proof.Activation.ActivationID).Scan(&activeAudits); err != nil || activeAudits != 0 {
			t.Fatalf("activated audits=%d err=%v", activeAudits, err)
		}
	})

	t.Run("successful ACK makes late recovery a no-op", func(t *testing.T) {
		flow, proof := prepareDesktopActivationFixture(t, ctx, db, control,
			handoffManager, activationManager, actorID, "ack_wins_"+suffix, 191,
			"authorize", "", desktopDigest("ack-wins-account-"+suffix))
		barrier := time.Now().UTC().Truncate(time.Millisecond)
		if _, err := activationManager.Acknowledge(ctx, desktopACKInputForFixture(
			t, flow, proof, proof.Activation.ActivationToken, barrier,
		)); err != nil {
			t.Fatal(err)
		}
		if result, err := control.ReconcileDesktopCredentialActivations(ctx, 64); err != nil || result != (store.DesktopActivationReconciliationResult{}) {
			t.Fatalf("late recovery result=%#v err=%v", result, err)
		}
	})
}

func assertDesktopActivationRecoveryState(
	t *testing.T,
	ctx context.Context,
	db *sql.DB,
	flow claimedDesktopFlow,
	proof desktopactivation.SubmitProofResult,
	activationStatus, bindingStatus, leaseStatus, sessionStatus, failureCode string,
	sessionRevision, sessionSequence int64,
) {
	t.Helper()
	var actualActivation, actualBinding, actualLease, actualSession, actualFailure string
	var actualRevision, actualSequence, auditCount, credentialOutbox, sessionOutbox int64
	if err := db.QueryRowContext(ctx, `
		SELECT activation.status,binding.status,lease.status,session.status,session.failure_code,
		       session.revision,session.current_sequence,
		       (SELECT count(*) FROM ky_ai_executor_credential_activation_audit audit
		        WHERE audit.activation_id=activation.id AND audit.sequence=2
		          AND audit.event_type=activation.status),
		       (SELECT count(*) FROM ky_ai_executor_control_outbox value
		        WHERE value.aggregate_type='credential_binding'
		          AND value.aggregate_id=activation.executor_id || ':' || activation.credential_revision::text
		          AND value.aggregate_revision=2 AND value.event_type='credential_quarantined'),
		       (SELECT count(*) FROM ky_ai_executor_control_outbox value
		        WHERE value.aggregate_type='authorization_session'
		          AND value.aggregate_id=session.id
		          AND value.event_type IN ('expired','interrupted','credential_quarantined'))
		FROM ky_ai_executor_credential_activation activation
		JOIN ky_ai_executor_credential_binding binding
		  ON binding.executor_id=activation.executor_id
		 AND binding.revision=activation.credential_revision
		JOIN ky_ai_executor_operation_lease lease ON lease.executor_id=activation.executor_id
		JOIN ky_ai_executor_authorization_session session ON session.id=activation.session_id
		WHERE activation.id=$1
	`, proof.Activation.ActivationID).Scan(&actualActivation, &actualBinding,
		&actualLease, &actualSession, &actualFailure, &actualRevision, &actualSequence,
		&auditCount, &credentialOutbox, &sessionOutbox); err != nil {
		t.Fatal(err)
	}
	if actualActivation != activationStatus || actualBinding != bindingStatus ||
		actualLease != leaseStatus || actualSession != sessionStatus ||
		actualFailure != failureCode || actualRevision != sessionRevision ||
		actualSequence != sessionSequence || auditCount != 1 ||
		credentialOutbox != 1 || sessionOutbox != 1 {
		t.Fatalf("recovery activation=%s binding=%s lease=%s session=%s failure=%s revision=%d sequence=%d audit=%d credentialOutbox=%d sessionOutbox=%d",
			actualActivation, actualBinding, actualLease, actualSession, actualFailure,
			actualRevision, actualSequence, auditCount, credentialOutbox, sessionOutbox)
	}
	_ = flow
}
