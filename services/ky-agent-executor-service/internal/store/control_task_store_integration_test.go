package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestPublicTaskCancelPersistsTerminalStreamsAgainstPostgres(t *testing.T) {
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
	executorID, taskID := "aiexec_task_"+suffix, "task_control_"+suffix
	requestHash := testTaskDigest("request:" + suffix)
	if _, err := control.db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_config (
		  id,name,scope_type,scope_id,executor_type,runtime_type,status,
		  is_default,max_concurrency,allow_script_save
		) VALUES ($1,'Task integration','platform','platform_root','codex','server','enabled',false,1,false)
	`, executorID); err != nil {
		t.Fatal(err)
	}
	if _, err := control.db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_task (
		  id,workspace_type,workspace_id,executor_id,executor_type,task_type,
		  status,effective_executor_id,executor_config_revision,
		  revision,current_sequence,request_hash
		) VALUES ($1,'platform','platform_root',$2,'codex','readiness_check',
		  'running',$2,1,4,0,$3)
	`, taskID, executorID, requestHash); err != nil {
		t.Fatal(err)
	}
	if _, err := control.db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_task_request_registry
		(task_id,request_hash,materialized_status,materialized_at)
		VALUES ($1,$2,'running',now())
	`, taskID, requestHash); err != nil {
		t.Fatal(err)
	}

	input := CancelPublicTaskInput{
		TaskID: taskID, ActorID: "user_platform_owner",
		WorkspaceType: "platform", WorkspaceID: "platform_root", ExpectedRevision: 4,
		IdempotencyKeyHash: testTaskDigest("key:" + suffix),
		RequestHash:        testTaskDigest("cancel:" + suffix),
	}
	cancelled, transitioned, err := control.CancelPublicTask(ctx, input)
	if err != nil || !transitioned || cancelled.Status != "cancelled" ||
		cancelled.Revision != 5 || cancelled.CurrentSequence != 3 {
		t.Fatalf("cancelled=%#v transitioned=%v err=%v", cancelled, transitioned, err)
	}
	events, err := control.ListPublicTaskEvents(ctx, taskID, "platform", "platform_root", 0, 10)
	if err != nil || len(events) != 3 || events[1].EventType != TaskEventTerminal || events[2].EventType != TaskEventClosed {
		t.Fatalf("events=%#v err=%v", events, err)
	}
	terminal, err := control.ListPublicTaskTerminal(ctx, taskID, "platform", "platform_root", 0, 10)
	if err != nil || len(terminal) != 3 || terminal[0].Kind != "frame" ||
		terminal[1].Kind != "terminal" || terminal[1].Status != "cancelled" || terminal[2].Kind != "closed" {
		t.Fatalf("terminal=%#v err=%v", terminal, err)
	}
	closedSequence, err := control.PublicTaskTerminalClosedSequence(ctx, taskID, "platform", "platform_root")
	if err != nil || closedSequence != terminal[2].Sequence {
		t.Fatalf("closedSequence=%d err=%v terminal=%#v", closedSequence, err, terminal)
	}
	replayed, transitioned, err := control.CancelPublicTask(ctx, input)
	if err != nil || transitioned || replayed.Status != "cancelled" || replayed.Revision != cancelled.Revision {
		t.Fatalf("replayed=%#v transitioned=%v err=%v", replayed, transitioned, err)
	}
	changed := input
	changed.RequestHash = testTaskDigest("changed:" + suffix)
	if _, _, err := control.CancelPublicTask(ctx, changed); !errors.Is(err, ErrIdempotencyReuse) {
		t.Fatalf("changed idempotency request err=%v", err)
	}
	if _, err := control.GetPublicTask(ctx, taskID, "agency", "agency_1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-workspace task read err=%v", err)
	}
}

func testTaskDigest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
