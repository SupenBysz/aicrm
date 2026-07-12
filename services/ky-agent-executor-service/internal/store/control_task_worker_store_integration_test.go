package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"
)

func TestControlTaskWorkerLifecycleAgainstPostgres(t *testing.T) {
	control, ctx := openControlWorkerTestStore(t)
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	seed := seedControlWorkerTask(t, ctx, control, suffix, "model_catalog_refresh")
	work, found, err := control.ClaimControlTask(ctx, "owner_normal_"+suffix, "0.144.1")
	if err != nil || !found || work.TaskID != seed.taskID || work.LeaseEpoch != 1 {
		t.Fatalf("claim work=%#v found=%v err=%v", work, found, err)
	}
	if err := control.StartControlTask(ctx, work); err != nil {
		t.Fatal(err)
	}
	if err := control.RenewControlTaskLease(ctx, work); err != nil {
		t.Fatal(err)
	}
	candidateDigest := testTaskDigest("rotated:" + suffix)
	revision, err := control.PrepareControlTaskCredentialRotation(ctx, work, candidateDigest)
	if err != nil || revision != 2 {
		t.Fatalf("prepare revision=%d err=%v", revision, err)
	}
	if err := control.MarkControlTaskCredentialCommitting(ctx, work, revision, candidateDigest); err != nil {
		t.Fatal(err)
	}
	if err := control.CompleteControlTask(ctx, CompleteControlTaskInput{
		Work: work,
		Models: []ModelCatalogEntry{{
			CatalogItemID: "catalog_" + suffix, ModelKey: "gpt-5.6", DisplayName: "GPT-5.6",
			InputModalitiesJSON: []byte(`["image","text"]`), SupportedReasoningJSON: []byte(`["high"]`),
		}},
		CodexVersion: "0.144.1", PromotedCredentialRevision: &revision,
		PromotedBindingDigest: candidateDigest,
	}); err != nil {
		t.Fatal(err)
	}
	var taskStatus, leaseStatus, oldBindingStatus, newBindingStatus string
	var currentCredential, catalogRevision int64
	if err := control.db.QueryRowContext(ctx, `
		SELECT task.status,lease.status,old_binding.status,new_binding.status,
		       config.current_credential_revision,config.catalog_revision
		FROM ky_ai_executor_task task
		JOIN ky_ai_executor_operation_lease lease ON lease.executor_id=$1
		JOIN ky_ai_executor_config config ON config.id=$1
		JOIN ky_ai_executor_credential_binding old_binding
		  ON old_binding.executor_id=$1 AND old_binding.revision=1
		JOIN ky_ai_executor_credential_binding new_binding
		  ON new_binding.executor_id=$1 AND new_binding.revision=2
		WHERE task.id=$2
	`, seed.executorID, seed.taskID).Scan(
		&taskStatus, &leaseStatus, &oldBindingStatus, &newBindingStatus,
		&currentCredential, &catalogRevision,
	); err != nil {
		t.Fatal(err)
	}
	if taskStatus != "completed" || leaseStatus != "released" || oldBindingStatus != "revoked" ||
		newBindingStatus != "active" || currentCredential != 2 || catalogRevision != 3 {
		t.Fatalf("task=%s lease=%s old=%s new=%s credential=%d catalog=%d",
			taskStatus, leaseStatus, oldBindingStatus, newBindingStatus, currentCredential, catalogRevision)
	}

	failureSeed := seedControlWorkerTask(t, ctx, control, suffix+"_fail", "readiness_check")
	failureWork, found, err := control.ClaimControlTask(ctx, "owner_fail_"+suffix, "0.144.1")
	if err != nil || !found || failureWork.TaskID != failureSeed.taskID {
		t.Fatalf("failure claim work=%#v found=%v err=%v", failureWork, found, err)
	}
	if err := control.StartControlTask(ctx, failureWork); err != nil {
		t.Fatal(err)
	}
	if err := control.FailControlTask(ctx, failureWork, "failed", "executor_app_server_unavailable", false); err != nil {
		t.Fatal(err)
	}
	if err := control.db.QueryRowContext(ctx, `SELECT status FROM ky_ai_executor_task WHERE id=$1`, failureSeed.taskID).Scan(&taskStatus); err != nil {
		t.Fatal(err)
	}
	if taskStatus != "failed" {
		t.Fatalf("failed task status=%s", taskStatus)
	}
}

func TestControlTaskWorkerConcurrentClaimAgainstPostgres(t *testing.T) {
	control, ctx := openControlWorkerTestStore(t)
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	seed := seedControlWorkerTask(t, ctx, control, suffix, "readiness_check")
	type result struct {
		work  ControlTaskWork
		found bool
		err   error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	var wg sync.WaitGroup
	for index := 0; index < 2; index++ {
		wg.Add(1)
		go func(owner string) {
			defer wg.Done()
			<-start
			work, found, err := control.ClaimControlTask(ctx, owner, "0.144.1")
			results <- result{work: work, found: found, err: err}
		}(fmt.Sprintf("owner_concurrent_%d_%s", index, suffix))
	}
	close(start)
	wg.Wait()
	close(results)
	winners := []ControlTaskWork{}
	for result := range results {
		if result.err != nil && !errors.Is(result.err, ErrConflict) {
			t.Fatalf("claim err=%v", result.err)
		}
		if result.found {
			winners = append(winners, result.work)
		}
	}
	if len(winners) != 1 || winners[0].TaskID != seed.taskID {
		t.Fatalf("winners=%#v", winners)
	}
	if err := control.FailControlTask(ctx, winners[0], "failed", "executor_app_server_unavailable", false); err != nil {
		t.Fatal(err)
	}
}

func TestControlTaskWorkerExpiredLeaseRecoveryFencesOldEpochAgainstPostgres(t *testing.T) {
	control, ctx := openControlWorkerTestStore(t)
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	seed := seedControlWorkerTask(t, ctx, control, suffix, "model_catalog_refresh")
	oldWork, found, err := control.ClaimControlTask(ctx, "owner_before_restart_"+suffix, "0.144.1")
	if err != nil || !found {
		t.Fatalf("claim found=%v err=%v", found, err)
	}
	if err := control.StartControlTask(ctx, oldWork); err != nil {
		t.Fatal(err)
	}
	candidateDigest := testTaskDigest("recovery-rotated:" + suffix)
	revision, err := control.PrepareControlTaskCredentialRotation(ctx, oldWork, candidateDigest)
	if err != nil {
		t.Fatal(err)
	}
	if item, found, err := control.ClaimExpiredControlTaskRecovery(ctx, "too_early_"+suffix, "0.144.1"); err != nil || found {
		t.Fatalf("unexpired recovery item=%#v found=%v err=%v", item, found, err)
	}
	if _, err := control.db.ExecContext(ctx, `
		UPDATE ky_ai_executor_operation_lease SET lease_expires_at=now()-interval '1 second'
		WHERE executor_id=$1 AND lease_epoch=$2
	`, seed.executorID, oldWork.LeaseEpoch); err != nil {
		t.Fatal(err)
	}
	if err := control.RenewControlTaskLease(ctx, oldWork); !errors.Is(err, ErrExecutorFenced) {
		t.Fatalf("expired old owner renewed before takeover: %v", err)
	}

	type recoveryResult struct {
		item  ControlTaskRecoveryItem
		found bool
		err   error
	}
	start := make(chan struct{})
	results := make(chan recoveryResult, 2)
	var wg sync.WaitGroup
	for index := 0; index < 2; index++ {
		wg.Add(1)
		go func(owner string) {
			defer wg.Done()
			<-start
			item, found, err := control.ClaimExpiredControlTaskRecovery(ctx, owner, "0.144.1")
			results <- recoveryResult{item: item, found: found, err: err}
		}(fmt.Sprintf("owner_after_restart_%d_%s", index, suffix))
	}
	close(start)
	wg.Wait()
	close(results)
	winners := []ControlTaskRecoveryItem{}
	for result := range results {
		if result.err != nil && !errors.Is(result.err, ErrConflict) {
			t.Fatalf("recovery err=%v", result.err)
		}
		if result.found {
			winners = append(winners, result.item)
		}
	}
	if len(winners) != 1 || winners[0].CandidateRevision == nil ||
		*winners[0].CandidateRevision != revision || winners[0].Work.LeaseEpoch != oldWork.LeaseEpoch+1 {
		t.Fatalf("winners=%#v", winners)
	}
	recovered := winners[0]
	if _, _, err := control.ReconcileTerminalControlTaskCredential(ctx, oldWork); !errors.Is(err, ErrExecutorFenced) {
		t.Fatalf("old epoch terminal cleanup crossed new running epoch: %v", err)
	}
	var outboxBefore int
	if err := control.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_ai_executor_task_outbox WHERE task_id=$1`, seed.taskID).Scan(&outboxBefore); err != nil {
		t.Fatal(err)
	}
	if err := control.RenewControlTaskLease(ctx, oldWork); !errors.Is(err, ErrExecutorFenced) {
		t.Fatalf("old renew err=%v", err)
	}
	if err := control.StartControlTask(ctx, oldWork); !errors.Is(err, ErrExecutorFenced) {
		t.Fatalf("old start err=%v", err)
	}
	if _, err := control.PrepareControlTaskCredentialRotation(ctx, oldWork, testTaskDigest("stale-promotion:"+suffix)); !errors.Is(err, ErrExecutorFenced) {
		t.Fatalf("old prepare promotion err=%v", err)
	}
	if err := control.MarkControlTaskCredentialCommitting(ctx, oldWork, revision, candidateDigest); !errors.Is(err, ErrExecutorFenced) {
		t.Fatalf("old committing err=%v", err)
	}
	if err := control.CompleteControlTask(ctx, CompleteControlTaskInput{
		Work: oldWork, Models: []ModelCatalogEntry{}, CodexVersion: "0.144.1",
		PromotedCredentialRevision: &revision, PromotedBindingDigest: candidateDigest,
	}); !errors.Is(err, ErrExecutorFenced) {
		t.Fatalf("old completion err=%v", err)
	}
	var outboxAfter int
	if err := control.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_ai_executor_task_outbox WHERE task_id=$1`, seed.taskID).Scan(&outboxAfter); err != nil {
		t.Fatal(err)
	}
	if outboxAfter != outboxBefore {
		t.Fatalf("stale epoch emitted outbox before=%d after=%d", outboxBefore, outboxAfter)
	}
	if err := control.MarkControlTaskCredentialCommitting(ctx, recovered.Work, revision, candidateDigest); err != nil {
		t.Fatal(err)
	}
	if err := control.CompleteControlTask(ctx, CompleteControlTaskInput{
		Work: recovered.Work,
		Models: []ModelCatalogEntry{{
			CatalogItemID: "catalog_recovered_" + suffix, ModelKey: "gpt-5.6", DisplayName: "GPT-5.6",
			InputModalitiesJSON: []byte(`["image","text"]`), SupportedReasoningJSON: []byte(`[]`),
		}},
		CodexVersion: "0.144.1", PromotedCredentialRevision: &revision,
		PromotedBindingDigest: candidateDigest,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestControlTaskWorkerCancelReconcilesExactCredentialCandidateAgainstPostgres(t *testing.T) {
	control, ctx := openControlWorkerTestStore(t)
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	seed := seedControlWorkerTask(t, ctx, control, suffix, "readiness_check")
	work, found, err := control.ClaimControlTask(ctx, "owner_cancel_"+suffix, "0.144.1")
	if err != nil || !found {
		t.Fatalf("claim found=%v err=%v", found, err)
	}
	if err := control.StartControlTask(ctx, work); err != nil {
		t.Fatal(err)
	}
	candidateDigest := testTaskDigest("cancel-candidate:" + suffix)
	revision, err := control.PrepareControlTaskCredentialRotation(ctx, work, candidateDigest)
	if err != nil {
		t.Fatal(err)
	}
	var taskRevision int64
	if err := control.db.QueryRowContext(ctx, `SELECT revision FROM ky_ai_executor_task WHERE id=$1`, seed.taskID).Scan(&taskRevision); err != nil {
		t.Fatal(err)
	}
	_, transitioned, err := control.CancelPublicTask(ctx, CancelPublicTaskInput{
		TaskID: seed.taskID, ActorID: "user_platform_owner",
		WorkspaceType: "platform", WorkspaceID: "platform_root",
		ExpectedRevision:   taskRevision,
		IdempotencyKeyHash: testTaskDigest("cancel-key:" + suffix),
		RequestHash:        testTaskDigest("cancel-request:" + suffix),
	})
	if err != nil || !transitioned {
		t.Fatalf("cancel transitioned=%v err=%v", transitioned, err)
	}
	item, terminal, err := control.ReconcileTerminalControlTaskCredential(ctx, work)
	if err != nil || !terminal || len(item.CleanupRevisions) != 1 || item.CleanupRevisions[0] != revision {
		t.Fatalf("cleanup item=%#v terminal=%v err=%v", item, terminal, err)
	}
	var bindingStatus, taskStatus string
	if err := control.db.QueryRowContext(ctx, `
		SELECT binding.status,task.status
		FROM ky_ai_executor_credential_binding binding
		JOIN ky_ai_executor_task task ON task.id=$1
		WHERE binding.executor_id=$2 AND binding.revision=$3
	`, seed.taskID, seed.executorID, revision).Scan(&bindingStatus, &taskStatus); err != nil {
		t.Fatal(err)
	}
	if bindingStatus != "quarantined" || taskStatus != "cancelled" {
		t.Fatalf("binding=%s task=%s", bindingStatus, taskStatus)
	}
}

type controlWorkerSeed struct {
	executorID string
	taskID     string
}

func openControlWorkerTestStore(t *testing.T) (*ControlStore, context.Context) {
	t.Helper()
	databaseURL := os.Getenv("KY_AGENT_EXECUTOR_CONTROL_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set KY_AGENT_EXECUTOR_CONTROL_TEST_DATABASE_URL for PostgreSQL integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	control, err := OpenControl(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = control.Close() })
	cleanupControlWorkerTestRows(t, ctx, control)
	return control, ctx
}

func cleanupControlWorkerTestRows(t *testing.T, ctx context.Context, control *ControlStore) {
	t.Helper()
	if _, err := control.db.ExecContext(ctx, `
		UPDATE ky_ai_executor_credential_binding binding SET status='quarantined'
		FROM ky_ai_executor_task task
		WHERE task.operation_id=binding.operation_id
		  AND task.task_type IN ('credential_verify','model_catalog_refresh','readiness_check')
		  AND task.status IN ('pending','waiting_executor','running')
		  AND binding.status IN ('prepared','committing')
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := control.db.ExecContext(ctx, `
		UPDATE ky_ai_executor_operation_lease SET status='fenced',updated_at=now()
		WHERE status='active'
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := control.db.ExecContext(ctx, `
		UPDATE ky_ai_executor_task SET status='cancelled',completed_at=now(),updated_at=now()
		WHERE task_type IN ('credential_verify','model_catalog_refresh','readiness_check')
		  AND status IN ('pending','waiting_executor','running')
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := control.db.ExecContext(ctx, `
		UPDATE ky_ai_executor_task_request_registry registry
		SET materialized_status='cancelled',finalized_at=now()
		FROM ky_ai_executor_task task
		WHERE registry.task_id=task.id AND task.status='cancelled'
		  AND registry.materialized_status IN ('pending','waiting_executor','running')
	`); err != nil {
		t.Fatal(err)
	}
}

func seedControlWorkerTask(t *testing.T, ctx context.Context, control *ControlStore, suffix, taskType string) controlWorkerSeed {
	t.Helper()
	executorID := "aiexec_worker_" + suffix
	taskID := "task_worker_" + suffix
	runtimeBindingID := "server_worker_" + suffix
	fingerprint := testTaskDigest("fingerprint:" + suffix)
	bindingDigest := testTaskDigest("binding:" + suffix)
	operationID := "operation_worker_" + suffix
	requestHash := testTaskDigest("request:" + suffix)
	if _, err := control.db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_config (
		  id,name,scope_type,scope_id,executor_type,runtime_type,status,is_default,
		  max_concurrency,allow_script_save,config_revision,credential_status,
		  current_credential_revision,credential_revision_counter,catalog_revision,
		  runtime_binding_id,runtime_binding_revision,revocation_epoch,default_model_key,
		  task_timeout_seconds
		) VALUES ($1,'Worker integration','platform','platform_root','codex','server','enabled',
		  false,1,false,7,'authorized',1,1,2,$2,1,4,'gpt-5.6',60)
	`, executorID, runtimeBindingID); err != nil {
		t.Fatal(err)
	}
	if _, err := control.db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_credential_binding (
		  executor_id,revision,status,runtime_type,runtime_binding_id,
		  runtime_binding_revision,account_fingerprint,auth_mode,plan_type,
		  binding_digest,revocation_epoch,verified_at,activated_at,
		  operation_id,lease_epoch,source_credential_revision,digest_algorithm
		) VALUES ($1,1,'active','server',$2,1,$3,'device_code','plus',$4,4,now(),now(),
		  $5,1,0,'aicrm-credential-tree-rfc8785-nfc-v1')
	`, executorID, runtimeBindingID, fingerprint, bindingDigest, "auth_seed_"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err := control.db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_task (
		  id,workspace_type,workspace_id,executor_id,executor_type,task_type,status,
		  effective_executor_id,executor_config_revision,credential_binding_revision,
		  runtime_binding_id,runtime_binding_revision,model_catalog_revision,
		  operation_id,source_credential_revision,revocation_epoch,revision,
		  current_sequence,request_hash
		) VALUES ($1,'platform','platform_root',$2,'codex',$3,'pending',$2,7,1,$4,1,2,
		  $5,1,4,1,0,$6)
	`, taskID, executorID, taskType, runtimeBindingID, operationID, requestHash); err != nil {
		t.Fatal(err)
	}
	if _, err := control.db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_task_request_registry
		(task_id,request_hash,materialized_status,materialized_at)
		VALUES ($1,$2,'pending',now())
	`, taskID, requestHash); err != nil {
		t.Fatal(err)
	}
	return controlWorkerSeed{executorID: executorID, taskID: taskID}
}
