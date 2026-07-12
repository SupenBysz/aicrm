package store_test

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/credentialrevocation"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/operationconfirmation"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
	_ "github.com/jackc/pgx/v5/stdlib"
)

func TestCredentialRevocationAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("KY_AGENT_EXECUTOR_CREDENTIAL_REVOCATION_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set KY_AGENT_EXECUTOR_CREDENTIAL_REVOCATION_TEST_DATABASE_URL for PostgreSQL integration")
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
	confirmationManager := newConfirmationManager(t, control)
	revocationManager, revocationSigner := newCredentialRevocationManager(t, control, confirmationManager)
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())

	t.Run("server normal cleanup and restart replay", func(t *testing.T) {
		fixture := seedCredentialRevocationExecutor(t, ctx, db, "server", suffix+"_server", 2, 4, nil)
		input := revokeInput(fixture, false, suffix+"_server")
		result, err := revocationManager.Revoke(ctx, input)
		if err != nil {
			t.Fatal(err)
		}
		if !result.Created || result.CommandTicket != "" || result.Revocation.Status != "completed" ||
			result.CleanupTarget.Action != "quarantine" || result.CleanupTarget.RuntimeType != "server" {
			t.Fatalf("server result=%#v", result)
		}
		assertRevokedExecutorShape(t, ctx, db, fixture, 5, true)
		assertCredentialBindingStatus(t, ctx, db, fixture.executorID, 2, "revoked")
		assertRevocationCounts(t, ctx, db, result.Revocation.RevocationID, 2, 2)

		if err := control.Close(); err != nil {
			t.Fatal(err)
		}
		control, err = store.OpenControl(ctx, databaseURL)
		if err != nil {
			t.Fatal(err)
		}
		confirmationManager = newConfirmationManager(t, control)
		revocationManager, revocationSigner = newCredentialRevocationManager(t, control, confirmationManager)
		replay, err := revocationManager.Revoke(ctx, input)
		if err != nil || replay.Created || replay.Revocation.RevocationID != result.Revocation.RevocationID ||
			replay.Revocation.OperationID != result.Revocation.OperationID {
			t.Fatalf("server restart replay=%#v err=%v", replay, err)
		}
	})

	t.Run("normal conflicts with active lease and task", func(t *testing.T) {
		leaseFixture := seedCredentialRevocationExecutor(t, ctx, db, "server", suffix+"_lease", 1, 1, nil)
		if _, err := db.ExecContext(ctx, `
			INSERT INTO ky_ai_executor_operation_lease (
			 executor_id,operation_id,owner_instance_id,lease_epoch,lease_expires_at,
			 source_credential_revision,revocation_epoch,status
			) VALUES ($1,$2,'worker',3,now()+interval '30 seconds',$3,$4,'active')
		`, leaseFixture.executorID, "lease_active_"+suffix, leaseFixture.credentialRevision, leaseFixture.revocationEpoch); err != nil {
			t.Fatal(err)
		}
		if _, err := revocationManager.Revoke(ctx, revokeInput(leaseFixture, false, suffix+"_lease")); !errors.Is(err, store.ErrCredentialRevocationActiveWork) {
			t.Fatalf("active lease err=%v", err)
		}
		assertAuthorizedExecutorShape(t, ctx, db, leaseFixture)

		taskFixture := seedCredentialRevocationExecutor(t, ctx, db, "server", suffix+"_task", 1, 2, nil)
		seedCredentialRevocationTask(t, ctx, db, taskFixture, "task_normal_conflict_"+suffix, 0, false)
		if _, err := revocationManager.Revoke(ctx, revokeInput(taskFixture, false, suffix+"_task")); !errors.Is(err, store.ErrCredentialRevocationActiveWork) {
			t.Fatalf("active task err=%v", err)
		}
		assertAuthorizedExecutorShape(t, ctx, db, taskFixture)
		if _, err := db.ExecContext(ctx, `
			UPDATE ky_ai_executor_task SET status='cancelled',completed_at=now() WHERE id=$1
		`, "task_normal_conflict_"+suffix); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("desktop normal defers final unbind until exact ACK", func(t *testing.T) {
		device := newBindingDeviceFixture(t, 121)
		fixture := seedCredentialRevocationExecutor(t, ctx, db, "desktop", suffix+"_desktop", 3, 6, &device)
		input := revokeInput(fixture, false, suffix+"_desktop")
		result, err := revocationManager.Revoke(ctx, input)
		if err != nil {
			t.Fatal(err)
		}
		if !result.Created || result.CommandTicket == "" || result.Revocation.Status != "awaiting_device" ||
			result.Revocation.RevocationEpoch != 7 || result.CleanupTarget.DeviceID != device.deviceID {
			t.Fatalf("desktop pending result=%#v", result)
		}
		assertPendingDesktopRevocationShape(t, ctx, db, fixture, 7)
		assertCredentialBindingStatus(t, ctx, db, fixture.executorID, 3, "active")

		replay, err := revocationManager.Revoke(ctx, input)
		if err != nil || replay.Created || replay.CommandTicket != result.CommandTicket ||
			replay.Revocation.OperationID != result.Revocation.OperationID {
			t.Fatalf("deterministic ticket replay=%#v err=%v", replay, err)
		}

		blockedTask := "task_after_normal_revoke_" + suffix
		seedCredentialRevocationTask(t, ctx, db, fixture, blockedTask, 0, false)
		if work, found, err := control.ClaimControlTask(ctx, "worker_after_revoke_"+suffix, "0.144.1"); err != nil || found {
			t.Fatalf("revoked target started work=%#v found=%v err=%v", work, found, err)
		}
		assertTaskStatus(t, ctx, db, blockedTask, "failed")

		body := []byte(`{"operationId":"logout","result":"succeeded","bodyCanary":"raw-revocation-body-canary"}`)
		proof := signedRevocationProof(t, device, result.Revocation, body, result.CommandTicket,
			time.Now().UTC(), revocationNonce(1), 1)
		ack := revocationACKInput(result.Revocation, proof.verified, "succeeded", revocationDigest("quarantine:"+suffix))
		ackResult, err := revocationManager.Acknowledge(ctx, ack, result.CommandTicket)
		if err != nil || ackResult.Replayed || ackResult.Revocation.Status != "completed" {
			t.Fatalf("ACK result=%#v err=%v", ackResult, err)
		}
		assertRevokedExecutorShape(t, ctx, db, fixture, 7, true)
		assertCredentialBindingStatus(t, ctx, db, fixture.executorID, 3, "revoked")
		assertRevocationCounts(t, ctx, db, result.Revocation.RevocationID, 2, 2)

		if err := control.Close(); err != nil {
			t.Fatal(err)
		}
		control, err = store.OpenControl(ctx, databaseURL)
		if err != nil {
			t.Fatal(err)
		}
		confirmationManager = newConfirmationManager(t, control)
		revocationManager, revocationSigner = newCredentialRevocationManager(t, control, confirmationManager)
		ackReplay, err := revocationManager.Acknowledge(ctx, ack, result.CommandTicket)
		if err != nil || !ackReplay.Replayed || ackReplay.Revocation.Status != "completed" {
			t.Fatalf("restart ACK replay=%#v err=%v", ackReplay, err)
		}
		changed := ack
		changed.Proof = signedRevocationProof(t, device, result.Revocation,
			[]byte(`{"operationId":"logout","result":"failed"}`), result.CommandTicket,
			time.Now().UTC(), revocationNonce(1), 1).verified
		if _, err := revocationManager.Acknowledge(ctx, changed, result.CommandTicket); !errors.Is(err, store.ErrDeviceProofReplayed) {
			t.Fatalf("altered same sequence err=%v", err)
		}
		assertNoRevocationSecrets(t, ctx, db, fixture.executorID, []string{
			result.CommandTicket, proof.signature, "raw-revocation-body-canary",
		})
	})

	t.Run("runtime binding drift fences normal ACK", func(t *testing.T) {
		device := newBindingDeviceFixture(t, 139)
		fixture := seedCredentialRevocationExecutor(t, ctx, db, "desktop", suffix+"_runtime_drift", 4, 7, &device)
		result, err := revocationManager.Revoke(ctx, revokeInput(fixture, false, suffix+"_runtime_drift"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `
			UPDATE ky_ai_executor_config
			SET runtime_binding_id=$2,runtime_binding_revision=runtime_binding_revision+1
			WHERE id=$1
		`, fixture.executorID, "desktop_drifted_"+suffix); err != nil {
			t.Fatal(err)
		}
		body := []byte(`{"operationId":"runtime-drift","result":"succeeded"}`)
		proof := signedRevocationProof(t, device, result.Revocation, body, result.CommandTicket,
			time.Now().UTC(), revocationNonce(21), 1)
		ack := revocationACKInput(result.Revocation, proof.verified, "succeeded", revocationDigest("runtime-drift:"+suffix))
		ackResult, err := revocationManager.Acknowledge(ctx, ack, result.CommandTicket)
		if err != nil || ackResult.Revocation.Status != "stale_target" {
			t.Fatalf("runtime drift ACK=%#v err=%v", ackResult, err)
		}
		var currentRevision, runtimeRevision int64
		var runtimeBindingID string
		if err := db.QueryRowContext(ctx, `
			SELECT current_credential_revision,runtime_binding_id,runtime_binding_revision
			FROM ky_ai_executor_config WHERE id=$1
		`, fixture.executorID).Scan(&currentRevision, &runtimeBindingID, &runtimeRevision); err != nil {
			t.Fatal(err)
		}
		if currentRevision != fixture.credentialRevision || runtimeBindingID != "desktop_drifted_"+suffix || runtimeRevision != 2 {
			t.Fatalf("drifted target was cleared revision=%d binding=%s/%d", currentRevision, runtimeBindingID, runtimeRevision)
		}
		assertCredentialBindingStatus(t, ctx, db, fixture.executorID, fixture.credentialRevision, "active")
	})

	t.Run("force is atomic, concurrent and fences all work", func(t *testing.T) {
		device := newBindingDeviceFixture(t, 157)
		fixture := seedCredentialRevocationExecutor(t, ctx, db, "desktop", suffix+"_force", 5, 9, &device)
		firstTask := "task_force_running_" + suffix
		secondTask := "task_force_pending_" + suffix
		seedCredentialRevocationTask(t, ctx, db, fixture, firstTask, 4, true)
		seedCredentialRevocationTask(t, ctx, db, fixture, secondTask, 0, false)
		if _, err := db.ExecContext(ctx, `
			UPDATE ky_ai_executor_task
			SET task_type='script_repair',generation_engine='legacy_provider',status='waiting_user_scan'
			WHERE id=$1
		`, secondTask); err != nil {
			t.Fatal(err)
		}
		confirmationToken, confirmationID, challenge := confirmedBindingOperation(
			t, ctx, confirmationManager, store.OperationConfirmationForceRevoke,
			fixture.executorID, fixture.actorID, fixture.actorSessionID, fixture.credentialRevision,
			"", time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond), "force_revocation_"+suffix,
		)
		input := revokeInput(fixture, true, suffix+"_force")
		input.ConfirmationToken = confirmationToken
		const workers = 10
		var created, replayed atomic.Int64
		var first store.CreateCredentialRevocationResult
		var firstMu sync.Mutex
		errorsOut := make(chan error, workers)
		var group sync.WaitGroup
		for index := 0; index < workers; index++ {
			group.Add(1)
			go func() {
				defer group.Done()
				result, err := revocationManager.Revoke(ctx, input)
				if err != nil {
					errorsOut <- err
					return
				}
				if result.CommandTicket == "" || result.Revocation.Status != "awaiting_device" || !result.Revocation.Force {
					errorsOut <- fmt.Errorf("unexpected force result %#v", result)
					return
				}
				firstMu.Lock()
				if first.Revocation.RevocationID == "" {
					first = result
				} else if first.Revocation.RevocationID != result.Revocation.RevocationID || first.CommandTicket != result.CommandTicket {
					errorsOut <- errors.New("force replay returned a different target or ticket")
				}
				firstMu.Unlock()
				if result.Created {
					created.Add(1)
				} else {
					replayed.Add(1)
				}
			}()
		}
		group.Wait()
		close(errorsOut)
		for workerErr := range errorsOut {
			t.Fatal(workerErr)
		}
		if created.Load() != 1 || replayed.Load() != workers-1 {
			t.Fatalf("force created=%d replayed=%d", created.Load(), replayed.Load())
		}
		invalidReplay := input
		invalidReplay.ConfirmationToken = "not-a-confirmation-token"
		if _, err := revocationManager.Revoke(ctx, invalidReplay); err == nil {
			t.Fatal("force replay accepted an unverified confirmation token")
		}
		assertConfirmationStatus(t, ctx, db, confirmationID, "consumed")
		assertRevokedExecutorShape(t, ctx, db, fixture, 10, true)
		assertCredentialBindingStatus(t, ctx, db, fixture.executorID, 5, "revoked")
		assertTaskStatus(t, ctx, db, firstTask, "cancelled")
		assertTaskStatus(t, ctx, db, secondTask, "cancelled")
		var leaseStatus string
		if err := db.QueryRowContext(ctx, `SELECT status FROM ky_ai_executor_operation_lease WHERE executor_id=$1`, fixture.executorID).Scan(&leaseStatus); err != nil || leaseStatus != "fenced" {
			t.Fatalf("force lease status=%s err=%v", leaseStatus, err)
		}
		var taskEvents, taskOutbox int
		if err := db.QueryRowContext(ctx, `
			SELECT (SELECT count(*) FROM ky_ai_executor_task_event WHERE task_id IN ($1,$2)),
			       (SELECT count(*) FROM ky_ai_executor_task_outbox WHERE task_id IN ($1,$2))
		`, firstTask, secondTask).Scan(&taskEvents, &taskOutbox); err != nil {
			t.Fatal(err)
		}
		if taskEvents != 6 || taskOutbox != 6 {
			t.Fatalf("force task events=%d outbox=%d", taskEvents, taskOutbox)
		}
		assertNoRevocationSecrets(t, ctx, db, fixture.executorID, []string{confirmationToken, challenge, first.CommandTicket})
	})

	t.Run("force rolls back confirmation and fences on fanout failure", func(t *testing.T) {
		fixture := seedCredentialRevocationExecutor(t, ctx, db, "server", suffix+"_rollback", 1, 3, nil)
		taskID := "task_force_rollback_" + suffix
		seedCredentialRevocationTask(t, ctx, db, fixture, taskID, 0, false)
		if _, err := db.ExecContext(ctx, `
			INSERT INTO ky_ai_executor_task_event
			(id,task_id,sequence,event_type,level,message,payload_json,safe_payload_json)
			VALUES ($1,$2,1,'changed','info','','{}'::jsonb,'{}'::jsonb)
		`, "event_force_rollback_"+suffix, taskID); err != nil {
			t.Fatal(err)
		}
		token, confirmationID, _ := confirmedBindingOperation(
			t, ctx, confirmationManager, store.OperationConfirmationForceRevoke,
			fixture.executorID, fixture.actorID, fixture.actorSessionID, fixture.credentialRevision,
			"", time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond), "force_rollback_"+suffix,
		)
		input := revokeInput(fixture, true, suffix+"_rollback")
		input.ConfirmationToken = token
		if _, err := revocationManager.Revoke(ctx, input); err == nil {
			t.Fatal("force fanout failure unexpectedly committed")
		}
		assertConfirmationStatus(t, ctx, db, confirmationID, "confirmed")
		assertAuthorizedExecutorShape(t, ctx, db, fixture)
		assertCredentialBindingStatus(t, ctx, db, fixture.executorID, 1, "active")
		assertTaskStatus(t, ctx, db, taskID, "pending")
		var revocations int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM ky_ai_executor_credential_revocation WHERE executor_id=$1`, fixture.executorID).Scan(&revocations); err != nil || revocations != 0 {
			t.Fatalf("rollback revocations=%d err=%v", revocations, err)
		}
	})

	t.Run("new revision fences old ACK as stale target", func(t *testing.T) {
		device := newBindingDeviceFixture(t, 193)
		fixture := seedCredentialRevocationExecutor(t, ctx, db, "desktop", suffix+"_stale", 1, 2, &device)
		result, err := revocationManager.Revoke(ctx, revokeInput(fixture, false, suffix+"_stale"))
		if err != nil {
			t.Fatal(err)
		}
		newBindingID := "desktop_new_" + suffix
		if _, err := db.ExecContext(ctx, `
			UPDATE ky_ai_executor_credential_binding SET status='revoked',revoked_at=now()
			WHERE executor_id=$1 AND revision=1
		`, fixture.executorID); err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `
			INSERT INTO ky_ai_executor_credential_binding (
			 executor_id,revision,status,runtime_type,runtime_binding_id,runtime_binding_revision,
			 device_id,account_fingerprint,auth_mode,plan_type,binding_digest,revocation_epoch,
			 verified_at,activated_at,operation_id,lease_epoch,source_credential_revision,digest_algorithm
			) VALUES ($1,2,'active','desktop',$2,2,$3,$4,'browser','plus',$5,$6,now(),now(),$7,1,1,
			 'aicrm-credential-tree-rfc8785-nfc-v1')
		`, fixture.executorID, newBindingID, device.deviceID,
			revocationDigest("new-fingerprint:"+suffix), revocationDigest("new-binding:"+suffix),
			result.Revocation.RevocationEpoch, "activation_new_"+suffix); err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `
			UPDATE ky_ai_executor_config
			SET credential_status='authorized',current_credential_revision=2,
			    credential_revision_counter=2,runtime_binding_id=$2,runtime_binding_revision=2,
			    config_revision=config_revision+1
			WHERE id=$1 AND revocation_epoch=$3
		`, fixture.executorID, newBindingID, result.Revocation.RevocationEpoch); err != nil {
			t.Fatal(err)
		}
		body := []byte(`{"operationId":"stale","result":"succeeded"}`)
		proof := signedRevocationProof(t, device, result.Revocation, body, result.CommandTicket,
			time.Now().UTC(), revocationNonce(31), 1)
		ack := revocationACKInput(result.Revocation, proof.verified, "succeeded", revocationDigest("old-quarantine:"+suffix))
		ackResult, err := revocationManager.Acknowledge(ctx, ack, result.CommandTicket)
		if err != nil || ackResult.Revocation.Status != "stale_target" || ackResult.Revocation.QuarantineDigest != "" {
			t.Fatalf("stale ACK=%#v err=%v", ackResult, err)
		}
		var currentRevision int64
		var runtimeBindingID, credentialStatus string
		if err := db.QueryRowContext(ctx, `
			SELECT current_credential_revision,runtime_binding_id,credential_status
			FROM ky_ai_executor_config WHERE id=$1
		`, fixture.executorID).Scan(&currentRevision, &runtimeBindingID, &credentialStatus); err != nil {
			t.Fatal(err)
		}
		if currentRevision != 2 || runtimeBindingID != newBindingID || credentialStatus != "authorized" {
			t.Fatalf("new target changed revision=%d binding=%s status=%s", currentRevision, runtimeBindingID, credentialStatus)
		}
		assertCredentialBindingStatus(t, ctx, db, fixture.executorID, 2, "active")
	})

	t.Run("database clock rejects future proof and expired ticket", func(t *testing.T) {
		device := newBindingDeviceFixture(t, 229)
		fixture := seedCredentialRevocationExecutor(t, ctx, db, "desktop", suffix+"_expired", 1, 11, &device)
		past := time.Now().UTC().Add(-3 * time.Minute).Truncate(time.Second)
		revocationID := "revocation_expired_" + suffix
		operationID := "credential_logout_expired_" + suffix
		token, tokenHash, nonceHash := issueExpiredRevocationTicket(
			t, revocationSigner, fixture, revocationID, operationID, 12, past,
		)
		if _, err := db.ExecContext(ctx, `
			UPDATE ky_ai_executor_config
			SET credential_status='revoked',revocation_epoch=12,
			    readiness_status='unavailable',readiness_reason_code='credential_revoked'
			WHERE id=$1
		`, fixture.executorID); err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `
			INSERT INTO ky_ai_executor_credential_revocation (
			 id,executor_id,device_id,credential_revision,revocation_epoch,operation_id,
			 requested_by,actor_session_id,runtime_type,force,idempotency_key_hash,request_hash,
			 command_ticket_hash,token_key_id,token_nonce_hash,token_issued_at,token_expires_at,
			 status,created_at,security_contract_verified,runtime_binding_id,runtime_binding_revision
			) VALUES ($2,$1,$3,1,12,$4,$5,$6,'desktop',false,$7,$8,$9,'revocation_key_1',$10,$11,$12,
			 'awaiting_device',$11,true,$13,1)
		`, fixture.executorID, revocationID, device.deviceID, operationID,
			fixture.actorID, fixture.actorSessionID, revocationDigest("expired-key:"+suffix),
			revocationDigest("expired-request:"+suffix), tokenHash, nonceHash, past,
			past.Add(store.CredentialLogoutTicketLifetime), fixture.runtimeBindingID); err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `
			INSERT INTO ky_ai_executor_desktop_command_operation (
			 id,executor_id,device_id,requested_by,purpose,expected_credential_revision,
			 revocation_id,revocation_epoch,idempotency_key_hash,request_hash,command_ticket_hash,
			 token_key_id,token_nonce_hash,status,issued_at,expires_at,created_at,updated_at,
			 security_contract_verified
			) VALUES ($4,$1,$3,$5,'credential_logout',1,$2,12,$6,$7,$8,'revocation_key_1',$9,
			 'pending',$10,$11,$10,$10,true)
		`, fixture.executorID, revocationID, device.deviceID, operationID,
			fixture.actorID, revocationDigest("expired-key:"+suffix),
			revocationDigest("expired-request:"+suffix), tokenHash, nonceHash, past,
			past.Add(store.CredentialLogoutTicketLifetime)); err != nil {
			t.Fatal(err)
		}
		projection := store.CredentialRevocationProjection{
			RevocationID: revocationID, OperationID: operationID, ExecutorID: fixture.executorID,
			RuntimeType: "desktop", CredentialRevision: 1, RevocationEpoch: 12,
		}
		futureProof := signedRevocationProof(t, device, projection, []byte(`{"result":"stale_target"}`), token,
			time.Now().UTC().Add(10*time.Minute), revocationNonce(61), 1)
		ack := revocationACKInput(projection, futureProof.verified, "stale_target", "")
		if _, err := revocationManager.Acknowledge(ctx, ack, token); !errors.Is(err, deviceauth.ErrTimestampOutsideWindow) {
			t.Fatalf("future DB clock proof err=%v", err)
		}
		proof := signedRevocationProof(t, device, projection, []byte(`{"result":"stale_target"}`), token,
			time.Now().UTC(), revocationNonce(62), 1)
		ack = revocationACKInput(projection, proof.verified, "stale_target", "")
		if _, err := revocationManager.Acknowledge(ctx, ack, token); !errors.Is(err, trustedtoken.ErrExpired) {
			t.Fatalf("expired ticket err=%v", err)
		}
		var ledgerRows int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM ky_ai_executor_device_request_ledger WHERE device_id=$1`, device.deviceID).Scan(&ledgerRows); err != nil || ledgerRows != 0 {
			t.Fatalf("rejected proof ledger rows=%d err=%v", ledgerRows, err)
		}
	})
}

type credentialRevocationExecutorFixture struct {
	executorID         string
	actorID            string
	actorSessionID     string
	runtimeType        string
	runtimeBindingID   string
	credentialRevision int64
	revocationEpoch    int64
	device             *bindingDeviceFixture
}

func seedCredentialRevocationExecutor(
	t *testing.T,
	ctx context.Context,
	db *sql.DB,
	runtimeType, suffix string,
	credentialRevision, revocationEpoch int64,
	device *bindingDeviceFixture,
) credentialRevocationExecutorFixture {
	t.Helper()
	fixture := credentialRevocationExecutorFixture{
		executorID: "aiexec_revocation_" + suffix, actorID: "user_platform_owner",
		actorSessionID: "login_revocation_" + suffix, runtimeType: runtimeType,
		runtimeBindingID:   runtimeType + "_binding_" + suffix,
		credentialRevision: credentialRevision, revocationEpoch: revocationEpoch, device: device,
	}
	if device != nil {
		if _, err := db.ExecContext(ctx, `
			INSERT INTO ky_ai_executor_device
			(id,public_key,status,label,registered_by,workspace_type,workspace_id)
			VALUES ($1,$2,'active','revocation-device',$3,'platform','platform_root')
		`, device.deviceID, device.publicKey, fixture.actorID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_config (
		 id,name,scope_type,scope_id,executor_type,runtime_type,status,is_default,max_concurrency,
		 allow_script_save,config_revision,credential_status,current_credential_revision,
		 credential_revision_counter,catalog_revision,runtime_binding_id,runtime_binding_revision,
		 revocation_epoch,default_model_key,task_timeout_seconds
		) VALUES ($1,'Revocation integration','platform','platform_root','codex',$2,'enabled',false,1,
		 false,7,'authorized',$3,$3,2,$4,1,$5,'gpt-5.6',60)
	`, fixture.executorID, runtimeType, credentialRevision, fixture.runtimeBindingID, revocationEpoch); err != nil {
		t.Fatal(err)
	}
	deviceID := ""
	if device != nil {
		deviceID = device.deviceID
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_credential_binding (
		 executor_id,revision,status,runtime_type,runtime_binding_id,runtime_binding_revision,
		 device_id,account_fingerprint,auth_mode,plan_type,binding_digest,revocation_epoch,
		 verified_at,activated_at,operation_id,lease_epoch,source_credential_revision,digest_algorithm
		) VALUES ($1,$2,'active',$3,$4,1,$5,$6,$7,'plus',$8,$9,now(),now(),$10,1,0,
		 'aicrm-credential-tree-rfc8785-nfc-v1')
	`, fixture.executorID, credentialRevision, runtimeType, fixture.runtimeBindingID, deviceID,
		revocationDigest("fingerprint:"+suffix), map[bool]string{true: "browser", false: "device_code"}[device != nil],
		revocationDigest("binding:"+suffix), revocationEpoch, "activation_seed_"+suffix); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func seedCredentialRevocationTask(
	t *testing.T,
	ctx context.Context,
	db *sql.DB,
	fixture credentialRevocationExecutorFixture,
	taskID string,
	leaseEpoch int64,
	activeLease bool,
) {
	t.Helper()
	operationID := "operation_" + taskID
	requestHash := revocationDigest("request:" + taskID)
	status := "pending"
	if activeLease {
		status = "running"
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_task (
		 id,workspace_type,workspace_id,executor_id,executor_type,task_type,status,
		 effective_executor_id,executor_config_revision,credential_binding_revision,
		 runtime_binding_id,runtime_binding_revision,model_catalog_revision,
		 operation_id,lease_epoch,source_credential_revision,revocation_epoch,revision,
		 current_sequence,request_hash
		) VALUES ($1,'platform','platform_root',$2,'codex','readiness_check',$3,$2,7,$4,$5,1,2,
		 $6,$7,$4,$8,1,0,$9)
	`, taskID, fixture.executorID, status, fixture.credentialRevision, fixture.runtimeBindingID,
		operationID, leaseEpoch, fixture.revocationEpoch, requestHash); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_task_request_registry
		(task_id,request_hash,materialized_status,materialized_at)
		VALUES ($1,$2,$3,now())
	`, taskID, requestHash, status); err != nil {
		t.Fatal(err)
	}
	if activeLease {
		if _, err := db.ExecContext(ctx, `
			INSERT INTO ky_ai_executor_operation_lease (
			 executor_id,operation_id,owner_instance_id,lease_epoch,lease_expires_at,
			 source_credential_revision,revocation_epoch,status
			) VALUES ($1,$2,'force-worker',$3,now()+interval '30 seconds',$4,$5,'active')
		`, fixture.executorID, operationID, leaseEpoch, fixture.credentialRevision, fixture.revocationEpoch); err != nil {
			t.Fatal(err)
		}
	}
}

func newCredentialRevocationManager(
	t *testing.T,
	control *store.ControlStore,
	confirmations *operationconfirmation.Manager,
) (*credentialrevocation.Manager, *trustedtoken.Signer) {
	t.Helper()
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = byte(index + 97)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	signer, err := trustedtoken.NewSigner("revocation_key_1", privateKey)
	if err != nil {
		t.Fatal(err)
	}
	manager, err := credentialrevocation.New(
		control, confirmations, signer,
		trustedtoken.KeySet{"revocation_key_1": privateKey.Public().(ed25519.PublicKey)},
		[]byte("revocation-nonce-secret-32-bytes!!"),
	)
	if err != nil {
		t.Fatal(err)
	}
	return manager, signer
}

func revokeInput(fixture credentialRevocationExecutorFixture, force bool, discriminator string) credentialrevocation.RevokeInput {
	return credentialrevocation.RevokeInput{
		ExecutorID: fixture.executorID, ActorID: fixture.actorID, ActorSessionID: fixture.actorSessionID,
		ExpectedCredentialRevision: fixture.credentialRevision, Force: force,
		IdempotencyKeyHash: revocationDigest("key:" + discriminator),
		RequestHash:        revocationDigest("request:" + discriminator),
	}
}

type signedRevocationRequest struct {
	verified  deviceauth.VerifiedRequest
	signature string
}

func signedRevocationProof(
	t *testing.T,
	fixture bindingDeviceFixture,
	revocation store.CredentialRevocationProjection,
	body []byte,
	ticket string,
	timestamp time.Time,
	nonce string,
	sequence uint64,
) signedRevocationRequest {
	t.Helper()
	authorization := "AiCRM-Command " + ticket
	authorizationHash, err := deviceauth.AuthorizationTokenHash(authorization, []string{"AiCRM-Command"})
	if err != nil {
		t.Fatal(err)
	}
	path := store.CredentialRevocationACKPath(revocation.ExecutorID, revocation.RevocationID)
	headers := deviceauth.ProofHeaders{
		DeviceID: fixture.deviceID, TimestampMilli: timestamp.UnixMilli(), Nonce: nonce,
		Sequence: sequence, BodySHA256: deviceauth.HashBody(body),
	}
	signingInput, err := deviceauth.SigningInput("POST", path, headers, authorizationHash)
	if err != nil {
		t.Fatal(err)
	}
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(fixture.privateKey, signingInput))
	httpHeaders := make(http.Header)
	httpHeaders.Set(deviceauth.HeaderDeviceID, fixture.deviceID)
	httpHeaders.Set(deviceauth.HeaderTimestamp, fmt.Sprintf("%d", timestamp.UnixMilli()))
	httpHeaders.Set(deviceauth.HeaderNonce, nonce)
	httpHeaders.Set(deviceauth.HeaderSequence, fmt.Sprintf("%d", sequence))
	httpHeaders.Set(deviceauth.HeaderContentSHA256, deviceauth.HashBody(body))
	httpHeaders.Set(deviceauth.HeaderSignature, signature)
	httpHeaders.Set("Authorization", authorization)
	verified, err := deviceauth.VerifyRequest(deviceauth.VerifyInput{
		PublicKey: fixture.publicKey, Method: "POST", RequestTarget: path,
		Headers: httpHeaders, Body: body, AllowedAuthorizationSchemes: []string{"AiCRM-Command"}, Now: timestamp,
	})
	if err != nil {
		t.Fatal(err)
	}
	return signedRevocationRequest{verified: verified, signature: signature}
}

func revocationACKInput(
	revocation store.CredentialRevocationProjection,
	proof deviceauth.VerifiedRequest,
	result, quarantineDigest string,
) store.AcknowledgeCredentialRevocationInput {
	return store.AcknowledgeCredentialRevocationInput{
		ExecutorID: revocation.ExecutorID, RevocationID: revocation.RevocationID,
		OperationID: revocation.OperationID, CredentialRevision: revocation.CredentialRevision,
		RevocationEpoch: revocation.RevocationEpoch, CompletedAt: time.Now().UTC(),
		QuarantineDigest: quarantineDigest, Result: result, KeyGeneration: 1, Proof: proof,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	}
}

func issueExpiredRevocationTicket(
	t *testing.T,
	signer *trustedtoken.Signer,
	fixture credentialRevocationExecutorFixture,
	revocationID, operationID string,
	revocationEpoch int64,
	issuedAt time.Time,
) (string, string, string) {
	t.Helper()
	mac := hmac.New(sha256.New, []byte("revocation-nonce-secret-32-bytes!!"))
	_, _ = mac.Write([]byte("aicrm-credential-logout-ticket-nonce-v1\n" + revocationID))
	nonce := base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:16])
	claims, err := trustedtoken.NewClaims(
		trustedtoken.AudienceCommand, trustedtoken.PurposeCredentialLogout,
		revocationID, nonce, issuedAt,
	)
	if err != nil {
		t.Fatal(err)
	}
	claims.ActorID = fixture.actorID
	claims.ExecutorID = fixture.executorID
	claims.DeviceID = fixture.device.deviceID
	claims.OperationID = operationID
	claims.RevocationID = revocationID
	claims.CredentialRevision = &fixture.credentialRevision
	claims.RevocationEpoch = &revocationEpoch
	token, err := signer.Issue(claims)
	if err != nil {
		t.Fatal(err)
	}
	return token, trustedtoken.Hash(token), revocationDigest(nonce)
}

func assertAuthorizedExecutorShape(t *testing.T, ctx context.Context, db *sql.DB, fixture credentialRevocationExecutorFixture) {
	t.Helper()
	var status, bindingID string
	var current, bindingRevision, epoch int64
	if err := db.QueryRowContext(ctx, `
		SELECT credential_status,current_credential_revision,runtime_binding_id,
		       runtime_binding_revision,revocation_epoch
		FROM ky_ai_executor_config WHERE id=$1
	`, fixture.executorID).Scan(&status, &current, &bindingID, &bindingRevision, &epoch); err != nil {
		t.Fatal(err)
	}
	if status != "authorized" || current != fixture.credentialRevision ||
		bindingID != fixture.runtimeBindingID || bindingRevision != 1 || epoch != fixture.revocationEpoch {
		t.Fatalf("authorized shape status=%s current=%d binding=%s/%d epoch=%d", status, current, bindingID, bindingRevision, epoch)
	}
}

func assertPendingDesktopRevocationShape(t *testing.T, ctx context.Context, db *sql.DB, fixture credentialRevocationExecutorFixture, epoch int64) {
	t.Helper()
	var status, bindingID, readiness string
	var current, bindingRevision, actualEpoch int64
	if err := db.QueryRowContext(ctx, `
		SELECT credential_status,current_credential_revision,runtime_binding_id,
		       runtime_binding_revision,revocation_epoch,readiness_status
		FROM ky_ai_executor_config WHERE id=$1
	`, fixture.executorID).Scan(&status, &current, &bindingID, &bindingRevision, &actualEpoch, &readiness); err != nil {
		t.Fatal(err)
	}
	if status != "revoked" || current != fixture.credentialRevision || bindingID != fixture.runtimeBindingID ||
		bindingRevision != 1 || actualEpoch != epoch || readiness != "unavailable" {
		t.Fatalf("pending shape status=%s current=%d binding=%s/%d epoch=%d readiness=%s",
			status, current, bindingID, bindingRevision, actualEpoch, readiness)
	}
}

func assertRevokedExecutorShape(t *testing.T, ctx context.Context, db *sql.DB, fixture credentialRevocationExecutorFixture, epoch int64, expectUnavailable bool) {
	t.Helper()
	var status, bindingID, readiness string
	var current sql.NullInt64
	var bindingRevision, actualEpoch int64
	if err := db.QueryRowContext(ctx, `
		SELECT credential_status,current_credential_revision,runtime_binding_id,
		       runtime_binding_revision,revocation_epoch,readiness_status
		FROM ky_ai_executor_config WHERE id=$1
	`, fixture.executorID).Scan(&status, &current, &bindingID, &bindingRevision, &actualEpoch, &readiness); err != nil {
		t.Fatal(err)
	}
	if status != "revoked" || current.Valid || bindingID != "" || bindingRevision != 0 || actualEpoch != epoch ||
		(expectUnavailable && readiness != "unavailable") {
		t.Fatalf("revoked shape status=%s current=%v binding=%s/%d epoch=%d readiness=%s",
			status, current, bindingID, bindingRevision, actualEpoch, readiness)
	}
}

func assertCredentialBindingStatus(t *testing.T, ctx context.Context, db *sql.DB, executorID string, revision int64, expected string) {
	t.Helper()
	var status string
	if err := db.QueryRowContext(ctx, `
		SELECT status FROM ky_ai_executor_credential_binding WHERE executor_id=$1 AND revision=$2
	`, executorID, revision).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != expected {
		t.Fatalf("binding %s/%d status=%s want=%s", executorID, revision, status, expected)
	}
}

func assertTaskStatus(t *testing.T, ctx context.Context, db *sql.DB, taskID, expected string) {
	t.Helper()
	var status string
	if err := db.QueryRowContext(ctx, `SELECT status FROM ky_ai_executor_task WHERE id=$1`, taskID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != expected {
		t.Fatalf("task %s status=%s want=%s", taskID, status, expected)
	}
}

func assertRevocationCounts(t *testing.T, ctx context.Context, db *sql.DB, revocationID string, audits, outbox int) {
	t.Helper()
	var actualAudits, actualOutbox int
	if err := db.QueryRowContext(ctx, `
		SELECT (SELECT count(*) FROM ky_ai_executor_credential_revocation_audit WHERE revocation_id=$1),
		       (SELECT count(*) FROM ky_ai_executor_control_outbox
		        WHERE aggregate_type='credential_revocation' AND aggregate_id=$1)
	`, revocationID).Scan(&actualAudits, &actualOutbox); err != nil {
		t.Fatal(err)
	}
	if actualAudits != audits || actualOutbox != outbox {
		t.Fatalf("revocation %s audits=%d outbox=%d", revocationID, actualAudits, actualOutbox)
	}
}

func assertNoRevocationSecrets(t *testing.T, ctx context.Context, db *sql.DB, executorID string, canaries []string) {
	t.Helper()
	var persisted string
	if err := db.QueryRowContext(ctx, `
		SELECT concat_ws('|',
		 COALESCE((SELECT json_agg(value)::text FROM ky_ai_executor_credential_revocation value WHERE executor_id=$1),''),
		 COALESCE((SELECT json_agg(value)::text FROM ky_ai_executor_credential_revocation_audit value WHERE executor_id=$1),''),
		 COALESCE((SELECT json_agg(value)::text FROM ky_ai_executor_desktop_command_operation value WHERE executor_id=$1),''),
		 COALESCE((SELECT json_agg(value)::text FROM ky_ai_executor_control_outbox value
		           WHERE aggregate_id IN (SELECT id FROM ky_ai_executor_credential_revocation WHERE executor_id=$1)),''),
		 COALESCE((SELECT json_agg(value)::text FROM ky_ai_executor_device_request_ledger value
		           WHERE response_reference IN (
		             SELECT 'credential_revocation_' || id FROM ky_ai_executor_credential_revocation WHERE executor_id=$1)),''))
	`, executorID).Scan(&persisted); err != nil {
		t.Fatal(err)
	}
	for _, canary := range canaries {
		if canary != "" && strings.Contains(persisted, canary) {
			t.Fatalf("raw revocation secret reached PostgreSQL: %.24q", canary)
		}
	}
}

func revocationDigest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func revocationNonce(value byte) string {
	raw := make([]byte, 16)
	for index := range raw {
		raw[index] = value + byte(index)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}
