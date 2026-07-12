package store_test

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/operationconfirmation"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
	_ "github.com/jackc/pgx/v5/stdlib"
)

func TestOperationConfirmationAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("KY_AGENT_EXECUTOR_CONFIRMATION_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set KY_AGENT_EXECUTOR_CONFIRMATION_TEST_DATABASE_URL for PostgreSQL integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
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

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	executorID := "aiexec_confirmation_" + suffix
	fromDeviceID, fromPublicKey := confirmationDevice(31)
	targetDeviceID, targetPublicKey := confirmationDevice(63)
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_config (
		 id,name,scope_type,scope_id,executor_type,runtime_type,status,is_default,
		 max_concurrency,credential_status,current_credential_revision,
		 credential_revision_counter,runtime_binding_id,runtime_binding_revision
		) VALUES ($1,'Confirmation integration','platform','platform_root','codex','desktop',
		 'enabled',false,1,'authorized',7,7,$2,1)
	`, executorID, "desktop_confirmation_"+suffix); err != nil {
		t.Fatal(err)
	}
	for _, device := range []struct{ id, publicKey, label string }{
		{fromDeviceID, fromPublicKey, "current"}, {targetDeviceID, targetPublicKey, "target"},
	} {
		if _, err := db.ExecContext(ctx, `
			INSERT INTO ky_ai_executor_device (
			 id,public_key,status,label,registered_by,workspace_type,workspace_id
			) VALUES ($1,$2,'active',$3,'owner_confirmation','platform','platform_root')
		`, device.id, device.publicKey, device.label); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_device_binding (executor_id,device_id,revision,status,bound_by)
		VALUES ($1,$2,3,'active','owner_confirmation')
	`, executorID, fromDeviceID); err != nil {
		t.Fatal(err)
	}

	manager := newConfirmationManager(t, control)
	loginAt := time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond)
	base := operationconfirmation.CreateInput{
		Action: store.OperationConfirmationRebindDevice, ExecutorID: executorID,
		ActorID: "owner_confirmation", ActorSessionID: "login_confirmation_" + suffix,
		ExpectedRevision: 3, TargetDeviceID: targetDeviceID, OwnerVerified: true,
		LoginAuthenticatedAt: loginAt, MFARequired: true, MFAVerified: true,
		IdempotencyKeyHash: confirmationDigest("create-key:" + suffix),
		RequestHash:        confirmationDigest("create-request:" + suffix),
	}
	created, err := manager.Create(ctx, base)
	if err != nil || !created.Created || created.ChallengeText == "" {
		t.Fatalf("created=%#v err=%v", created, err)
	}
	action, err := control.ResolveOperationConfirmationAction(
		ctx, created.ConfirmationID, base.ActorID, base.ActorSessionID,
	)
	if err != nil || action != store.OperationConfirmationRebindDevice {
		t.Fatalf("resolved action=%q err=%v", action, err)
	}
	for _, lookup := range []struct {
		name, confirmationID, actorID, actorSessionID string
	}{
		{"missing", "missing_confirmation", base.ActorID, base.ActorSessionID},
		{"wrong actor", created.ConfirmationID, "another_owner", base.ActorSessionID},
		{"wrong session", created.ConfirmationID, base.ActorID, "another_login"},
		{"malformed", "contains spaces", base.ActorID, base.ActorSessionID},
	} {
		t.Run("resolve "+lookup.name, func(t *testing.T) {
			resolved, resolveErr := control.ResolveOperationConfirmationAction(
				ctx, lookup.confirmationID, lookup.actorID, lookup.actorSessionID,
			)
			if resolved != "" || !errors.Is(resolveErr, store.ErrNotFound) {
				t.Fatalf("resolved=%q err=%v", resolved, resolveErr)
			}
		})
	}
	replayed, err := manager.Create(ctx, base)
	if err != nil || replayed.Created || replayed.ConfirmationID != created.ConfirmationID ||
		replayed.ChallengeText != created.ChallengeText || replayed.ExpiresAt != created.ExpiresAt {
		t.Fatalf("replayed=%#v err=%v", replayed, err)
	}
	changed := base
	changed.RequestHash = confirmationDigest("changed-body:" + suffix)
	if _, err := manager.Create(ctx, changed); !errors.Is(err, store.ErrIdempotencyReuse) {
		t.Fatalf("same key with different body was not rejected: %v", err)
	}
	invalidFacts := []struct {
		name   string
		change func(*operationconfirmation.CreateInput)
		want   error
	}{
		{"owner", func(value *operationconfirmation.CreateInput) { value.OwnerVerified = false }, store.ErrOperationConfirmationOwnerRequired},
		{"mfa", func(value *operationconfirmation.CreateInput) { value.MFAVerified = false }, store.ErrOperationConfirmationMFARequired},
		{"fresh login", func(value *operationconfirmation.CreateInput) {
			value.LoginAuthenticatedAt = time.Now().Add(-11 * time.Minute)
		}, store.ErrOperationConfirmationFreshLogin},
	}
	for index, testCase := range invalidFacts {
		t.Run(testCase.name, func(t *testing.T) {
			input := base
			input.IdempotencyKeyHash = confirmationDigest(fmt.Sprintf("invalid-%d:%s", index, suffix))
			input.RequestHash = confirmationDigest(fmt.Sprintf("invalid-request-%d:%s", index, suffix))
			testCase.change(&input)
			if _, err := manager.Create(ctx, input); !errors.Is(err, testCase.want) {
				t.Fatalf("got %v want %v", err, testCase.want)
			}
		})
	}

	confirmInput := operationconfirmation.ConfirmInput{
		ConfirmationID: created.ConfirmationID, ActorID: base.ActorID,
		ActorSessionID: base.ActorSessionID, ChallengeText: created.ChallengeText,
		OwnerVerified: true, LoginAuthenticatedAt: loginAt, MFARequired: true, MFAVerified: true,
	}
	const confirmWorkers = 16
	var confirmGroup sync.WaitGroup
	confirmTokens := make(chan string, confirmWorkers)
	confirmErrors := make(chan error, confirmWorkers)
	for index := 0; index < confirmWorkers; index++ {
		confirmGroup.Add(1)
		go func() {
			defer confirmGroup.Done()
			result, err := manager.Confirm(ctx, confirmInput)
			if err != nil {
				confirmErrors <- err
				return
			}
			confirmTokens <- result.ConfirmationToken
		}()
	}
	confirmGroup.Wait()
	close(confirmTokens)
	close(confirmErrors)
	tokens := []string{}
	for token := range confirmTokens {
		tokens = append(tokens, token)
	}
	errorCount := 0
	for confirmErr := range confirmErrors {
		t.Errorf("unexpected concurrent confirmation error: %v", confirmErr)
		errorCount++
	}
	if len(tokens) != confirmWorkers || errorCount != 0 {
		t.Fatalf("confirmed=%d errors=%d", len(tokens), errorCount)
	}
	token := tokens[0]
	for _, replayedToken := range tokens[1:] {
		if replayedToken != token {
			t.Fatal("concurrent exact confirm did not reconstruct the same token")
		}
	}
	var storedJSON, auditJSON string
	if err := db.QueryRowContext(ctx, `SELECT row_to_json(value)::text FROM ky_ai_executor_operation_confirmation value WHERE id=$1`, created.ConfirmationID).Scan(&storedJSON); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT json_agg(value)::text FROM ky_ai_executor_operation_confirmation_audit value WHERE confirmation_id=$1`, created.ConfirmationID).Scan(&auditJSON); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(storedJSON, created.ChallengeText) || strings.Contains(storedJSON, token) ||
		strings.Contains(auditJSON, created.ChallengeText) || strings.Contains(auditJSON, token) {
		t.Fatal("challenge or confirmation token plaintext reached PostgreSQL")
	}

	if err := control.Close(); err != nil {
		t.Fatal(err)
	}
	control, err = store.OpenControl(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()
	manager = newConfirmationManager(t, control)
	restartedReplay, err := manager.Confirm(ctx, confirmInput)
	if err != nil || restartedReplay.ConfirmationToken != token {
		t.Fatalf("restart exact confirm replay=%#v err=%v", restartedReplay, err)
	}
	var auditCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM ky_ai_executor_operation_confirmation_audit WHERE confirmation_id=$1`, created.ConfirmationID).Scan(&auditCount); err != nil || auditCount != 2 {
		t.Fatalf("restart replay duplicated audit count=%d err=%v", auditCount, err)
	}
	consume := operationconfirmation.ConsumeInput{
		ConfirmationToken: token, Action: base.Action, ActorID: base.ActorID,
		ActorSessionID: base.ActorSessionID, ExecutorID: executorID, ExpectedRevision: 3,
		FromDeviceID: fromDeviceID, TargetDeviceID: targetDeviceID,
		ConsumptionReference: "rebind_operation_" + suffix,
	}
	wrongTarget := consume
	wrongTarget.TargetDeviceID = strings.Repeat("c", 64)
	if _, err := manager.Consume(ctx, wrongTarget, func(context.Context, *sql.Tx, store.OperationConfirmationProjection) error { return nil }); !errors.Is(err, store.ErrOperationConfirmationTokenMismatch) {
		t.Fatalf("target mismatch was not rejected: %v", err)
	}
	rollbackError := errors.New("simulated business rollback")
	if _, err := manager.Consume(ctx, consume, func(ctx context.Context, tx *sql.Tx, _ store.OperationConfirmationProjection) error {
		if _, err := tx.ExecContext(ctx, `UPDATE ky_ai_executor_config SET name='must rollback' WHERE id=$1`, executorID); err != nil {
			return err
		}
		return rollbackError
	}); !errors.Is(err, rollbackError) {
		t.Fatalf("mutation rollback error=%v", err)
	}
	var status, executorName string
	if err := db.QueryRowContext(ctx, `
		SELECT confirmation.status,config.name,
		       (SELECT count(*) FROM ky_ai_executor_operation_confirmation_audit audit WHERE audit.confirmation_id=confirmation.id)
		FROM ky_ai_executor_operation_confirmation confirmation
		JOIN ky_ai_executor_config config ON config.id=confirmation.executor_id
		WHERE confirmation.id=$1
	`, created.ConfirmationID).Scan(&status, &executorName, &auditCount); err != nil {
		t.Fatal(err)
	}
	if status != "confirmed" || executorName == "must rollback" || auditCount != 2 {
		t.Fatalf("rollback leaked status=%s name=%s audits=%d", status, executorName, auditCount)
	}

	const consumeWorkers = 12
	var consumeGroup sync.WaitGroup
	var consumeSuccess, consumeUsed, mutationCalls atomic.Int64
	consumeErrors := make(chan error, consumeWorkers)
	for index := 0; index < consumeWorkers; index++ {
		consumeGroup.Add(1)
		go func() {
			defer consumeGroup.Done()
			_, err := manager.Consume(ctx, consume, func(ctx context.Context, tx *sql.Tx, _ store.OperationConfirmationProjection) error {
				mutationCalls.Add(1)
				_, err := tx.ExecContext(ctx, `UPDATE ky_ai_executor_config SET name='consumed atomically' WHERE id=$1`, executorID)
				return err
			})
			if err == nil {
				consumeSuccess.Add(1)
				return
			}
			if errors.Is(err, store.ErrOperationConfirmationTokenConsumed) {
				consumeUsed.Add(1)
				return
			}
			consumeErrors <- err
		}()
	}
	consumeGroup.Wait()
	close(consumeErrors)
	for consumeErr := range consumeErrors {
		t.Fatalf("unexpected consume error: %v", consumeErr)
	}
	if consumeSuccess.Load() != 1 || consumeUsed.Load() != consumeWorkers-1 || mutationCalls.Load() != 1 {
		t.Fatalf("success=%d used=%d mutations=%d", consumeSuccess.Load(), consumeUsed.Load(), mutationCalls.Load())
	}
	var outboxCount int
	if err := db.QueryRowContext(ctx, `
		SELECT confirmation.status,config.name,
		       (SELECT count(*) FROM ky_ai_executor_operation_confirmation_audit audit WHERE audit.confirmation_id=confirmation.id),
		       (SELECT count(*) FROM ky_ai_executor_control_outbox outbox WHERE outbox.aggregate_type='operation_confirmation' AND outbox.aggregate_id=confirmation.id)
		FROM ky_ai_executor_operation_confirmation confirmation
		JOIN ky_ai_executor_config config ON config.id=confirmation.executor_id
		WHERE confirmation.id=$1
	`, created.ConfirmationID).Scan(&status, &executorName, &auditCount, &outboxCount); err != nil {
		t.Fatal(err)
	}
	if status != "consumed" || executorName != "consumed atomically" || auditCount != 3 || outboxCount != 3 {
		t.Fatalf("status=%s name=%s audits=%d outbox=%d", status, executorName, auditCount, outboxCount)
	}
	action, err = control.ResolveOperationConfirmationAction(
		ctx, created.ConfirmationID, base.ActorID, base.ActorSessionID,
	)
	if err != nil || action != store.OperationConfirmationRebindDevice {
		t.Fatalf("consumed confirmation action=%q err=%v", action, err)
	}

	expiredCreate := base
	expiredCreate.IdempotencyKeyHash = confirmationDigest("expired-key:" + suffix)
	expiredCreate.RequestHash = confirmationDigest("expired-request:" + suffix)
	expired, err := manager.Create(ctx, expiredCreate)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_operation_confirmation
		SET created_at=transaction_timestamp()-interval '6 minutes',
		    expires_at=transaction_timestamp()-interval '1 minute'
		WHERE id=$1
	`, expired.ConfirmationID); err != nil {
		t.Fatal(err)
	}
	expiredConfirm := confirmInput
	expiredConfirm.ConfirmationID, expiredConfirm.ChallengeText = expired.ConfirmationID, expired.ChallengeText
	if _, err := manager.Confirm(ctx, expiredConfirm); !errors.Is(err, store.ErrOperationConfirmationChallengeExpired) {
		t.Fatalf("expired challenge err=%v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT status FROM ky_ai_executor_operation_confirmation WHERE id=$1`, expired.ConfirmationID).Scan(&status); err != nil || status != "expired" {
		t.Fatalf("expired status=%s err=%v", status, err)
	}

	tokenExpiredCreate := base
	tokenExpiredCreate.IdempotencyKeyHash = confirmationDigest("token-expired-key:" + suffix)
	tokenExpiredCreate.RequestHash = confirmationDigest("token-expired-request:" + suffix)
	tokenExpired, err := manager.Create(ctx, tokenExpiredCreate)
	if err != nil {
		t.Fatal(err)
	}
	tokenExpiredConfirm := confirmInput
	tokenExpiredConfirm.ConfirmationID, tokenExpiredConfirm.ChallengeText = tokenExpired.ConfirmationID, tokenExpired.ChallengeText
	tokenExpiredResult, err := manager.Confirm(ctx, tokenExpiredConfirm)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_operation_confirmation
		SET token_issued_at=transaction_timestamp()-interval '6 minutes',
		    confirmed_at=transaction_timestamp()-interval '6 minutes',
		    token_expires_at=transaction_timestamp()-interval '1 minute'
		WHERE id=$1
	`, tokenExpired.ConfirmationID); err != nil {
		t.Fatal(err)
	}
	tokenExpiredConsume := consume
	tokenExpiredConsume.ConfirmationToken = tokenExpiredResult.ConfirmationToken
	tokenExpiredConsume.ConsumptionReference = "expired_operation_" + suffix
	if _, err := manager.Consume(ctx, tokenExpiredConsume, func(context.Context, *sql.Tx, store.OperationConfirmationProjection) error { return nil }); !errors.Is(err, store.ErrOperationConfirmationTokenExpired) {
		t.Fatalf("expired token err=%v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT status FROM ky_ai_executor_operation_confirmation WHERE id=$1`, tokenExpired.ConfirmationID).Scan(&status); err != nil || status != "expired" {
		t.Fatalf("token expired status=%s err=%v", status, err)
	}
}

func newConfirmationManager(t *testing.T, control *store.ControlStore) *operationconfirmation.Manager {
	t.Helper()
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = byte(index + 1)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	signer, err := trustedtoken.NewSigner("confirmation_key_1", privateKey)
	if err != nil {
		t.Fatal(err)
	}
	manager, err := operationconfirmation.New(
		control, signer,
		trustedtoken.KeySet{"confirmation_key_1": privateKey.Public().(ed25519.PublicKey)},
		[]byte("0123456789abcdef0123456789abcdef"),
	)
	if err != nil {
		t.Fatal(err)
	}
	return manager
}

func confirmationDevice(seedByte byte) (string, string) {
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = seedByte + byte(index)
	}
	publicKey := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
	digest := sha256.Sum256(publicKey)
	return hex.EncodeToString(digest[:]), base64.RawURLEncoding.EncodeToString(publicKey)
}

func confirmationDigest(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}
