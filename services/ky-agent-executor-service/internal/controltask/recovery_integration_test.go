package controltask

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/credentialfs"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func TestControlTaskRecoveryFilesystemMatrixAgainstPostgres(t *testing.T) {
	for _, test := range []struct {
		name          string
		bindingStatus string
		layout        string
		expectStatus  string
	}{
		{name: "prepared_operation", bindingStatus: "prepared", layout: "operation", expectStatus: "completed"},
		{name: "prepared_revision", bindingStatus: "prepared", layout: "revision", expectStatus: "failed"},
		{name: "prepared_both", bindingStatus: "prepared", layout: "both", expectStatus: "failed"},
		{name: "prepared_neither", bindingStatus: "prepared", layout: "neither", expectStatus: "failed"},
		{name: "committing_operation", bindingStatus: "committing", layout: "operation", expectStatus: "completed"},
		{name: "committing_revision", bindingStatus: "committing", layout: "revision", expectStatus: "completed"},
		{name: "committing_both_is_ambiguous", bindingStatus: "committing", layout: "both", expectStatus: "failed"},
		{name: "committing_neither", bindingStatus: "committing", layout: "neither", expectStatus: "failed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			control, db, ctx := openControlTaskRecoveryDatabase(t)
			root := filepath.Join(t.TempDir(), "executors")
			t.Cleanup(func() { makeRecoveryTreeRemovable(root) })
			credentials, _ := credentialfs.New(root)
			suffix := fmt.Sprintf("%d_%s", time.Now().UnixNano(), test.name)
			executorID := "aiexec_recovery_pg_" + suffix
			taskID := "task_recovery_pg_" + suffix
			operationID := "operation_recovery_pg_" + suffix
			runtimeBindingID := "server_recovery_pg_" + suffix
			email := "owner@example.com"
			fingerprint := digestString("chatgpt\n" + email)

			staging, err := credentials.CreateStaging(executorID, "auth_seed")
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(staging, "auth.json"), []byte("original"), 0o600); err != nil {
				t.Fatal(err)
			}
			sourceDigest, _ := credentialfs.DigestTree(staging)
			if _, err := credentials.Promote(executorID, "auth_seed", 1, sourceDigest); err != nil {
				t.Fatal(err)
			}
			requestHash := recoveryTestDigest("request:" + suffix)
			if _, err := db.ExecContext(ctx, `
				INSERT INTO ky_ai_executor_config (
				  id,name,scope_type,scope_id,executor_type,runtime_type,status,is_default,
				  max_concurrency,allow_script_save,config_revision,credential_status,
				  current_credential_revision,credential_revision_counter,catalog_revision,
				  runtime_binding_id,runtime_binding_revision,revocation_epoch,default_model_key,
				  task_timeout_seconds
				) VALUES ($1,'Recovery integration','platform','platform_root','codex','server','enabled',
				  false,1,false,7,'authorized',1,1,2,$2,1,4,'gpt-5.6',60)
			`, executorID, runtimeBindingID); err != nil {
				t.Fatal(err)
			}
			if _, err := db.ExecContext(ctx, `
				INSERT INTO ky_ai_executor_credential_binding (
				  executor_id,revision,status,runtime_type,runtime_binding_id,
				  runtime_binding_revision,account_fingerprint,auth_mode,plan_type,
				  binding_digest,revocation_epoch,verified_at,activated_at,
				  operation_id,lease_epoch,source_credential_revision,digest_algorithm
				) VALUES ($1,1,'active','server',$2,1,$3,'device_code','plus',$4,4,now(),now(),
				  $5,1,0,'aicrm-credential-tree-rfc8785-nfc-v1')
			`, executorID, runtimeBindingID, fingerprint, sourceDigest, "auth_seed_"+suffix); err != nil {
				t.Fatal(err)
			}
			if _, err := db.ExecContext(ctx, `
				INSERT INTO ky_ai_executor_task (
				  id,workspace_type,workspace_id,executor_id,executor_type,task_type,status,
				  effective_executor_id,executor_config_revision,credential_binding_revision,
				  runtime_binding_id,runtime_binding_revision,model_catalog_revision,
				  operation_id,source_credential_revision,revocation_epoch,revision,
				  current_sequence,request_hash
				) VALUES ($1,'platform','platform_root',$2,'codex','model_catalog_refresh','pending',
				  $2,7,1,$3,1,2,$4,1,4,1,0,$5)
			`, taskID, executorID, runtimeBindingID, operationID, requestHash); err != nil {
				t.Fatal(err)
			}
			if _, err := db.ExecContext(ctx, `
				INSERT INTO ky_ai_executor_task_request_registry
				(task_id,request_hash,materialized_status,materialized_at)
				VALUES ($1,$2,'pending',now())
			`, taskID, requestHash); err != nil {
				t.Fatal(err)
			}
			work, found, err := control.ClaimControlTask(ctx, "owner_before_restart_"+suffix, "0.144.1")
			if err != nil || !found || work.TaskID != taskID {
				t.Fatalf("claim work=%#v found=%v err=%v", work, found, err)
			}
			if err := control.StartControlTask(ctx, work); err != nil {
				t.Fatal(err)
			}
			operationPath, err := credentials.CloneRevision(executorID, 1, operationID)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(operationPath, "auth.json"), []byte("rotated"), 0o600); err != nil {
				t.Fatal(err)
			}
			candidateDigest, _ := credentialfs.DigestTree(operationPath)
			revision, err := control.PrepareControlTaskCredentialRotation(ctx, work, candidateDigest)
			if err != nil {
				t.Fatal(err)
			}
			if test.bindingStatus == "committing" {
				if err := control.MarkControlTaskCredentialCommitting(ctx, work, revision, candidateDigest); err != nil {
					t.Fatal(err)
				}
			}
			if test.layout == "revision" || test.layout == "both" {
				if _, err := credentials.PromoteOperation(executorID, operationID, revision, candidateDigest); err != nil {
					t.Fatal(err)
				}
			}
			if test.layout == "both" {
				if _, err := credentials.CloneRevision(executorID, 1, operationID); err != nil {
					t.Fatal(err)
				}
			}
			if test.layout == "neither" {
				if err := credentials.RemoveEphemeral(operationPath); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := db.ExecContext(ctx, `
				UPDATE ky_ai_executor_operation_lease
				SET lease_expires_at=now()-interval '1 second'
				WHERE executor_id=$1 AND lease_epoch=$2
			`, executorID, work.LeaseEpoch); err != nil {
				t.Fatal(err)
			}
			manager, err := New(control, &scriptedLauncher{email: email}, credentials, Config{
				OwnerInstanceID: "owner_after_restart_" + suffix,
				CodexVersion:    "0.144.1",
				ReportError:     func(error) {},
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := manager.Recover(ctx); err != nil {
				t.Fatal(err)
			}
			var taskStatus, bindingStatus, sourceBindingStatus string
			var currentCredential, outboxCount int64
			if err := db.QueryRowContext(ctx, `
				SELECT task.status,binding.status,source_binding.status,
				       config.current_credential_revision,
				       (SELECT count(*) FROM ky_ai_executor_task_outbox WHERE task_id=task.id)
				FROM ky_ai_executor_task task
				JOIN ky_ai_executor_credential_binding binding
				  ON binding.executor_id=$1 AND binding.revision=$2
				JOIN ky_ai_executor_credential_binding source_binding
				  ON source_binding.executor_id=$1 AND source_binding.revision=1
				JOIN ky_ai_executor_config config ON config.id=$1
				WHERE task.id=$3
			`, executorID, revision, taskID).Scan(
				&taskStatus, &bindingStatus, &sourceBindingStatus, &currentCredential, &outboxCount,
			); err != nil {
				t.Fatal(err)
			}
			if taskStatus != test.expectStatus {
				t.Fatalf("task status=%s", taskStatus)
			}
			if outboxCount != 6 {
				t.Fatalf("outbox count=%d", outboxCount)
			}
			if test.expectStatus == "completed" {
				if bindingStatus != "active" || sourceBindingStatus != "revoked" || currentCredential != revision {
					t.Fatalf("binding=%s source=%s current=%d", bindingStatus, sourceBindingStatus, currentCredential)
				}
				revisionPath, _ := credentials.RevisionPath(executorID, revision)
				if err := credentialfs.ValidateReadOnlyTree(revisionPath); err != nil {
					t.Fatalf("revision is not immutable: %v", err)
				}
			} else {
				if bindingStatus != "quarantined" || sourceBindingStatus != "active" || currentCredential != 1 {
					t.Fatalf("binding=%s source=%s current=%d", bindingStatus, sourceBindingStatus, currentCredential)
				}
				revisionPath, _ := credentials.RevisionPath(executorID, revision)
				operationPath, _ := credentials.OperationPath(executorID, operationID)
				if _, err := os.Stat(revisionPath); !os.IsNotExist(err) {
					t.Fatalf("ambiguous revision survived: %v", err)
				}
				if _, err := os.Stat(operationPath); !os.IsNotExist(err) {
					t.Fatalf("ambiguous operation survived: %v", err)
				}
			}
		})
	}
}

func TestControlTaskRecoveryNoCandidateAgainstPostgres(t *testing.T) {
	for _, targetStatus := range []string{"waiting_executor", "running"} {
		t.Run(targetStatus, func(t *testing.T) {
			control, db, ctx := openControlTaskRecoveryDatabase(t)
			root := filepath.Join(t.TempDir(), "executors")
			t.Cleanup(func() { makeRecoveryTreeRemovable(root) })
			credentials, _ := credentialfs.New(root)
			suffix := fmt.Sprintf("%d_%s", time.Now().UnixNano(), targetStatus)
			executorID := "aiexec_no_candidate_" + suffix
			taskID := "task_no_candidate_" + suffix
			operationID := "operation_no_candidate_" + suffix
			runtimeBindingID := "server_no_candidate_" + suffix
			staging, _ := credentials.CreateStaging(executorID, "auth_seed")
			_ = os.WriteFile(filepath.Join(staging, "auth.json"), []byte("original"), 0o600)
			sourceDigest, _ := credentialfs.DigestTree(staging)
			if _, err := credentials.Promote(executorID, "auth_seed", 1, sourceDigest); err != nil {
				t.Fatal(err)
			}
			requestHash := recoveryTestDigest("request:" + suffix)
			fingerprint := digestString("chatgpt\nowner@example.com")
			if _, err := db.ExecContext(ctx, `
				INSERT INTO ky_ai_executor_config (
				  id,name,scope_type,scope_id,executor_type,runtime_type,status,is_default,
				  max_concurrency,allow_script_save,config_revision,credential_status,
				  current_credential_revision,credential_revision_counter,catalog_revision,
				  runtime_binding_id,runtime_binding_revision,revocation_epoch,default_model_key,
				  task_timeout_seconds
				) VALUES ($1,'No candidate integration','platform','platform_root','codex','server','enabled',
				  false,1,false,7,'authorized',1,1,2,$2,1,4,'gpt-5.6',60)
			`, executorID, runtimeBindingID); err != nil {
				t.Fatal(err)
			}
			if _, err := db.ExecContext(ctx, `
				INSERT INTO ky_ai_executor_credential_binding (
				  executor_id,revision,status,runtime_type,runtime_binding_id,
				  runtime_binding_revision,account_fingerprint,auth_mode,plan_type,
				  binding_digest,revocation_epoch,verified_at,activated_at,
				  operation_id,lease_epoch,source_credential_revision,digest_algorithm
				) VALUES ($1,1,'active','server',$2,1,$3,'device_code','plus',$4,4,now(),now(),
				  $5,1,0,'aicrm-credential-tree-rfc8785-nfc-v1')
			`, executorID, runtimeBindingID, fingerprint, sourceDigest, "auth_seed_"+suffix); err != nil {
				t.Fatal(err)
			}
			if _, err := db.ExecContext(ctx, `
				INSERT INTO ky_ai_executor_task (
				  id,workspace_type,workspace_id,executor_id,executor_type,task_type,status,
				  effective_executor_id,executor_config_revision,credential_binding_revision,
				  runtime_binding_id,runtime_binding_revision,model_catalog_revision,
				  operation_id,source_credential_revision,revocation_epoch,revision,
				  current_sequence,request_hash
				) VALUES ($1,'platform','platform_root',$2,'codex','readiness_check','pending',
				  $2,7,1,$3,1,2,$4,1,4,1,0,$5)
			`, taskID, executorID, runtimeBindingID, operationID, requestHash); err != nil {
				t.Fatal(err)
			}
			if _, err := db.ExecContext(ctx, `
				INSERT INTO ky_ai_executor_task_request_registry
				(task_id,request_hash,materialized_status,materialized_at)
				VALUES ($1,$2,'pending',now())
			`, taskID, requestHash); err != nil {
				t.Fatal(err)
			}
			work, found, err := control.ClaimControlTask(ctx, "owner_before_restart_"+suffix, "0.144.1")
			if err != nil || !found || work.TaskID != taskID {
				t.Fatalf("claim work=%#v found=%v err=%v", work, found, err)
			}
			if targetStatus == "running" {
				if err := control.StartControlTask(ctx, work); err != nil {
					t.Fatal(err)
				}
			}
			operationPath, err := credentials.CloneRevision(executorID, 1, operationID)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := db.ExecContext(ctx, `
				UPDATE ky_ai_executor_operation_lease SET lease_expires_at=now()-interval '1 second'
				WHERE executor_id=$1 AND lease_epoch=$2
			`, executorID, work.LeaseEpoch); err != nil {
				t.Fatal(err)
			}
			manager, _ := New(control, &scriptedLauncher{email: "owner@example.com"}, credentials, Config{
				OwnerInstanceID: "owner_after_restart_" + suffix,
				CodexVersion:    "0.144.1",
				ReportError:     func(error) {},
			})
			if err := manager.Recover(ctx); err != nil {
				t.Fatal(err)
			}
			var taskStatus, failureCode, leaseStatus, sourceStatus string
			var currentCredential, outboxCount int64
			if err := db.QueryRowContext(ctx, `
				SELECT task.status,task.failure_code,lease.status,binding.status,
				       config.current_credential_revision,
				       (SELECT count(*) FROM ky_ai_executor_task_outbox WHERE task_id=task.id)
				FROM ky_ai_executor_task task
				JOIN ky_ai_executor_operation_lease lease ON lease.executor_id=$1
				JOIN ky_ai_executor_credential_binding binding
				  ON binding.executor_id=$1 AND binding.revision=1
				JOIN ky_ai_executor_config config ON config.id=$1
				WHERE task.id=$2
			`, executorID, taskID).Scan(
				&taskStatus, &failureCode, &leaseStatus, &sourceStatus,
				&currentCredential, &outboxCount,
			); err != nil {
				t.Fatal(err)
			}
			expectedOutbox := int64(4)
			if targetStatus == "running" {
				expectedOutbox = 5
			}
			if taskStatus != "failed" || failureCode != "executor_app_server_unavailable" ||
				leaseStatus != "expired" || sourceStatus != "active" || currentCredential != 1 ||
				outboxCount != expectedOutbox {
				t.Fatalf("task=%s failure=%s lease=%s source=%s current=%d outbox=%d",
					taskStatus, failureCode, leaseStatus, sourceStatus, currentCredential, outboxCount)
			}
			if _, err := os.Stat(operationPath); !os.IsNotExist(err) {
				t.Fatalf("orphan operation path survived: %v", err)
			}
			quarantinePath, _ := credentials.QuarantinePath(executorID,
				"control_recovery_operation_"+digestString(taskID)[:16])
			if _, err := os.Stat(quarantinePath); err != nil {
				t.Fatalf("orphan operation was not quarantined: %v", err)
			}
		})
	}
}

func openControlTaskRecoveryDatabase(t *testing.T) (*store.ControlStore, *sql.DB, context.Context) {
	t.Helper()
	databaseURL := os.Getenv("KY_AGENT_EXECUTOR_CONTROL_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set KY_AGENT_EXECUTOR_CONTROL_TEST_DATABASE_URL for PostgreSQL integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	t.Cleanup(cancel)
	control, err := store.OpenControl(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = control.Close() })
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	db := stdlib.OpenDB(*config)
	if err := db.PingContext(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	cleanupControlTaskRecoveryRows(t, ctx, db)
	return control, db, ctx
}

func cleanupControlTaskRecoveryRows(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_credential_binding binding SET status='quarantined'
		FROM ky_ai_executor_task task
		WHERE task.operation_id=binding.operation_id
		  AND task.task_type IN ('credential_verify','model_catalog_refresh','readiness_check')
		  AND task.status IN ('pending','waiting_executor','running')
		  AND binding.status IN ('prepared','committing')
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE ky_ai_executor_operation_lease SET status='fenced' WHERE status='active'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_task SET status='cancelled',completed_at=now(),updated_at=now()
		WHERE task_type IN ('credential_verify','model_catalog_refresh','readiness_check')
		  AND status IN ('pending','waiting_executor','running')
	`); err != nil {
		t.Fatal(err)
	}
}

func makeRecoveryTreeRemovable(root string) {
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			_ = os.Chmod(path, 0o700)
		} else {
			_ = os.Chmod(path, 0o600)
		}
		return nil
	})
}

func recoveryTestDigest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
