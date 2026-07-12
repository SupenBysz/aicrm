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
}
