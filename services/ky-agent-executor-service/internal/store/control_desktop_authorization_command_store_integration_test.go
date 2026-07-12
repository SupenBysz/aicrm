package store_test

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/desktopcommand"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
	_ "github.com/jackc/pgx/v5/stdlib"
)

type desktopCommandFixture struct {
	actorID        string
	actorSessionID string
	executorID     string
	sessionID      string
	session        store.AuthorizationSessionProjection
	device         bindingDeviceFixture
}

func TestDesktopAuthorizationCommandAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("KY_AGENT_EXECUTOR_DESKTOP_COMMAND_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set KY_AGENT_EXECUTOR_DESKTOP_COMMAND_TEST_DATABASE_URL for PostgreSQL integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
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

	oldSigner, oldPublic := desktopTokenSigner(t, 73, "desktop-command-old")
	nonceSecret := []byte("desktop-command-postgres-nonce-secret-v1")
	manager, err := desktopcommand.New(control, oldSigner,
		trustedtoken.KeySet{"desktop-command-old": oldPublic}, nonceSecret)
	if err != nil {
		t.Fatal(err)
	}

	t.Run("starting cancel never infers the active binding as a trusted target", func(t *testing.T) {
		fixture := seedDesktopCommandFixture(t, ctx, db, control, suffix+"_starting", 131, "starting", true)
		input := desktopCommandCreateInput(fixture, fixture.session.Revision, "starting-key", "starting-body")
		result, err := manager.Cancel(ctx, input)
		if err != nil || result.CommandCreated || result.CommandTicket != "" ||
			result.Session.Status != "cancelled" || result.Session.Revision != 2 ||
			result.Session.Sequence != 4 {
			t.Fatalf("starting cancel=%#v err=%v", result, err)
		}
		replay, err := manager.Cancel(ctx, input)
		if err != nil || replay.CommandCreated || replay.CommandTicket != "" || !replay.Replayed {
			t.Fatalf("starting replay=%#v err=%v", replay, err)
		}
		var commandCount int
		if err := db.QueryRowContext(ctx, `
			SELECT count(*) FROM ky_ai_executor_desktop_command_operation WHERE session_id=$1
		`, fixture.sessionID).Scan(&commandCount); err != nil || commandCount != 0 {
			t.Fatalf("starting command count=%d err=%v", commandCount, err)
		}
	})

	t.Run("bound cancel is atomic, concurrent and restart replayable", func(t *testing.T) {
		fixture := seedDesktopCommandFixture(t, ctx, db, control, suffix+"_bound", 141, "waiting_user", true)
		input := desktopCommandCreateInput(fixture, fixture.session.Revision, "shared-key", "shared-body")
		const workers = 10
		results := make(chan store.CreateDesktopAuthorizationCommandResult, workers)
		errorsCh := make(chan error, workers)
		var group sync.WaitGroup
		for worker := 0; worker < workers; worker++ {
			group.Add(1)
			go func() {
				defer group.Done()
				result, createErr := manager.Cancel(ctx, input)
				if createErr != nil {
					errorsCh <- createErr
					return
				}
				results <- result
			}()
		}
		group.Wait()
		close(results)
		close(errorsCh)
		for createErr := range errorsCh {
			t.Fatal(createErr)
		}
		var first store.CreateDesktopAuthorizationCommandResult
		created := 0
		for result := range results {
			if first.Command.OperationID == "" {
				first = result
			}
			if result.Command.OperationID != first.Command.OperationID ||
				result.CommandTicket != first.CommandTicket || result.Session.Status != "cancelled" ||
				result.Session.Revision != 3 || result.Session.Sequence != 5 {
				t.Fatalf("non-deterministic cancel first=%#v next=%#v", first, result)
			}
			if !result.Replayed {
				created++
			}
		}
		if created != 1 || !first.CommandCreated || first.Command.DeviceID != fixture.device.deviceID {
			t.Fatalf("created=%d result=%#v", created, first)
		}
		assertDesktopCommandCounts(t, ctx, db, first.Command.OperationID, 1, 1)

		restarted, err := desktopcommand.New(control, oldSigner,
			trustedtoken.KeySet{"desktop-command-old": oldPublic}, nonceSecret)
		if err != nil {
			t.Fatal(err)
		}
		replay, err := restarted.Cancel(ctx, input)
		if err != nil || replay.CommandTicket != first.CommandTicket ||
			replay.Command.OperationID != first.Command.OperationID || !replay.Replayed {
			t.Fatalf("restart replay=%#v err=%v", replay, err)
		}
		reloginInput := input
		reloginInput.ActorSessionID = fixture.actorSessionID + "_new_host_login"
		reloginReplay, err := restarted.Cancel(ctx, reloginInput)
		if err != nil || reloginReplay.CommandTicket != first.CommandTicket ||
			reloginReplay.Command.OperationID != first.Command.OperationID || !reloginReplay.Replayed ||
			reloginReplay.Command.ActorSessionID != fixture.actorSessionID {
			t.Fatalf("cross-host replay=%#v err=%v", reloginReplay, err)
		}
		changed := input
		changed.RequestHash = desktopDigest("changed-body-" + suffix)
		if _, err := restarted.Cancel(ctx, changed); !errors.Is(err, store.ErrIdempotencyReuse) {
			t.Fatalf("changed body err=%v", err)
		}

		terminalNewKey := desktopCommandCreateInput(
			fixture, replay.Session.Revision, "terminal-new-key", "terminal-new-body",
		)
		terminal, err := restarted.Cancel(ctx, terminalNewKey)
		if err != nil || terminal.CommandCreated || terminal.CommandTicket != "" ||
			terminal.Session.Status != "cancelled" {
			t.Fatalf("terminal new key=%#v err=%v", terminal, err)
		}
		terminalReplay, err := restarted.Cancel(ctx, terminalNewKey)
		if err != nil || terminalReplay.CommandCreated || !terminalReplay.Replayed {
			t.Fatalf("terminal replay=%#v err=%v", terminalReplay, err)
		}

		ackTime := time.Now().UTC().Truncate(time.Millisecond)
		ack := signedDesktopCommandACK(t, fixture.device, first.CommandTicket, first.Command,
			"succeeded", "", ackTime, desktopNonce(1), 1)
		before := getAuthorizationSessionState(t, ctx, db, fixture.sessionID)
		ackResult, err := restarted.Acknowledge(ctx, ack.input, first.CommandTicket)
		if err != nil || ackResult.Command.Status != "succeeded" || ackResult.Replayed {
			t.Fatalf("ACK=%#v err=%v", ackResult, err)
		}
		after := getAuthorizationSessionState(t, ctx, db, fixture.sessionID)
		if before != after {
			t.Fatalf("ACK changed session before=%v after=%v", before, after)
		}
		ackReplay, err := restarted.Acknowledge(ctx, ack.input, first.CommandTicket)
		if err != nil || !ackReplay.Replayed || ackReplay.Command.Status != "succeeded" {
			t.Fatalf("ACK replay=%#v err=%v", ackReplay, err)
		}
		altered := signedDesktopCommandACK(t, fixture.device, first.CommandTicket, first.Command,
			"failed", "altered_result", ackTime, desktopNonce(1), 1)
		if _, err := restarted.Acknowledge(ctx, altered.input, first.CommandTicket); !errors.Is(err, store.ErrDeviceProofReplayed) {
			t.Fatalf("altered exact sequence err=%v", err)
		}
		assertDesktopCommandCounts(t, ctx, db, first.Command.OperationID, 2, 2)
		assertDesktopCommandTokenAbsent(t, ctx, db, first.CommandTicket)
	})

	t.Run("same actor and executor may reuse key in a different session", func(t *testing.T) {
		fixture := seedDesktopCommandFixture(t, ctx, db, control, suffix+"_scope", 151, "waiting_user", true)
		first, err := manager.Cancel(ctx, desktopCommandCreateInput(fixture, 2, "scope-key", "scope-body"))
		if err != nil || !first.CommandCreated {
			t.Fatalf("first=%#v err=%v", first, err)
		}
		secondSession, err := control.CreateAuthorizationSession(ctx, store.CreateAuthorizationSessionInput{
			ID: "auth_command_scope_second_" + suffix, ExecutorID: fixture.executorID,
			Intent: "authorize", ActorID: fixture.actorID,
			IdempotencyKeyHash: desktopDigest("scope-second-session-key-" + suffix),
			RequestHash:        desktopDigest("scope-second-session-body-" + suffix),
			Deadline:           time.Now().UTC().Add(10 * time.Minute),
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `
			UPDATE ky_ai_executor_authorization_session
			SET status='waiting_user',bound_device_id=$2,revision=2,current_sequence=2,
			    updated_at=transaction_timestamp()
			WHERE id=$1
		`, secondSession.Session.ID, fixture.device.deviceID); err != nil {
			t.Fatal(err)
		}
		seedDesktopCommandHandoff(t, ctx, db, secondSession.Session.ID, fixture.executorID,
			fixture.device.deviceID, fixture.actorID, suffix+"_scope_second")
		secondInput := desktopcommand.CreateInput{
			SessionID: secondSession.Session.ID, ActorID: fixture.actorID,
			ActorSessionID: fixture.actorSessionID, ExpectedSessionRevision: 2,
			IdempotencyKeyHash: desktopDigest("scope-key"), RequestHash: desktopDigest("scope-body"),
		}
		second, err := manager.Cancel(ctx, secondInput)
		if err != nil || !second.CommandCreated || second.Command.OperationID == first.Command.OperationID {
			t.Fatalf("second=%#v err=%v", second, err)
		}
	})

	t.Run("bound device drift terminalizes without signing to replacement", func(t *testing.T) {
		oldDevice := newBindingDeviceFixture(t, 161)
		fixture := seedDesktopCommandFixtureWithDevice(t, ctx, db, control,
			suffix+"_drift", oldDevice, "waiting_user", true)
		newDevice := newBindingDeviceFixture(t, 171)
		insertDesktopCommandDevice(t, ctx, db, newDevice, fixture.actorID)
		if _, err := db.ExecContext(ctx, `
			UPDATE ky_ai_executor_device_binding
			SET device_id=$2,revision=revision+1,updated_at=transaction_timestamp()
			WHERE executor_id=$1
		`, fixture.executorID, newDevice.deviceID); err != nil {
			t.Fatal(err)
		}
		result, err := manager.Cancel(ctx,
			desktopCommandCreateInput(fixture, fixture.session.Revision, "drift-key", "drift-body"))
		if err != nil || result.CommandCreated || result.CommandTicket != "" ||
			result.Session.Status != "cancelled" {
			t.Fatalf("drift cancel=%#v err=%v", result, err)
		}
		var commandCount int
		if err := db.QueryRowContext(ctx, `
			SELECT count(*) FROM ky_ai_executor_desktop_command_operation WHERE session_id=$1
		`, fixture.sessionID).Scan(&commandCount); err != nil || commandCount != 0 {
			t.Fatalf("command count=%d err=%v", commandCount, err)
		}
	})

	t.Run("verifying cancel quarantines prepared state and fences the lease atomically", func(t *testing.T) {
		label := suffix + "_prepared_cancel"
		fixture := seedDesktopCommandFixture(t, ctx, db, control, label, 176, "waiting_user", true)
		operationID, activationID := seedPreparedDesktopCommandActivation(t, ctx, db, fixture, label)
		fixture.session, err = control.GetAuthorizationSession(ctx, fixture.sessionID)
		if err != nil || fixture.session.Status != "verifying" || fixture.session.Revision != 3 {
			t.Fatalf("prepared session=%#v err=%v", fixture.session, err)
		}
		result, err := manager.Cancel(ctx,
			desktopCommandCreateInput(fixture, 3, "prepared-cancel-key", "prepared-cancel-body"))
		if err != nil || !result.CommandCreated || result.CommandTicket == "" ||
			result.Session.Status != "cancelled" || result.Session.Revision != 4 {
			t.Fatalf("prepared cancel=%#v err=%v", result, err)
		}
		var handoffStatus, bindingStatus, activationStatus, leaseStatus string
		var claimConsumed sql.NullTime
		var activationAudit, credentialOutbox int
		if err := db.QueryRowContext(ctx, `
			SELECT handoff.status,handoff.claim_consumed_at,binding.status,activation.status,lease.status,
			 (SELECT count(*) FROM ky_ai_executor_credential_activation_audit audit
			  WHERE audit.activation_id=activation.id AND audit.sequence=2
			    AND audit.event_type='quarantined'),
			 (SELECT count(*) FROM ky_ai_executor_control_outbox value
			  WHERE value.aggregate_type='credential_binding'
			    AND value.aggregate_id=activation.executor_id || ':' || activation.credential_revision::text
			    AND value.aggregate_revision=2 AND value.event_type='credential_quarantined')
			FROM ky_ai_executor_desktop_handoff handoff
			JOIN ky_ai_executor_credential_binding binding
			  ON binding.executor_id=handoff.executor_id AND binding.revision=1
			JOIN ky_ai_executor_credential_activation activation
			  ON activation.session_id=handoff.session_id
			JOIN ky_ai_executor_operation_lease lease
			  ON lease.executor_id=handoff.executor_id AND lease.operation_id=activation.operation_id
			WHERE handoff.session_id=$1 AND activation.id=$2 AND lease.operation_id=$3
		`, fixture.sessionID, activationID, operationID).Scan(
			&handoffStatus, &claimConsumed, &bindingStatus, &activationStatus, &leaseStatus,
			&activationAudit, &credentialOutbox,
		); err != nil {
			t.Fatal(err)
		}
		if handoffStatus != "cancelled" || !claimConsumed.Valid ||
			bindingStatus != "quarantined" || activationStatus != "quarantined" ||
			leaseStatus != "fenced" || activationAudit != 1 || credentialOutbox != 1 {
			t.Fatalf("prepared cleanup handoff=%s consumed=%v binding=%s activation=%s lease=%s audit=%d outbox=%d",
				handoffStatus, claimConsumed.Valid, bindingStatus, activationStatus, leaseStatus,
				activationAudit, credentialOutbox)
		}
	})

	t.Run("reopen ACK never mutates session and stale state is normalized", func(t *testing.T) {
		fixture := seedDesktopCommandFixture(t, ctx, db, control, suffix+"_reopen", 181, "waiting_user", true)
		input := desktopCommandCreateInput(fixture, fixture.session.Revision, "reopen-key", "reopen-body")
		result, err := manager.Reopen(ctx, input)
		if err != nil || !result.CommandCreated || result.Session.Status != "waiting_user" {
			t.Fatalf("reopen=%#v err=%v", result, err)
		}
		before := getAuthorizationSessionState(t, ctx, db, fixture.sessionID)
		ackTime := time.Now().UTC().Truncate(time.Millisecond)
		ack := signedDesktopCommandACK(t, fixture.device, result.CommandTicket, result.Command,
			"succeeded", "", ackTime, desktopNonce(1), 1)
		ackResult, err := manager.Acknowledge(ctx, ack.input, result.CommandTicket)
		if err != nil || ackResult.Command.Status != "succeeded" {
			t.Fatalf("reopen ACK=%#v err=%v", ackResult, err)
		}
		if after := getAuthorizationSessionState(t, ctx, db, fixture.sessionID); before != after {
			t.Fatalf("reopen ACK changed session before=%v after=%v", before, after)
		}

		staleFixture := seedDesktopCommandFixture(t, ctx, db, control, suffix+"_stale", 191, "waiting_user", true)
		staleCreate, err := manager.Reopen(ctx,
			desktopCommandCreateInput(staleFixture, 2, "stale-key", "stale-body"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `
			UPDATE ky_ai_executor_authorization_session
			SET status='cancelled',revision=revision+1,current_sequence=current_sequence+3,
			    finished_at=transaction_timestamp(),updated_at=transaction_timestamp()
			WHERE id=$1
		`, staleFixture.sessionID); err != nil {
			t.Fatal(err)
		}
		staleACK := signedDesktopCommandACK(t, staleFixture.device, staleCreate.CommandTicket,
			staleCreate.Command, "succeeded", "", ackTime, desktopNonce(1), 1)
		staleResult, err := manager.Acknowledge(ctx, staleACK.input, staleCreate.CommandTicket)
		if err != nil || staleResult.Command.Status != "stale_target" {
			t.Fatalf("stale ACK=%#v err=%v", staleResult, err)
		}
	})

	t.Run("removed verification key fails before consuming device ledger", func(t *testing.T) {
		fixture := seedDesktopCommandFixture(t, ctx, db, control, suffix+"_rotation", 201, "waiting_user", true)
		created, err := manager.Cancel(ctx,
			desktopCommandCreateInput(fixture, 2, "rotation-key", "rotation-body"))
		if err != nil {
			t.Fatal(err)
		}
		newSigner, newPublic := desktopTokenSigner(t, 83, "desktop-command-new")
		rotated, err := desktopcommand.New(control, newSigner,
			trustedtoken.KeySet{"desktop-command-new": newPublic}, nonceSecret)
		if err != nil {
			t.Fatal(err)
		}
		ackTime := time.Now().UTC().Truncate(time.Millisecond)
		ack := signedDesktopCommandACK(t, fixture.device, created.CommandTicket, created.Command,
			"succeeded", "", ackTime, desktopNonce(1), 1)
		if _, err := rotated.Acknowledge(ctx, ack.input, created.CommandTicket); !errors.Is(err, trustedtoken.ErrUnknownKey) {
			t.Fatalf("rotation err=%v", err)
		}
		var sequence int64
		if err := db.QueryRowContext(ctx, `SELECT last_accepted_sequence FROM ky_ai_executor_device WHERE id=$1`,
			fixture.device.deviceID).Scan(&sequence); err != nil || sequence != 0 {
			t.Fatalf("sequence=%d err=%v", sequence, err)
		}
		if _, err := manager.Acknowledge(ctx, ack.input, created.CommandTicket); err != nil {
			t.Fatalf("old verifier should still accept untouched ACK: %v", err)
		}
	})
}

func seedDesktopCommandFixture(
	t *testing.T,
	ctx context.Context,
	db *sql.DB,
	control *store.ControlStore,
	label string,
	seedByte byte,
	status string,
	withBinding bool,
) desktopCommandFixture {
	t.Helper()
	return seedDesktopCommandFixtureWithDevice(t, ctx, db, control, label,
		newBindingDeviceFixture(t, seedByte), status, withBinding)
}

func seedDesktopCommandFixtureWithDevice(
	t *testing.T,
	ctx context.Context,
	db *sql.DB,
	control *store.ControlStore,
	label string,
	device bindingDeviceFixture,
	status string,
	withBinding bool,
) desktopCommandFixture {
	t.Helper()
	actorID := "desktop_command_actor_" + label
	actorSessionID := "desktop_command_actor_session_" + label
	insertDesktopCommandDevice(t, ctx, db, device, actorID)
	executorID := "aiexec_desktop_command_" + label
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_config (
		 id,name,scope_type,scope_id,executor_type,runtime_type,status,is_default,
		 max_concurrency,credential_status
		) VALUES ($1,'Desktop command integration','platform','platform_root','codex',
		 'desktop','enabled',false,1,'not_authorized')
	`, executorID); err != nil {
		t.Fatal(err)
	}
	if withBinding {
		if _, err := db.ExecContext(ctx, `
			INSERT INTO ky_ai_executor_device_binding (
			 executor_id,device_id,revision,status,bound_by
			) VALUES ($1,$2,1,'active',$3)
		`, executorID, device.deviceID, actorID); err != nil {
			t.Fatal(err)
		}
	}
	result, err := control.CreateAuthorizationSession(ctx, store.CreateAuthorizationSessionInput{
		ID: "auth_desktop_command_" + label, ExecutorID: executorID,
		Intent: "authorize", ActorID: actorID,
		IdempotencyKeyHash: desktopDigest(label + ":session-key"),
		RequestHash:        desktopDigest(label + ":session-body"),
		Deadline:           time.Now().UTC().Add(10 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if status == "waiting_user" {
		if _, err := db.ExecContext(ctx, `
			UPDATE ky_ai_executor_authorization_session
			SET status='waiting_user',bound_device_id=$2,revision=2,current_sequence=2,
			    updated_at=transaction_timestamp()
			WHERE id=$1
		`, result.Session.ID, device.deviceID); err != nil {
			t.Fatal(err)
		}
		seedDesktopCommandHandoff(t, ctx, db, result.Session.ID, executorID, device.deviceID, actorID, label)
		result.Session, err = control.GetAuthorizationSession(ctx, result.Session.ID)
		if err != nil {
			t.Fatal(err)
		}
	}
	return desktopCommandFixture{
		actorID: actorID, actorSessionID: actorSessionID, executorID: executorID,
		sessionID: result.Session.ID, session: result.Session, device: device,
	}
}

func insertDesktopCommandDevice(
	t *testing.T,
	ctx context.Context,
	db *sql.DB,
	device bindingDeviceFixture,
	actorID string,
) {
	t.Helper()
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_device (
		 id,public_key,status,label,registered_by,workspace_type,workspace_id,last_heartbeat_at
		) VALUES ($1,$2,'active','desktop-command',$3,'platform','platform_root',transaction_timestamp())
	`, device.deviceID, device.publicKey, actorID); err != nil {
		t.Fatal(err)
	}
}

func seedDesktopCommandHandoff(
	t *testing.T,
	ctx context.Context,
	db *sql.DB,
	sessionID, executorID, deviceID, actorID, label string,
) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Second)
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_desktop_handoff (
		 id,session_id,executor_id,device_id,requested_by,expected_session_revision,
		 idempotency_key_hash,request_hash,ticket_hash,ticket_nonce_hash,token_key_id,
		 status,issued_at,expires_at,claimed_at,claim_token_hash,claim_token_key_id,
		 claim_token_nonce_hash,claim_token_issued_at,claim_expires_at,claimed_session_revision
		) VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,'handoff-test-key','claimed',$10::timestamptz,
		 $10::timestamptz+interval '120 seconds',$10::timestamptz,$11,'claim-test-key',$12,
		 $10::timestamptz,$10::timestamptz+interval '5 minutes',2)
	`, "handoff_desktop_command_"+label, sessionID, executorID, deviceID, actorID,
		desktopDigest(label+":handoff-idem"), desktopDigest(label+":handoff-body"),
		desktopDigest(label+":handoff-ticket"), desktopDigest(label+":handoff-nonce"),
		now, desktopDigest(label+":claim-token"), desktopDigest(label+":claim-nonce")); err != nil {
		t.Fatal(err)
	}
}

func seedPreparedDesktopCommandActivation(
	t *testing.T,
	ctx context.Context,
	db *sql.DB,
	fixture desktopCommandFixture,
	label string,
) (string, string) {
	t.Helper()
	operationID := "desktop_operation_" + label
	proofID := "desktop_proof_" + label
	activationID := "desktop_activation_" + label
	handoffID := "handoff_desktop_command_" + label
	ownerID := "desktop_" + fixture.device.deviceID
	checkedAt := time.Now().UTC().Truncate(time.Millisecond)
	loginIDHash := desktopDigest(label + ":login")
	accountFingerprint := desktopDigest(label + ":account")
	bindingDigest := desktopDigest(label + ":binding")
	proofRequestHash := desktopDigest(label + ":proof-request")
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_desktop_handoff
		SET status='proof_submitted',claim_consumed_at=transaction_timestamp()
		WHERE id=$1 AND status='claimed'
	`, handoffID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_desktop_authorization_proof (
		 id,session_id,handoff_id,executor_id,device_id,session_revision,login_id_hash,
		 result,account_fingerprint,candidate_binding_digest,request_hash,checked_at,
		 claim_token_hash,device_key_generation,device_sequence,response_reference,
		 response_session_revision
		) VALUES ($1,$2,$3,$4,$5,2,$6,'succeeded',$7,$8,$9,$10,$11,1,1,$12,3)
	`, proofID, fixture.sessionID, handoffID, fixture.executorID, fixture.device.deviceID,
		loginIDHash, accountFingerprint, bindingDigest, proofRequestHash, checkedAt,
		desktopDigest(label+":claim-token"), "desktop_proof_"+handoffID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_authorization_session
		SET status='verifying',login_id_hash=$2,prepared_credential_revision=1,
		    operation_id=$3,runtime_owner_instance_id=$4,revision=3,current_sequence=3,
		    updated_at=transaction_timestamp()
		WHERE id=$1 AND status='waiting_user' AND revision=2
	`, fixture.sessionID, loginIDHash, operationID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_config SET credential_revision_counter=1 WHERE id=$1
	`, fixture.executorID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_operation_lease (
		 executor_id,operation_id,owner_instance_id,lease_epoch,lease_expires_at,
		 source_credential_revision,revocation_epoch,status
		) VALUES ($1,$2,$3,1,transaction_timestamp()+interval '30 seconds',0,0,'active')
	`, fixture.executorID, operationID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_credential_binding (
		 executor_id,revision,status,authorization_session_id,runtime_type,runtime_binding_id,
		 runtime_binding_revision,device_id,account_fingerprint,auth_mode,binding_digest,
		 revocation_epoch,verified_at,operation_id,lease_epoch,source_credential_revision,digest_algorithm
		) VALUES ($1,1,'prepared',$2,'desktop',$3,1,$3,$4,'browser',$5,0,$6,$7,1,0,$8)
	`, fixture.executorID, fixture.sessionID, fixture.device.deviceID, accountFingerprint,
		bindingDigest, checkedAt, operationID, "aicrm-credential-tree-rfc8785-nfc-v1"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_credential_activation (
		 id,session_id,proof_id,executor_id,device_id,operation_id,credential_revision,
		 lease_epoch,source_credential_revision,revocation_epoch,binding_digest,
		 activation_token_hash,request_hash,status,issued_at,expires_at,
		 device_binding_revision,activation_token_key_id,activation_token_nonce_hash
		) VALUES ($1,$2,$3,$4,$5,$6,1,1,0,0,$7,$8,$9,'pending',
		 transaction_timestamp(),transaction_timestamp()+interval '10 minutes',1,$10,$11)
	`, activationID, fixture.sessionID, proofID, fixture.executorID, fixture.device.deviceID,
		operationID, bindingDigest, desktopDigest(label+":activation-token"), proofRequestHash,
		"desktop-command-test-key", desktopDigest(label+":activation-nonce")); err != nil {
		t.Fatal(err)
	}
	return operationID, activationID
}

func desktopCommandCreateInput(
	fixture desktopCommandFixture,
	expectedRevision int64,
	keyLabel, bodyLabel string,
) desktopcommand.CreateInput {
	return desktopcommand.CreateInput{
		SessionID: fixture.sessionID, ActorID: fixture.actorID,
		ActorSessionID: fixture.actorSessionID, ExpectedSessionRevision: expectedRevision,
		IdempotencyKeyHash: desktopDigest(keyLabel), RequestHash: desktopDigest(bodyLabel),
	}
}

type signedDesktopCommandACKResult struct {
	input store.AcknowledgeDesktopAuthorizationCommandInput
	body  []byte
}

func signedDesktopCommandACK(
	t *testing.T,
	device bindingDeviceFixture,
	ticket string,
	command store.DesktopAuthorizationCommandProjection,
	result, failureCode string,
	completedAt time.Time,
	nonce string,
	sequence uint64,
) signedDesktopCommandACKResult {
	t.Helper()
	body := []byte(fmt.Sprintf(
		`{"operationId":%q,"purpose":%q,"expectedSessionRevision":%d,"result":%q,"completedAt":%q}`,
		command.OperationID, command.Purpose, command.ExpectedSessionRevision, result,
		completedAt.UTC().Format(time.RFC3339Nano),
	))
	if failureCode != "" {
		body = []byte(fmt.Sprintf(
			`{"operationId":%q,"purpose":%q,"expectedSessionRevision":%d,"result":%q,"completedAt":%q,"failureCode":%q}`,
			command.OperationID, command.Purpose, command.ExpectedSessionRevision, result,
			completedAt.UTC().Format(time.RFC3339Nano), failureCode,
		))
	}
	path := store.DesktopAuthorizationCommandACKPath(command.SessionID, command.OperationID)
	authorization := "AiCRM-Command " + ticket
	authorizationHash, err := deviceauth.AuthorizationTokenHash(authorization, []string{"AiCRM-Command"})
	if err != nil {
		t.Fatal(err)
	}
	headers := deviceauth.ProofHeaders{
		DeviceID: device.deviceID, TimestampMilli: completedAt.UnixMilli(), Nonce: nonce,
		Sequence: sequence, BodySHA256: deviceauth.HashBody(body),
	}
	signingInput, err := deviceauth.SigningInput("POST", path, headers, authorizationHash)
	if err != nil {
		t.Fatal(err)
	}
	httpHeaders := make(http.Header)
	httpHeaders.Set(deviceauth.HeaderDeviceID, device.deviceID)
	httpHeaders.Set(deviceauth.HeaderTimestamp, fmt.Sprintf("%d", completedAt.UnixMilli()))
	httpHeaders.Set(deviceauth.HeaderNonce, nonce)
	httpHeaders.Set(deviceauth.HeaderSequence, fmt.Sprintf("%d", sequence))
	httpHeaders.Set(deviceauth.HeaderContentSHA256, deviceauth.HashBody(body))
	httpHeaders.Set(deviceauth.HeaderSignature,
		base64.RawURLEncoding.EncodeToString(ed25519.Sign(device.privateKey, signingInput)))
	httpHeaders.Set("Authorization", authorization)
	verified, err := deviceauth.VerifyRequestForPersistentLedger(deviceauth.VerifyInput{
		PublicKey: device.publicKey, Method: "POST", RequestTarget: path,
		Headers: httpHeaders, Body: body, AllowedAuthorizationSchemes: []string{"AiCRM-Command"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return signedDesktopCommandACKResult{
		body: body,
		input: store.AcknowledgeDesktopAuthorizationCommandInput{
			SessionID: command.SessionID, OperationID: command.OperationID,
			Purpose: command.Purpose, ExpectedSessionRevision: command.ExpectedSessionRevision,
			Result: result, CompletedAt: completedAt, FailureCode: failureCode,
			KeyGeneration: 1, Proof: verified,
			LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
		},
	}
}

func getAuthorizationSessionState(t *testing.T, ctx context.Context, db *sql.DB, sessionID string) string {
	t.Helper()
	var status string
	var revision, sequence int64
	if err := db.QueryRowContext(ctx, `
		SELECT status,revision,current_sequence
		FROM ky_ai_executor_authorization_session WHERE id=$1
	`, sessionID).Scan(&status, &revision, &sequence); err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%s:%d:%d", status, revision, sequence)
}

func assertDesktopCommandCounts(
	t *testing.T,
	ctx context.Context,
	db *sql.DB,
	operationID string,
	auditCount, outboxCount int,
) {
	t.Helper()
	var commands, audits, outbox int
	if err := db.QueryRowContext(ctx, `
		SELECT count(*) FROM ky_ai_executor_desktop_command_operation WHERE id=$1
	`, operationID).Scan(&commands); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `
		SELECT count(*) FROM ky_ai_executor_desktop_command_audit WHERE operation_id=$1
	`, operationID).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `
		SELECT count(*) FROM ky_ai_executor_control_outbox
		WHERE aggregate_type='desktop_operation' AND aggregate_id=$1
	`, operationID).Scan(&outbox); err != nil {
		t.Fatal(err)
	}
	if commands != 1 || audits != auditCount || outbox != outboxCount {
		t.Fatalf("counts command=%d audit=%d outbox=%d", commands, audits, outbox)
	}
}

func assertDesktopCommandTokenAbsent(t *testing.T, ctx context.Context, db *sql.DB, token string) {
	t.Helper()
	var count int
	if err := db.QueryRowContext(ctx, `
		SELECT
		 (SELECT count(*) FROM ky_ai_executor_desktop_command_operation row
		  WHERE row_to_json(row)::text LIKE '%' || $1 || '%')
		 +
		 (SELECT count(*) FROM ky_ai_executor_desktop_command_audit row
		  WHERE row_to_json(row)::text LIKE '%' || $1 || '%')
		 +
		 (SELECT count(*) FROM ky_ai_executor_control_outbox row
		  WHERE row_to_json(row)::text LIKE '%' || $1 || '%')
	`, token).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("command ticket leaked to persisted rows: %d", count)
	}
}
