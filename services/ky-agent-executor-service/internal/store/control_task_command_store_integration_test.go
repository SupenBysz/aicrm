package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestControlTaskCommandsAgainstPostgres(t *testing.T) {
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

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	executorID := "aiexec_command_" + suffix
	fingerprint := testTaskDigest("fingerprint:" + suffix)
	bindingDigest := testTaskDigest("binding:" + suffix)
	if _, err := control.db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_config (
		  id,name,scope_type,scope_id,executor_type,runtime_type,status,is_default,
		  max_concurrency,allow_script_save,config_revision,credential_status,
		  current_credential_revision,credential_revision_counter,catalog_revision,
		  runtime_binding_id,runtime_binding_revision,revocation_epoch,default_model_key
		) VALUES ($1,'Command integration','platform','platform_root','codex','server','enabled',
		  false,1,false,7,'authorized',2,2,3,$2,1,4,'gpt-5.6')
	`, executorID, "server_command_"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err := control.db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_credential_binding (
		  executor_id,revision,status,runtime_type,runtime_binding_id,
		  runtime_binding_revision,account_fingerprint,auth_mode,plan_type,
		  binding_digest,revocation_epoch,verified_at,activated_at,
		  operation_id,lease_epoch,source_credential_revision,digest_algorithm
		) VALUES ($1,2,'active','server',$2,1,$3,'device_code','plus',$4,4,now(),now(),
		  $5,1,0,'aicrm-credential-tree-rfc8785-nfc-v1')
	`, executorID, "server_command_"+suffix, fingerprint, bindingDigest, "auth_seed_"+suffix); err != nil {
		t.Fatal(err)
	}
	credentialRevision, catalogRevision := int64(2), int64(3)
	input := CreateControlTaskInput{
		ID: "task_command_" + suffix, ExecutorID: executorID, TaskType: "readiness_check",
		ActorID: "user_platform_owner", WorkspaceType: "platform", WorkspaceID: "platform_root",
		ExpectedExecutorRevision: 7, ExpectedCredentialRevision: &credentialRevision,
		ExpectedCatalogRevision: &catalogRevision,
		IdempotencyKeyHash:      testTaskDigest("command-key:" + suffix),
		RequestHash:             testTaskDigest("command-request:" + suffix),
	}
	created, err := control.CreateControlTask(ctx, input)
	if err != nil || !created.Created || created.Task.ID != input.ID || created.Task.Status != "pending" ||
		created.Task.TaskType != input.TaskType || created.Task.Revision != 1 || created.Task.CurrentSequence != 1 {
		t.Fatalf("created=%#v err=%v", created, err)
	}
	var configRevision, frozenCredential, frozenCatalog, sourceRevision, revocationEpoch int64
	var operationID, status string
	if err := control.db.QueryRowContext(ctx, `
		SELECT status,executor_config_revision,credential_binding_revision,
		       model_catalog_revision,operation_id,source_credential_revision,revocation_epoch
		FROM ky_ai_executor_task WHERE id=$1
	`, input.ID).Scan(&status, &configRevision, &frozenCredential, &frozenCatalog,
		&operationID, &sourceRevision, &revocationEpoch); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || configRevision != 7 || frozenCredential != 2 || frozenCatalog != 3 ||
		operationID == "" || sourceRevision != 2 || revocationEpoch != 4 {
		t.Fatalf("frozen status=%s config=%d credential=%d catalog=%d operation=%s source=%d epoch=%d",
			status, configRevision, frozenCredential, frozenCatalog, operationID, sourceRevision, revocationEpoch)
	}
	events, err := control.ListPublicTaskEvents(ctx, input.ID, "platform", "platform_root", 0, 10)
	if err != nil || len(events) != 1 || events[0].EventType != TaskEventChanged {
		t.Fatalf("events=%#v err=%v", events, err)
	}
	var outboxCount, registryCount int
	if err := control.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_ai_executor_task_outbox WHERE task_id=$1`, input.ID).Scan(&outboxCount); err != nil {
		t.Fatal(err)
	}
	if err := control.db.QueryRowContext(ctx, `SELECT count(*) FROM ky_ai_executor_task_request_registry WHERE task_id=$1 AND materialized_status='pending'`, input.ID).Scan(&registryCount); err != nil {
		t.Fatal(err)
	}
	if outboxCount != 1 || registryCount != 1 {
		t.Fatalf("outbox=%d registry=%d", outboxCount, registryCount)
	}
	replayed, err := control.CreateControlTask(ctx, input)
	if err != nil || replayed.Created || replayed.Task.ID != input.ID {
		t.Fatalf("replayed=%#v err=%v", replayed, err)
	}
	changed := input
	changed.RequestHash = testTaskDigest("changed-command:" + suffix)
	if _, err := control.CreateControlTask(ctx, changed); !errors.Is(err, ErrIdempotencyReuse) {
		t.Fatalf("changed request err=%v", err)
	}
	deduplicated := input
	deduplicated.ID = "task_command_duplicate_" + suffix
	deduplicated.IdempotencyKeyHash = testTaskDigest("other-key:" + suffix)
	dedupResult, err := control.CreateControlTask(ctx, deduplicated)
	if err != nil || dedupResult.Created || dedupResult.Task.ID != input.ID {
		t.Fatalf("deduplicated=%#v err=%v", dedupResult, err)
	}
	stale := input
	stale.ID = "task_command_stale_" + suffix
	stale.IdempotencyKeyHash = testTaskDigest("stale-key:" + suffix)
	stale.ExpectedExecutorRevision = 6
	if _, err := control.CreateControlTask(ctx, stale); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale revision err=%v", err)
	}
}
