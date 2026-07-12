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
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/operationconfirmation"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	_ "github.com/jackc/pgx/v5/stdlib"
)

func TestControlDeviceBindingStoreAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("KY_AGENT_EXECUTOR_DEVICE_BINDING_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set KY_AGENT_EXECUTOR_DEVICE_BINDING_TEST_DATABASE_URL for PostgreSQL integration")
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
	executorID := "aiexec_binding_" + suffix
	actorID := "owner_binding_" + suffix
	sessionID := "login_binding_" + suffix
	devices := []bindingDeviceFixture{
		newBindingDeviceFixture(t, 11),
		newBindingDeviceFixture(t, 43),
		newBindingDeviceFixture(t, 79),
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_config (
		 id,name,scope_type,scope_id,executor_type,runtime_type,status,is_default,
		 max_concurrency,credential_status,current_credential_revision,
		 credential_revision_counter,runtime_binding_id,runtime_binding_revision
		) VALUES ($1,'Binding integration','platform','platform_root','codex','desktop',
		 'enabled',false,1,'authorized',1,1,$2,1)
	`, executorID, "desktop_binding_"+suffix); err != nil {
		t.Fatal(err)
	}
	for index, device := range devices {
		if _, err := db.ExecContext(ctx, `
			INSERT INTO ky_ai_executor_device (
			 id,public_key,status,label,registered_by,workspace_type,workspace_id
			) VALUES ($1,$2,'active',$3,$4,'platform','platform_root')
		`, device.deviceID, device.publicKey, fmt.Sprintf("binding-%d", index), actorID); err != nil {
			t.Fatal(err)
		}
	}

	initialBody := []byte(`{"deviceId":"initial","expectedRevision":0,"bodyCanary":"raw-bind-body-canary"}`)
	initialProof := signedBindingProof(t, devices[0], "POST", bindingPath(executorID), initialBody,
		"Bearer raw-bind-token-canary", time.Now().UTC(), bindingNonce(1), 1)
	initial := store.BindDeviceInput{
		ExecutorID: executorID, ActorID: actorID, ActorSessionID: sessionID,
		WorkspaceType: "platform", WorkspaceID: "platform_root", TargetDeviceID: devices[0].deviceID,
		ExpectedRevision: 0, OperationReference: "binding_initial_" + suffix,
		KeyGeneration: 1, Proof: initialProof.verified,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	}
	const bindWorkers = 12
	var bindAccepted, bindReplayed atomic.Int64
	bindErrors := make(chan error, bindWorkers)
	var bindGroup sync.WaitGroup
	for worker := 0; worker < bindWorkers; worker++ {
		bindGroup.Add(1)
		go func() {
			defer bindGroup.Done()
			result, err := control.BindDevice(ctx, initial)
			if err != nil {
				bindErrors <- err
				return
			}
			if result.Binding.Revision != 1 || result.Binding.Status != "active" ||
				result.Binding.DeviceID != devices[0].deviceID || result.ResponseReference != initial.OperationReference {
				bindErrors <- fmt.Errorf("unexpected initial binding result: %#v", result)
				return
			}
			if result.Replayed {
				bindReplayed.Add(1)
			} else {
				bindAccepted.Add(1)
			}
		}()
	}
	bindGroup.Wait()
	close(bindErrors)
	for bindErr := range bindErrors {
		t.Fatal(bindErr)
	}
	if bindAccepted.Load() != 1 || bindReplayed.Load() != bindWorkers-1 {
		t.Fatalf("initial bind accepted=%d replayed=%d", bindAccepted.Load(), bindReplayed.Load())
	}
	assertBindingState(t, ctx, db, executorID, devices[0].deviceID, "active", 1)
	assertBindingMutationCounts(t, ctx, db, executorID, 1, 1, 1)

	if err := control.Close(); err != nil {
		t.Fatal(err)
	}
	control, err = store.OpenControl(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if replay, err := control.BindDevice(ctx, initial); err != nil || !replay.Replayed || replay.Binding.Revision != 1 {
		t.Fatalf("restart initial replay=%#v err=%v", replay, err)
	}

	changedBody := initial
	changedBody.Proof = signedBindingProof(t, devices[0], "POST", bindingPath(executorID),
		[]byte(`{"deviceId":"changed"}`), "Bearer raw-bind-token-canary", time.Now().UTC(), bindingNonce(1), 1).verified
	if _, err := control.BindDevice(ctx, changedBody); !errors.Is(err, store.ErrDeviceProofReplayed) {
		t.Fatalf("same sequence changed body was not rejected: %v", err)
	}
	changedToken := initial
	changedToken.Proof = signedBindingProof(t, devices[0], "POST", bindingPath(executorID), initialBody,
		"Bearer changed-bind-token", time.Now().UTC(), bindingNonce(1), 1).verified
	if _, err := control.BindDevice(ctx, changedToken); !errors.Is(err, store.ErrDeviceProofReplayed) {
		t.Fatalf("same sequence changed bearer token was not rejected: %v", err)
	}
	changedNonce := initial
	changedNonce.Proof = signedBindingProof(t, devices[0], "POST", bindingPath(executorID), initialBody,
		"Bearer raw-bind-token-canary", time.Now().UTC(), bindingNonce(9), 1).verified
	if _, err := control.BindDevice(ctx, changedNonce); !errors.Is(err, store.ErrDeviceProofReplayed) {
		t.Fatalf("same sequence changed nonce was not rejected: %v", err)
	}
	reusedNonce := initial
	reusedNonce.Proof = signedBindingProof(t, devices[0], "POST", bindingPath(executorID),
		[]byte(`{"deviceId":"nonce-reuse"}`), "Bearer nonce-reuse", time.Now().UTC(), bindingNonce(1), 2).verified
	if _, err := control.BindDevice(ctx, reusedNonce); !errors.Is(err, store.ErrDeviceBindingAlreadyActive) {
		t.Fatalf("active binding should fence a new initial mutation: %v", err)
	}

	manager := newConfirmationManager(t, control)
	loginAt := time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond)
	rebindToken, rebindConfirmationID, rebindChallenge := confirmedBindingOperation(t, ctx, manager,
		store.OperationConfirmationRebindDevice, executorID, actorID, sessionID, 1, devices[1].deviceID,
		loginAt, "rebind_"+suffix)
	rebindBody := []byte(fmt.Sprintf(`{"fromDeviceId":%q,"toDeviceId":%q,"expectedRevision":1,"confirmationToken":%q,"bodyCanary":"raw-rebind-body-canary"}`,
		devices[0].deviceID, devices[1].deviceID, rebindToken))
	rebindProof := signedBindingProof(t, devices[1], "POST", rebindPath(executorID), rebindBody,
		"Bearer raw-rebind-token-canary", time.Now().UTC(), bindingNonce(11), 1)
	rebind := store.RebindDeviceInput{
		ExecutorID: executorID, ActorID: actorID, ActorSessionID: sessionID,
		WorkspaceType: "platform", WorkspaceID: "platform_root", FromDeviceID: devices[0].deviceID,
		TargetDeviceID: devices[1].deviceID, ExpectedRevision: 1,
		OperationReference: "binding_rebind_" + suffix, KeyGeneration: 1, Proof: rebindProof.verified,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	}
	rebindConsume := operationconfirmation.ConsumeInput{
		ConfirmationToken: rebindToken, Action: store.OperationConfirmationRebindDevice,
		ActorID: actorID, ActorSessionID: sessionID, ExecutorID: executorID, ExpectedRevision: 1,
		FromDeviceID: devices[0].deviceID, TargetDeviceID: devices[1].deviceID,
		ConsumptionReference: rebind.OperationReference,
	}
	const rebindWorkers = 10
	var rebindConsumed, rebindReplayCount atomic.Int64
	rebindErrors := make(chan error, rebindWorkers)
	var rebindGroup sync.WaitGroup
	for worker := 0; worker < rebindWorkers; worker++ {
		rebindGroup.Add(1)
		go func() {
			defer rebindGroup.Done()
			var result store.DeviceBindingResult
			_, err := manager.Consume(ctx, rebindConsume, control.RebindDeviceMutation(rebind, &result))
			if err == nil {
				rebindConsumed.Add(1)
			} else if errors.Is(err, store.ErrOperationConfirmationTokenConsumed) {
				var handled bool
				result, handled, err = control.ReplayRebindDevice(ctx, rebind)
				if err == nil && handled {
					rebindReplayCount.Add(1)
				} else if err == nil {
					err = errors.New("consumed rebind was not replayable")
				}
			}
			if err != nil || result.Binding.Revision != 2 || result.Binding.DeviceID != devices[1].deviceID {
				rebindErrors <- fmt.Errorf("rebind result=%#v err=%v", result, err)
			}
		}()
	}
	rebindGroup.Wait()
	close(rebindErrors)
	for rebindErr := range rebindErrors {
		t.Fatal(rebindErr)
	}
	if rebindConsumed.Load() != 1 || rebindReplayCount.Load() != rebindWorkers-1 {
		t.Fatalf("rebind consumed=%d replayed=%d", rebindConsumed.Load(), rebindReplayCount.Load())
	}
	assertBindingState(t, ctx, db, executorID, devices[1].deviceID, "active", 2)
	assertConfirmationStatus(t, ctx, db, rebindConfirmationID, "consumed")
	assertBindingMutationCounts(t, ctx, db, executorID, 2, 2, 2)

	unbindToken, unbindConfirmationID, unbindChallenge := confirmedBindingOperation(t, ctx, manager,
		store.OperationConfirmationUnbindDevice, executorID, actorID, sessionID, 2, "", loginAt, "unbind_"+suffix)
	unbindBody := []byte(fmt.Sprintf(`{"deviceId":%q,"expectedRevision":2,"confirmationToken":%q,"force":false}`,
		devices[1].deviceID, unbindToken))
	unbindProof := signedBindingProof(t, devices[1], "DELETE", unbindPath(executorID), unbindBody,
		"Bearer normal-unbind-token-canary", time.Now().UTC(), bindingNonce(12), 2)
	unbind := store.UnbindDeviceInput{
		ExecutorID: executorID, ActorID: actorID, ActorSessionID: sessionID,
		WorkspaceType: "platform", WorkspaceID: "platform_root", DeviceID: devices[1].deviceID,
		ExpectedRevision: 2, OperationReference: "binding_unbind_" + suffix,
		KeyGeneration: 1, Proof: unbindProof.verified,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	}
	var unbindResult store.DeviceBindingResult
	if _, err := manager.Consume(ctx, operationconfirmation.ConsumeInput{
		ConfirmationToken: unbindToken, Action: store.OperationConfirmationUnbindDevice,
		ActorID: actorID, ActorSessionID: sessionID, ExecutorID: executorID, ExpectedRevision: 2,
		FromDeviceID: devices[1].deviceID, ConsumptionReference: unbind.OperationReference,
	}, control.UnbindDeviceMutation(unbind, &unbindResult)); err != nil {
		t.Fatal(err)
	}
	if unbindResult.Binding.Status != "revoked" || unbindResult.Binding.Revision != 3 {
		t.Fatalf("normal unbind result=%#v", unbindResult)
	}
	if replay, handled, err := control.ReplayUnbindDevice(ctx, unbind); err != nil || !handled || !replay.Replayed || replay.Binding.Revision != 3 {
		t.Fatalf("normal unbind replay=%#v handled=%v err=%v", replay, handled, err)
	}
	assertConfirmationStatus(t, ctx, db, unbindConfirmationID, "consumed")
	assertBindingState(t, ctx, db, executorID, devices[1].deviceID, "revoked", 3)

	reactivateProof := signedBindingProof(t, devices[1], "POST", bindingPath(executorID),
		[]byte(`{"deviceId":"reactivate","expectedRevision":3}`), "Bearer reactivate-token",
		time.Now().UTC(), bindingNonce(13), 3)
	reactivate := store.BindDeviceInput{
		ExecutorID: executorID, ActorID: actorID, ActorSessionID: sessionID,
		WorkspaceType: "platform", WorkspaceID: "platform_root", TargetDeviceID: devices[1].deviceID,
		ExpectedRevision: 3, OperationReference: "binding_reactivate_" + suffix,
		KeyGeneration: 1, Proof: reactivateProof.verified,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	}
	if result, err := control.BindDevice(ctx, reactivate); err != nil || result.Binding.Revision != 4 {
		t.Fatalf("reactivate result=%#v err=%v", result, err)
	}

	forceToken, forceConfirmationID, forceChallenge := confirmedBindingOperation(t, ctx, manager,
		store.OperationConfirmationUnbindDevice, executorID, actorID, sessionID, 4, "", loginAt, "force_"+suffix)
	force := store.UnbindDeviceInput{
		ExecutorID: executorID, ActorID: actorID, ActorSessionID: sessionID,
		WorkspaceType: "platform", WorkspaceID: "platform_root", DeviceID: devices[1].deviceID,
		ExpectedRevision: 4, OperationReference: "binding_force_unbind_" + suffix,
		Force: true, RequestHash: confirmationDigest("force-request:" + suffix),
	}
	forceConsume := operationconfirmation.ConsumeInput{
		ConfirmationToken: forceToken, Action: store.OperationConfirmationUnbindDevice,
		ActorID: actorID, ActorSessionID: sessionID, ExecutorID: executorID, ExpectedRevision: 4,
		FromDeviceID: devices[1].deviceID, ConsumptionReference: force.OperationReference,
	}
	var forceResult store.DeviceBindingResult
	if _, err := manager.Consume(ctx, forceConsume, control.UnbindDeviceMutation(force, &forceResult)); err != nil {
		t.Fatal(err)
	}
	if !forceResult.Binding.Force || forceResult.Binding.Revision != 5 || forceResult.Binding.Status != "revoked" {
		t.Fatalf("force unbind result=%#v", forceResult)
	}
	if _, err := manager.Consume(ctx, forceConsume, control.UnbindDeviceMutation(force, &store.DeviceBindingResult{})); !errors.Is(err, store.ErrOperationConfirmationTokenConsumed) {
		t.Fatalf("force token was not one-time: %v", err)
	}
	if replay, handled, err := control.ReplayForceUnbindDevice(ctx, force); err != nil || !handled || !replay.Replayed || !replay.Binding.Force {
		t.Fatalf("force replay=%#v handled=%v err=%v", replay, handled, err)
	}
	assertConfirmationStatus(t, ctx, db, forceConfirmationID, "consumed")

	fencedProof := signedBindingProof(t, devices[0], "POST", bindingPath(executorID),
		[]byte(`{"deviceId":"executor-fenced","expectedRevision":5}`), "Bearer executor-fenced-token",
		time.Now().UTC(), bindingNonce(3), 2)
	fencedBind := store.BindDeviceInput{
		ExecutorID: executorID, ActorID: actorID, ActorSessionID: sessionID,
		WorkspaceType: "platform", WorkspaceID: "platform_root", TargetDeviceID: devices[0].deviceID,
		ExpectedRevision: 5, OperationReference: "binding_executor_fenced_" + suffix,
		KeyGeneration: 1, Proof: fencedProof.verified,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	}
	if _, err := db.ExecContext(ctx, `UPDATE ky_ai_executor_config SET status='disabled' WHERE id=$1`, executorID); err != nil {
		t.Fatal(err)
	}
	if _, err := control.BindDevice(ctx, fencedBind); !errors.Is(err, store.ErrExecutorDisabled) {
		t.Fatalf("disabled executor was not fenced: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE ky_ai_executor_config SET status='enabled' WHERE id=$1`, executorID); err != nil {
		t.Fatal(err)
	}
	wrongRevisionProof := signedBindingProof(t, devices[0], "POST", bindingPath(executorID),
		[]byte(`{"deviceId":"wrong-revision","expectedRevision":4}`), "Bearer wrong-revision-token",
		time.Now().UTC(), bindingNonce(4), 2)
	wrongRevisionBind := fencedBind
	wrongRevisionBind.ExpectedRevision = 4
	wrongRevisionBind.OperationReference = "binding_wrong_revision_" + suffix
	wrongRevisionBind.Proof = wrongRevisionProof.verified
	if _, err := control.BindDevice(ctx, wrongRevisionBind); !errors.Is(err, store.ErrRevisionConflict) {
		t.Fatalf("binding revision CAS was not enforced: %v", err)
	}

	staleProof := signedBindingProof(t, devices[0], "POST", bindingPath(executorID),
		[]byte(`{"deviceId":"stale"}`), "Bearer stale-token",
		time.Now().UTC().Add(-deviceauth.ClockWindow-time.Second), bindingNonce(5), 2)
	staleBind := store.BindDeviceInput{
		ExecutorID: executorID, ActorID: actorID, ActorSessionID: sessionID,
		WorkspaceType: "platform", WorkspaceID: "platform_root", TargetDeviceID: devices[0].deviceID,
		ExpectedRevision: 5, OperationReference: "binding_stale_" + suffix,
		KeyGeneration: 1, Proof: staleProof.verified,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	}
	if _, err := control.BindDevice(ctx, staleBind); !errors.Is(err, deviceauth.ErrTimestampOutsideWindow) {
		t.Fatalf("store did not enforce PostgreSQL clock: %v", err)
	}
	activeProof := signedBindingProof(t, devices[0], "POST", bindingPath(executorID),
		[]byte(`{"deviceId":"active-again"}`), "Bearer active-again-token",
		time.Now().UTC(), bindingNonce(6), 2)
	activeBind := staleBind
	activeBind.OperationReference = "binding_active_again_" + suffix
	activeBind.Proof = activeProof.verified
	if result, err := control.BindDevice(ctx, activeBind); err != nil || result.Binding.Revision != 6 {
		t.Fatalf("post-force bind result=%#v err=%v", result, err)
	}

	raceToken, raceConfirmationID, raceChallenge := confirmedBindingOperation(t, ctx, manager,
		store.OperationConfirmationRebindDevice, executorID, actorID, sessionID, 6, devices[2].deviceID,
		loginAt, "race_"+suffix)
	raceBody := []byte(fmt.Sprintf(`{"fromDeviceId":%q,"toDeviceId":%q,"expectedRevision":6,"confirmationToken":%q}`,
		devices[0].deviceID, devices[2].deviceID, raceToken))
	raceProof := signedBindingProof(t, devices[2], "POST", rebindPath(executorID), raceBody,
		"Bearer race-token-canary", time.Now().UTC(), bindingNonce(21), 1)
	raceInput := store.RebindDeviceInput{
		ExecutorID: executorID, ActorID: actorID, ActorSessionID: sessionID,
		WorkspaceType: "platform", WorkspaceID: "platform_root", FromDeviceID: devices[0].deviceID,
		TargetDeviceID: devices[2].deviceID, ExpectedRevision: 6,
		OperationReference: "binding_race_rebind_" + suffix, KeyGeneration: 1, Proof: raceProof.verified,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	}
	raceConsume := operationconfirmation.ConsumeInput{
		ConfirmationToken: raceToken, Action: store.OperationConfirmationRebindDevice,
		ActorID: actorID, ActorSessionID: sessionID, ExecutorID: executorID, ExpectedRevision: 6,
		FromDeviceID: devices[0].deviceID, TargetDeviceID: devices[2].deviceID,
		ConsumptionReference: raceInput.OperationReference,
	}
	for _, state := range []struct {
		name, status, workspace string
		generation              int
		want                    error
	}{
		{"disabled after confirmation", "disabled", "platform_root", 1, store.ErrDeviceInactive},
		{"revoked after confirmation", "revoked", "platform_root", 1, store.ErrDeviceInactive},
		{"workspace moved after confirmation", "active", "other_workspace", 1, store.ErrDeviceBindingTargetMismatch},
		{"key rotated after confirmation", "active", "platform_root", 2, store.ErrDeviceKeyGenerationMismatch},
	} {
		if _, err := db.ExecContext(ctx, `
			UPDATE ky_ai_executor_device
			SET status=$2,workspace_id=$3,key_generation=$4,last_accepted_sequence=0
			WHERE id=$1
		`, devices[2].deviceID, state.status, state.workspace, state.generation); err != nil {
			t.Fatal(err)
		}
		var result store.DeviceBindingResult
		if _, err := manager.Consume(ctx, raceConsume, control.RebindDeviceMutation(raceInput, &result)); !errors.Is(err, state.want) {
			t.Fatalf("%s got=%v want=%v", state.name, err, state.want)
		}
		assertConfirmationStatus(t, ctx, db, raceConfirmationID, "confirmed")
		assertBindingState(t, ctx, db, executorID, devices[0].deviceID, "active", 6)
		assertDeviceSequence(t, ctx, db, devices[2].deviceID, 0)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_device
		SET status='active',workspace_id='platform_root',key_generation=1,last_accepted_sequence=0
		WHERE id=$1
	`, devices[2].deviceID); err != nil {
		t.Fatal(err)
	}
	var raceResult store.DeviceBindingResult
	if _, err := manager.Consume(ctx, raceConsume, control.RebindDeviceMutation(raceInput, &raceResult)); err != nil {
		t.Fatal(err)
	}
	if raceResult.Binding.Revision != 7 || raceResult.Binding.DeviceID != devices[2].deviceID {
		t.Fatalf("race recovery result=%#v", raceResult)
	}

	rollbackToken, rollbackConfirmationID, rollbackChallenge := confirmedBindingOperation(t, ctx, manager,
		store.OperationConfirmationUnbindDevice, executorID, actorID, sessionID, 7, "", loginAt, "rollback_"+suffix)
	rollbackBody := []byte(fmt.Sprintf(`{"deviceId":%q,"expectedRevision":7,"confirmationToken":%q,"force":false}`,
		devices[2].deviceID, rollbackToken))
	rollbackProof := signedBindingProof(t, devices[2], "DELETE", unbindPath(executorID), rollbackBody,
		"Bearer rollback-token-canary", time.Now().UTC(), bindingNonce(22), 2)
	rollbackInput := store.UnbindDeviceInput{
		ExecutorID: executorID, ActorID: actorID, ActorSessionID: sessionID,
		WorkspaceType: "platform", WorkspaceID: "platform_root", DeviceID: devices[2].deviceID,
		ExpectedRevision: 7, OperationReference: "binding_rollback_unbind_" + suffix,
		KeyGeneration: 1, Proof: rollbackProof.verified,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_device_binding_audit (
		 operation_reference,executor_id,binding_revision,event_type,actor_id,actor_session_id,
		 workspace_type,workspace_id,expected_revision,target_device_id,proof_device_id,
		 proof_key_generation,proof_sequence,request_hash,force,occurred_at
		) VALUES ($1,$2,8,'bound',$3,$4,'platform','platform_root',7,$5,$5,1,99,$6,false,transaction_timestamp())
	`, "binding_conflicting_audit_"+suffix, executorID, actorID, sessionID,
		devices[0].deviceID, confirmationDigest("conflicting-audit:"+suffix)); err != nil {
		t.Fatal(err)
	}
	var rollbackResult store.DeviceBindingResult
	_, err = manager.Consume(ctx, operationconfirmation.ConsumeInput{
		ConfirmationToken: rollbackToken, Action: store.OperationConfirmationUnbindDevice,
		ActorID: actorID, ActorSessionID: sessionID, ExecutorID: executorID, ExpectedRevision: 7,
		FromDeviceID: devices[2].deviceID, ConsumptionReference: rollbackInput.OperationReference,
	}, control.UnbindDeviceMutation(rollbackInput, &rollbackResult))
	if err == nil {
		t.Fatal("conflicting immutable audit did not roll back binding transaction")
	}
	assertConfirmationStatus(t, ctx, db, rollbackConfirmationID, "confirmed")
	assertBindingState(t, ctx, db, executorID, devices[2].deviceID, "active", 7)
	assertDeviceSequence(t, ctx, db, devices[2].deviceID, 1)
	var rolledBackLedger, rolledBackAudit int
	if err := db.QueryRowContext(ctx, `
		SELECT
		 (SELECT count(*) FROM ky_ai_executor_device_request_ledger WHERE device_id=$1 AND key_generation=1 AND sequence=2),
		 (SELECT count(*) FROM ky_ai_executor_device_binding_audit WHERE operation_reference=$2)
	`, devices[2].deviceID, rollbackInput.OperationReference).Scan(&rolledBackLedger, &rolledBackAudit); err != nil {
		t.Fatal(err)
	}
	if rolledBackLedger != 0 || rolledBackAudit != 0 {
		t.Fatalf("audit failure leaked ledger=%d audit=%d", rolledBackLedger, rolledBackAudit)
	}

	assertNoBindingSecrets(t, ctx, db, executorID, []string{
		"raw-bind-body-canary", "raw-bind-token-canary", initialProof.signature,
		"raw-rebind-body-canary", "raw-rebind-token-canary", rebindProof.signature,
		"normal-unbind-token-canary", unbindProof.signature,
		"race-token-canary", raceProof.signature,
		"rollback-token-canary", rollbackProof.signature,
		rebindToken, unbindToken, forceToken, raceToken, rollbackToken,
		rebindChallenge, unbindChallenge, forceChallenge, raceChallenge, rollbackChallenge,
	})
}

type bindingDeviceFixture struct {
	privateKey ed25519.PrivateKey
	publicKey  string
	deviceID   string
}

type signedBindingRequest struct {
	verified  deviceauth.VerifiedRequest
	signature string
}

func newBindingDeviceFixture(t *testing.T, seedByte byte) bindingDeviceFixture {
	t.Helper()
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = seedByte + byte(index)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	publicKey := privateKey.Public().(ed25519.PublicKey)
	encoded, err := deviceauth.EncodePublicKey(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	deviceID, err := deviceauth.DeviceID(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	return bindingDeviceFixture{privateKey: privateKey, publicKey: encoded, deviceID: deviceID}
}

func signedBindingProof(
	t *testing.T,
	fixture bindingDeviceFixture,
	method string,
	path string,
	body []byte,
	authorization string,
	timestamp time.Time,
	nonce string,
	sequence uint64,
) signedBindingRequest {
	t.Helper()
	authorizationHash, err := deviceauth.AuthorizationTokenHash(authorization, []string{"Bearer"})
	if err != nil {
		t.Fatal(err)
	}
	headers := deviceauth.ProofHeaders{
		DeviceID: fixture.deviceID, TimestampMilli: timestamp.UnixMilli(), Nonce: nonce,
		Sequence: sequence, BodySHA256: deviceauth.HashBody(body),
	}
	signingInput, err := deviceauth.SigningInput(method, path, headers, authorizationHash)
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
		PublicKey: fixture.publicKey, Method: method, RequestTarget: path,
		Headers: httpHeaders, Body: body, AllowedAuthorizationSchemes: []string{"Bearer"}, Now: timestamp,
	})
	if err != nil {
		t.Fatal(err)
	}
	return signedBindingRequest{verified: verified, signature: signature}
}

func confirmedBindingOperation(
	t *testing.T,
	ctx context.Context,
	manager *operationconfirmation.Manager,
	action, executorID, actorID, sessionID string,
	expectedRevision int64,
	targetDeviceID string,
	loginAt time.Time,
	reference string,
) (string, string, string) {
	t.Helper()
	created, err := manager.Create(ctx, operationconfirmation.CreateInput{
		Action: action, ExecutorID: executorID, ActorID: actorID, ActorSessionID: sessionID,
		ExpectedRevision: expectedRevision, TargetDeviceID: targetDeviceID,
		OwnerVerified: true, LoginAuthenticatedAt: loginAt, MFARequired: true, MFAVerified: true,
		IdempotencyKeyHash: confirmationDigest(reference + ":key"),
		RequestHash:        confirmationDigest(reference + ":request"),
	})
	if err != nil {
		t.Fatal(err)
	}
	confirmed, err := manager.Confirm(ctx, operationconfirmation.ConfirmInput{
		ConfirmationID: created.ConfirmationID, ActorID: actorID, ActorSessionID: sessionID,
		ChallengeText: created.ChallengeText, OwnerVerified: true, LoginAuthenticatedAt: loginAt,
		MFARequired: true, MFAVerified: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	return confirmed.ConfirmationToken, created.ConfirmationID, created.ChallengeText
}

func assertBindingState(t *testing.T, ctx context.Context, db *sql.DB, executorID, deviceID, status string, revision int64) {
	t.Helper()
	var actualDevice, actualStatus string
	var actualRevision int64
	if err := db.QueryRowContext(ctx, `
		SELECT device_id,status,revision FROM ky_ai_executor_device_binding WHERE executor_id=$1
	`, executorID).Scan(&actualDevice, &actualStatus, &actualRevision); err != nil {
		t.Fatal(err)
	}
	if actualDevice != deviceID || actualStatus != status || actualRevision != revision {
		t.Fatalf("binding device=%s status=%s revision=%d", actualDevice, actualStatus, actualRevision)
	}
}

func assertBindingMutationCounts(t *testing.T, ctx context.Context, db *sql.DB, executorID string, revision, auditCount, outboxCount int) {
	t.Helper()
	var actualRevision int
	var actualAudits, actualOutbox int
	if err := db.QueryRowContext(ctx, `
		SELECT binding.revision,
		 (SELECT count(*) FROM ky_ai_executor_device_binding_audit WHERE executor_id=binding.executor_id),
		 (SELECT count(*) FROM ky_ai_executor_control_outbox WHERE aggregate_type='device_binding' AND aggregate_id=binding.executor_id)
		FROM ky_ai_executor_device_binding binding WHERE executor_id=$1
	`, executorID).Scan(&actualRevision, &actualAudits, &actualOutbox); err != nil {
		t.Fatal(err)
	}
	if actualRevision != revision || actualAudits != auditCount || actualOutbox != outboxCount {
		t.Fatalf("binding revision=%d audits=%d outbox=%d", actualRevision, actualAudits, actualOutbox)
	}
}

func assertConfirmationStatus(t *testing.T, ctx context.Context, db *sql.DB, confirmationID, expected string) {
	t.Helper()
	var status string
	if err := db.QueryRowContext(ctx, `
		SELECT status FROM ky_ai_executor_operation_confirmation WHERE id=$1
	`, confirmationID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != expected {
		t.Fatalf("confirmation %s status=%s want=%s", confirmationID, status, expected)
	}
}

func assertDeviceSequence(t *testing.T, ctx context.Context, db *sql.DB, deviceID string, expected int64) {
	t.Helper()
	var sequence int64
	if err := db.QueryRowContext(ctx, `
		SELECT last_accepted_sequence FROM ky_ai_executor_device WHERE id=$1
	`, deviceID).Scan(&sequence); err != nil {
		t.Fatal(err)
	}
	if sequence != expected {
		t.Fatalf("device %s sequence=%d want=%d", deviceID, sequence, expected)
	}
}

func assertNoBindingSecrets(t *testing.T, ctx context.Context, db *sql.DB, executorID string, canaries []string) {
	t.Helper()
	var persisted string
	if err := db.QueryRowContext(ctx, `
		SELECT concat_ws('|',
		 COALESCE((SELECT json_agg(value)::text FROM ky_ai_executor_device_binding value WHERE executor_id=$1),''),
		 COALESCE((SELECT json_agg(value)::text FROM ky_ai_executor_device_binding_audit value WHERE executor_id=$1),''),
		 COALESCE((SELECT json_agg(value)::text FROM ky_ai_executor_device_request_ledger value
		           WHERE device_id IN (
		             SELECT proof_device_id FROM ky_ai_executor_device_binding_audit
		             WHERE executor_id=$1 AND proof_device_id <> '')),''),
		 COALESCE((SELECT json_agg(value)::text FROM ky_ai_executor_operation_confirmation value WHERE executor_id=$1),''),
		 COALESCE((SELECT json_agg(value)::text FROM ky_ai_executor_operation_confirmation_audit value
		           WHERE confirmation_id IN (SELECT id FROM ky_ai_executor_operation_confirmation WHERE executor_id=$1)),''),
		 COALESCE((SELECT json_agg(value)::text FROM ky_ai_executor_control_outbox value
		           WHERE aggregate_id=$1 OR aggregate_id IN (
		             SELECT id FROM ky_ai_executor_operation_confirmation WHERE executor_id=$1)),''))
	`, executorID).Scan(&persisted); err != nil {
		t.Fatal(err)
	}
	for _, canary := range canaries {
		if canary != "" && strings.Contains(persisted, canary) {
			t.Fatalf("raw secret canary reached PostgreSQL: %.24q", canary)
		}
	}
}

func bindingNonce(value byte) string {
	raw := make([]byte, 16)
	for index := range raw {
		raw[index] = value + byte(index)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func bindingPath(executorID string) string {
	return "/api/v1/ai-executors/" + executorID + "/device-bindings"
}

func rebindPath(executorID string) string {
	return "/api/v1/ai-executors/" + executorID + "/device-binding/rebind"
}

func unbindPath(executorID string) string {
	return "/api/v1/ai-executors/" + executorID + "/device-binding"
}
