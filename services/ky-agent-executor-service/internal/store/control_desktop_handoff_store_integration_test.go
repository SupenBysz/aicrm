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

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/desktophandoff"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
	_ "github.com/jackc/pgx/v5/stdlib"
)

func TestControlDesktopHandoffStoreAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("KY_AGENT_EXECUTOR_DESKTOP_HANDOFF_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set KY_AGENT_EXECUTOR_DESKTOP_HANDOFF_TEST_DATABASE_URL for PostgreSQL integration")
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
	actorID := "owner_handoff_" + suffix
	device := newBindingDeviceFixture(t, 109)
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_device (
		 id,public_key,status,label,registered_by,workspace_type,workspace_id,last_heartbeat_at
		) VALUES ($1,$2,'active','handoff-integration',$3,'platform','platform_root',transaction_timestamp())
	`, device.deviceID, device.publicKey, actorID); err != nil {
		t.Fatal(err)
	}

	oldSigner, oldPublic := desktopTokenSigner(t, 17, "handoff-signing-old")
	keys := trustedtoken.KeySet{"handoff-signing-old": oldPublic}
	nonceSecret := []byte("desktop-handoff-integration-secret-v1")
	manager, err := desktophandoff.New(control, oldSigner, keys, nonceSecret)
	if err != nil {
		t.Fatal(err)
	}

	mainSession := seedDesktopSession(t, ctx, db, control, actorID, device.deviceID, "main_"+suffix)
	mainCreate := desktophandoff.CreateInput{
		SessionID: mainSession.Session.ID, ActorID: actorID, DeviceID: device.deviceID,
		ExpectedSessionRevision: mainSession.Session.Revision,
		IdempotencyKeyHash:      desktopDigest("main-create-key-" + suffix),
		RequestHash:             desktopDigest("main-create-body-" + suffix),
	}
	const createWorkers = 12
	createResults := make(chan desktophandoff.CreateResult, createWorkers)
	createErrors := make(chan error, createWorkers)
	var createGroup sync.WaitGroup
	for worker := 0; worker < createWorkers; worker++ {
		createGroup.Add(1)
		go func() {
			defer createGroup.Done()
			result, createErr := manager.Create(ctx, mainCreate)
			if createErr != nil {
				createErrors <- createErr
				return
			}
			createResults <- result
		}()
	}
	createGroup.Wait()
	close(createResults)
	close(createErrors)
	for createErr := range createErrors {
		t.Fatal(createErr)
	}
	var mainHandoff desktophandoff.CreateResult
	var createAccepted, createReplayed int
	for result := range createResults {
		if mainHandoff.HandoffID == "" {
			mainHandoff = result
		}
		if result.HandoffID != mainHandoff.HandoffID || result.HandoffTicket != mainHandoff.HandoffTicket ||
			result.Nonce != mainHandoff.Nonce || result.ExpiresAt != mainHandoff.ExpiresAt {
			t.Fatalf("concurrent create was not deterministic: first=%#v next=%#v", mainHandoff, result)
		}
		if result.Created {
			createAccepted++
		} else {
			createReplayed++
		}
	}
	if createAccepted != 1 || createReplayed != createWorkers-1 {
		t.Fatalf("create accepted=%d replayed=%d", createAccepted, createReplayed)
	}

	claimTime := time.Now().UTC().Truncate(time.Millisecond)
	mainSigned := signedHandoffClaim(t, device, mainHandoff.HandoffTicket, mainSession.Session.ID,
		mainHandoff.HandoffID, claimTime, desktopNonce(1), 1)
	mainClaim := desktophandoff.ClaimInput{
		HandoffTicket: mainHandoff.HandoffTicket, SessionID: mainSession.Session.ID,
		HandoffID: mainHandoff.HandoffID, TargetDeviceID: device.deviceID, KeyGeneration: 1,
		Proof: mainSigned.verified, ClaimedAt: claimTime,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	}
	const claimWorkers = 12
	var claimAccepted, claimReplayed atomic.Int64
	claimResults := make(chan desktophandoff.ClaimResult, claimWorkers)
	claimErrors := make(chan error, claimWorkers)
	var claimGroup sync.WaitGroup
	for worker := 0; worker < claimWorkers; worker++ {
		claimGroup.Add(1)
		go func() {
			defer claimGroup.Done()
			result, claimErr := manager.Claim(ctx, mainClaim)
			if claimErr != nil {
				claimErrors <- claimErr
				return
			}
			if result.Replayed {
				claimReplayed.Add(1)
			} else {
				claimAccepted.Add(1)
			}
			claimResults <- result
		}()
	}
	claimGroup.Wait()
	close(claimResults)
	close(claimErrors)
	for claimErr := range claimErrors {
		t.Fatal(claimErr)
	}
	var mainClaimResult desktophandoff.ClaimResult
	for result := range claimResults {
		if mainClaimResult.ClaimToken == "" {
			mainClaimResult = result
		}
		if result.HandoffID != mainClaimResult.HandoffID || result.ClaimToken != mainClaimResult.ClaimToken ||
			result.ExpiresAt != mainClaimResult.ExpiresAt || result.SessionRevision != mainClaimResult.SessionRevision {
			t.Fatalf("concurrent claim was not deterministic: first=%#v next=%#v", mainClaimResult, result)
		}
	}
	if claimAccepted.Load() != 1 || claimReplayed.Load() != claimWorkers-1 || mainClaimResult.SessionRevision != 2 {
		t.Fatalf("claim accepted=%d replayed=%d result=%#v", claimAccepted.Load(), claimReplayed.Load(), mainClaimResult)
	}
	assertDesktopClaimState(t, ctx, db, mainSession.Session.ID, mainHandoff.HandoffID, device.deviceID)

	if err := control.Close(); err != nil {
		t.Fatal(err)
	}
	control, err = store.OpenControl(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	manager, err = desktophandoff.New(control, oldSigner, keys, nonceSecret)
	if err != nil {
		t.Fatal(err)
	}
	restartedReplay, err := manager.Claim(ctx, mainClaim)
	if err != nil || !restartedReplay.Replayed || restartedReplay.ClaimToken != mainClaimResult.ClaimToken {
		t.Fatalf("restart replay=%#v err=%v", restartedReplay, err)
	}

	assertAlteredClaimRejected(t, ctx, manager, device, mainClaim, claimTime, "body")
	assertAlteredClaimRejected(t, ctx, manager, device, mainClaim, claimTime, "nonce")
	assertAlteredClaimRejected(t, ctx, manager, device, mainClaim, claimTime, "token")
	assertAlteredClaimRejected(t, ctx, manager, device, mainClaim, claimTime, "sequence")

	newSigner, newPublic := desktopTokenSigner(t, 41, "handoff-signing-new")
	rotatedKeys := trustedtoken.KeySet{"handoff-signing-old": oldPublic, "handoff-signing-new": newPublic}
	rotatedManager, err := desktophandoff.New(control, newSigner, rotatedKeys, nonceSecret)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rotatedManager.Create(ctx, mainCreate); !errors.Is(err, desktophandoff.ErrTokenKeyUnavailable) {
		t.Fatalf("rotated signer reconstructed old handoff ticket: %v", err)
	}
	if _, err := rotatedManager.Claim(ctx, mainClaim); !errors.Is(err, desktophandoff.ErrTokenKeyUnavailable) {
		t.Fatalf("rotated signer reconstructed old claim token: %v", err)
	}

	expiredSession := seedDesktopSession(t, ctx, db, control, actorID, device.deviceID, "expired_"+suffix)
	expiredKey := desktopDigest("expired-create-key-" + suffix)
	expiredRequest := desktopDigest("expired-create-body-" + suffix)
	expiredID := "handoff_expired_" + suffix
	expiredIssuedAt := time.Now().UTC().Add(-5 * time.Minute).Truncate(time.Second)
	expiredTicket, expiredTicketNonce := seedExpiredHandoff(t, ctx, db, oldSigner, nonceSecret,
		expiredID, expiredSession.Session.ID, expiredSession.Session.ExecutorID, device.deviceID, actorID,
		expiredSession.Session.Revision, expiredKey, expiredRequest, expiredIssuedAt)
	expiredReplay, err := manager.Create(ctx, desktophandoff.CreateInput{
		SessionID: expiredSession.Session.ID, ActorID: actorID, DeviceID: device.deviceID,
		ExpectedSessionRevision: expiredSession.Session.Revision,
		IdempotencyKeyHash:      expiredKey, RequestHash: expiredRequest,
	})
	if err != nil || expiredReplay.Created || expiredReplay.HandoffID != expiredID ||
		expiredReplay.HandoffTicket != expiredTicket || expiredReplay.Nonce != expiredTicketNonce {
		t.Fatalf("expired same-key replay=%#v err=%v", expiredReplay, err)
	}
	newAfterExpiry, err := manager.Create(ctx, desktophandoff.CreateInput{
		SessionID: expiredSession.Session.ID, ActorID: actorID, DeviceID: device.deviceID,
		ExpectedSessionRevision: expiredSession.Session.Revision,
		IdempotencyKeyHash:      desktopDigest("expired-new-key-" + suffix),
		RequestHash:             expiredRequest,
	})
	if err != nil || !newAfterExpiry.Created || newAfterExpiry.HandoffID == expiredID || newAfterExpiry.HandoffTicket == expiredTicket {
		t.Fatalf("expired new-key create=%#v err=%v", newAfterExpiry, err)
	}
	var oldExpiredStatus string
	if err := db.QueryRowContext(ctx, `SELECT status FROM ky_ai_executor_desktop_handoff WHERE id=$1`, expiredID).Scan(&oldExpiredStatus); err != nil || oldExpiredStatus != "expired" {
		t.Fatalf("old handoff status=%q err=%v", oldExpiredStatus, err)
	}
	expiredClaimTime := time.Now().UTC().Truncate(time.Millisecond)
	expiredSigned := signedHandoffClaim(t, device, expiredTicket, expiredSession.Session.ID,
		expiredID, expiredClaimTime, desktopNonce(2), 2)
	if _, err := manager.Claim(ctx, desktophandoff.ClaimInput{
		HandoffTicket: expiredTicket, SessionID: expiredSession.Session.ID, HandoffID: expiredID,
		TargetDeviceID: device.deviceID, KeyGeneration: 1, Proof: expiredSigned.verified,
		ClaimedAt:       expiredClaimTime,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	}); !errors.Is(err, trustedtoken.ErrExpired) {
		t.Fatalf("expired JWS was not rejected at database time: %v", err)
	}

	assertNewClaimStateRejections(t, ctx, db, control, manager, actorID, device, suffix)
	assertDesktopClaimRollback(t, ctx, db, control, manager, actorID, device, suffix)

	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_authorization_session
		SET status='cancelled',finished_at=transaction_timestamp(),updated_at=transaction_timestamp()
		WHERE id=$1
	`, mainSession.Session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_device
		SET status='disabled',last_heartbeat_at=transaction_timestamp()-interval '10 minutes',key_generation=2
		WHERE id=$1
	`, device.deviceID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_device_binding
		SET status='revoked',revoked_at=transaction_timestamp(),updated_at=transaction_timestamp()
		WHERE executor_id=$1
	`, mainSession.Session.ExecutorID); err != nil {
		t.Fatal(err)
	}
	terminalReplay, err := manager.Claim(ctx, mainClaim)
	if err != nil || !terminalReplay.Replayed || terminalReplay.ClaimToken != mainClaimResult.ClaimToken {
		t.Fatalf("exact replay after terminal/offline/disabled/rekey=%#v err=%v", terminalReplay, err)
	}
	newSequence := mainClaim
	newSequence.KeyGeneration = 1
	newSequence.ClaimedAt = time.Now().UTC().Truncate(time.Millisecond)
	newSequence.Proof = signedHandoffClaim(t, device, mainHandoff.HandoffTicket, mainSession.Session.ID,
		mainHandoff.HandoffID, newSequence.ClaimedAt, desktopNonce(19), 2).verified
	if _, err := manager.Claim(ctx, newSequence); err == nil {
		t.Fatal("new claim succeeded after terminal/offline/disabled/rekey state")
	}

	assertNoDesktopHandoffSecrets(t, ctx, db, mainSession.Session.ID, mainHandoff.HandoffID, []string{
		mainHandoff.HandoffTicket, mainHandoff.Nonce, mainClaimResult.ClaimToken, mainSigned.signature,
		"AiCRM-Handoff " + mainHandoff.HandoffTicket,
	})
}

type desktopSessionFixture struct {
	Session store.AuthorizationSessionProjection
}

type signedDesktopClaim struct {
	verified  deviceauth.VerifiedRequest
	signature string
}

func seedDesktopSession(
	t *testing.T,
	ctx context.Context,
	db *sql.DB,
	control *store.ControlStore,
	actorID string,
	deviceID string,
	label string,
) desktopSessionFixture {
	t.Helper()
	executorID := "aiexec_handoff_" + label
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_config (
		 id,name,scope_type,scope_id,executor_type,runtime_type,status,is_default,
		 max_concurrency,credential_status
		) VALUES ($1,'Desktop handoff integration','platform','platform_root','codex','desktop',
		 'enabled',false,1,'not_authorized')
	`, executorID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_device_binding (
		 executor_id,device_id,revision,status,bound_by
		) VALUES ($1,$2,1,'active',$3)
	`, executorID, deviceID, actorID); err != nil {
		t.Fatal(err)
	}
	result, err := control.CreateAuthorizationSession(ctx, store.CreateAuthorizationSessionInput{
		ID: "auth_handoff_" + label, ExecutorID: executorID, Intent: "authorize", ActorID: actorID,
		IdempotencyKeyHash: desktopDigest(label + ":session-key"),
		RequestHash:        desktopDigest(label + ":session-body"),
		Deadline:           time.Now().UTC().Add(15 * time.Minute),
	})
	if err != nil || !result.Created || result.Session.Status != "starting" || result.Session.Revision != 1 {
		t.Fatalf("seed session=%#v err=%v", result, err)
	}
	return desktopSessionFixture{Session: result.Session}
}

func signedHandoffClaim(
	t *testing.T,
	device bindingDeviceFixture,
	ticket string,
	sessionID string,
	handoffID string,
	claimedAt time.Time,
	nonce string,
	sequence uint64,
) signedDesktopClaim {
	t.Helper()
	body := []byte(fmt.Sprintf(`{"handoffId":%q,"claimedAt":%q}`, handoffID, claimedAt.UTC().Format(time.RFC3339Nano)))
	return signedHandoffClaimRequest(t, device, ticket, sessionID, handoffID, claimedAt, nonce, sequence, body)
}

func signedHandoffClaimRequest(
	t *testing.T,
	device bindingDeviceFixture,
	ticket string,
	sessionID string,
	handoffID string,
	claimedAt time.Time,
	nonce string,
	sequence uint64,
	body []byte,
) signedDesktopClaim {
	t.Helper()
	path := "/api/v1/ai-executor-authorization-sessions/" + sessionID + "/desktop-handoffs/" + handoffID + "/claim"
	authorization := "AiCRM-Handoff " + ticket
	authorizationHash, err := deviceauth.AuthorizationTokenHash(authorization, []string{"AiCRM-Handoff"})
	if err != nil {
		t.Fatal(err)
	}
	headers := deviceauth.ProofHeaders{
		DeviceID: device.deviceID, TimestampMilli: claimedAt.UnixMilli(), Nonce: nonce,
		Sequence: sequence, BodySHA256: deviceauth.HashBody(body),
	}
	signingInput, err := deviceauth.SigningInput("POST", path, headers, authorizationHash)
	if err != nil {
		t.Fatal(err)
	}
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(device.privateKey, signingInput))
	httpHeaders := make(http.Header)
	httpHeaders.Set(deviceauth.HeaderDeviceID, device.deviceID)
	httpHeaders.Set(deviceauth.HeaderTimestamp, fmt.Sprintf("%d", claimedAt.UnixMilli()))
	httpHeaders.Set(deviceauth.HeaderNonce, nonce)
	httpHeaders.Set(deviceauth.HeaderSequence, fmt.Sprintf("%d", sequence))
	httpHeaders.Set(deviceauth.HeaderContentSHA256, deviceauth.HashBody(body))
	httpHeaders.Set(deviceauth.HeaderSignature, signature)
	httpHeaders.Set("Authorization", authorization)
	verified, err := deviceauth.VerifyRequest(deviceauth.VerifyInput{
		PublicKey: device.publicKey, Method: "POST", RequestTarget: path,
		Headers: httpHeaders, Body: body, AllowedAuthorizationSchemes: []string{"AiCRM-Handoff"}, Now: claimedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	return signedDesktopClaim{verified: verified, signature: signature}
}

func assertAlteredClaimRejected(
	t *testing.T,
	ctx context.Context,
	manager *desktophandoff.Manager,
	device bindingDeviceFixture,
	original desktophandoff.ClaimInput,
	claimedAt time.Time,
	alteration string,
) {
	t.Helper()
	changed := original
	ticket := original.HandoffTicket
	nonce := desktopNonce(1)
	sequence := uint64(1)
	want := error(store.ErrDeviceProofReplayed)
	body := []byte(fmt.Sprintf(`{"handoffId":%q,"claimedAt":%q}`, original.HandoffID, claimedAt.UTC().Format(time.RFC3339Nano)))
	switch alteration {
	case "body":
		body = append(body, ' ')
	case "nonce":
		nonce = desktopNonce(7)
	case "token":
		ticket = "altered-ticket-canary"
	case "sequence":
		sequence = 2
		want = store.ErrDesktopHandoffClaimConflict
	default:
		t.Fatalf("unknown alteration %q", alteration)
	}
	changed.HandoffTicket = ticket
	changed.Proof = signedHandoffClaimRequest(t, device, ticket, original.SessionID, original.HandoffID,
		claimedAt, nonce, sequence, body).verified
	if _, err := manager.Claim(ctx, changed); !errors.Is(err, want) {
		t.Fatalf("same sequence altered %s was not rejected: %v", alteration, err)
	}
}

func seedExpiredHandoff(
	t *testing.T,
	ctx context.Context,
	db *sql.DB,
	signer *trustedtoken.Signer,
	nonceSecret []byte,
	handoffID, sessionID, executorID, deviceID, actorID string,
	expectedRevision int64,
	idempotencyKeyHash, requestHash string,
	issuedAt time.Time,
) (string, string) {
	t.Helper()
	nonce := deterministicDesktopNonce(nonceSecret, "handoff-ticket", handoffID)
	claims, err := trustedtoken.NewClaims(trustedtoken.AudienceDesktop,
		trustedtoken.PurposeAuthorizationHandoff, handoffID, nonce, issuedAt)
	if err != nil {
		t.Fatal(err)
	}
	claims.ActorID, claims.SessionID, claims.ExecutorID = actorID, sessionID, executorID
	claims.DeviceID, claims.HandoffID = deviceID, handoffID
	claims.ExpectedSessionRevision = &expectedRevision
	ticket, err := signer.Issue(claims)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_desktop_handoff (
		 id,session_id,executor_id,device_id,requested_by,expected_session_revision,
		 idempotency_key_hash,request_hash,ticket_hash,ticket_nonce_hash,token_key_id,
		 status,issued_at,expires_at,created_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13,$12)
	`, handoffID, sessionID, executorID, deviceID, actorID, expectedRevision,
		idempotencyKeyHash, requestHash, trustedtoken.Hash(ticket), desktopDigest(nonce), signer.KeyID(),
		issuedAt, issuedAt.Add(store.DesktopHandoffLifetime)); err != nil {
		t.Fatal(err)
	}
	return ticket, nonce
}

func assertNewClaimStateRejections(
	t *testing.T,
	ctx context.Context,
	db *sql.DB,
	control *store.ControlStore,
	manager *desktophandoff.Manager,
	actorID string,
	device bindingDeviceFixture,
	suffix string,
) {
	t.Helper()
	cases := []struct {
		name   string
		mutate func(store.AuthorizationSessionProjection)
		want   error
	}{
		{
			name: "offline",
			mutate: func(_ store.AuthorizationSessionProjection) {
				if _, err := db.ExecContext(ctx, `UPDATE ky_ai_executor_device SET last_heartbeat_at=transaction_timestamp()-interval '121 seconds' WHERE id=$1`, device.deviceID); err != nil {
					t.Fatal(err)
				}
			},
			want: store.ErrDesktopDeviceOffline,
		},
		{
			name: "disabled",
			mutate: func(_ store.AuthorizationSessionProjection) {
				if _, err := db.ExecContext(ctx, `UPDATE ky_ai_executor_device SET status='disabled' WHERE id=$1`, device.deviceID); err != nil {
					t.Fatal(err)
				}
			},
			want: store.ErrDesktopHandoffTargetMismatch,
		},
		{
			name: "terminal",
			mutate: func(session store.AuthorizationSessionProjection) {
				if _, err := db.ExecContext(ctx, `UPDATE ky_ai_executor_authorization_session SET status='cancelled',finished_at=transaction_timestamp() WHERE id=$1`, session.ID); err != nil {
					t.Fatal(err)
				}
			},
			want: store.ErrDesktopHandoffTargetMismatch,
		},
	}
	for index, testCase := range cases {
		if _, err := db.ExecContext(ctx, `UPDATE ky_ai_executor_device SET status='active',key_generation=1,last_heartbeat_at=transaction_timestamp() WHERE id=$1`, device.deviceID); err != nil {
			t.Fatal(err)
		}
		session := seedDesktopSession(t, ctx, db, control, actorID, device.deviceID,
			testCase.name+"_"+suffix)
		created, err := manager.Create(ctx, desktophandoff.CreateInput{
			SessionID: session.Session.ID, ActorID: actorID, DeviceID: device.deviceID,
			ExpectedSessionRevision: session.Session.Revision,
			IdempotencyKeyHash:      desktopDigest(testCase.name + ":create-key:" + suffix),
			RequestHash:             desktopDigest(testCase.name + ":create-body:" + suffix),
		})
		if err != nil {
			t.Fatal(err)
		}
		testCase.mutate(session.Session)
		claimTime := time.Now().UTC().Truncate(time.Millisecond)
		proof := signedHandoffClaim(t, device, created.HandoffTicket, session.Session.ID,
			created.HandoffID, claimTime, desktopNonce(byte(30+index)), 2)
		_, err = manager.Claim(ctx, desktophandoff.ClaimInput{
			HandoffTicket: created.HandoffTicket, SessionID: session.Session.ID, HandoffID: created.HandoffID,
			TargetDeviceID: device.deviceID, KeyGeneration: 1, Proof: proof.verified, ClaimedAt: claimTime,
			LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
		})
		if !errors.Is(err, testCase.want) {
			t.Fatalf("%s claim error=%v want=%v", testCase.name, err, testCase.want)
		}
	}
	if _, err := db.ExecContext(ctx, `UPDATE ky_ai_executor_device SET status='active',key_generation=1,last_heartbeat_at=transaction_timestamp() WHERE id=$1`, device.deviceID); err != nil {
		t.Fatal(err)
	}
}

func assertDesktopClaimRollback(
	t *testing.T,
	ctx context.Context,
	db *sql.DB,
	control *store.ControlStore,
	manager *desktophandoff.Manager,
	actorID string,
	device bindingDeviceFixture,
	suffix string,
) {
	t.Helper()
	session := seedDesktopSession(t, ctx, db, control, actorID, device.deviceID, "rollback_"+suffix)
	created, err := manager.Create(ctx, desktophandoff.CreateInput{
		SessionID: session.Session.ID, ActorID: actorID, DeviceID: device.deviceID,
		ExpectedSessionRevision: 1,
		IdempotencyKeyHash:      desktopDigest("rollback-create-key-" + suffix),
		RequestHash:             desktopDigest("rollback-create-body-" + suffix),
	})
	if err != nil {
		t.Fatal(err)
	}
	outboxID := "control_outbox_" + session.Session.ID + "_2_authorization.desktop_claimed"
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_control_outbox (
		 id,aggregate_type,aggregate_id,aggregate_revision,event_type,safe_reference_json,occurred_at
		) VALUES ($1,'authorization_session',$2,2,'authorization.desktop_claimed','{}'::jsonb,transaction_timestamp())
	`, outboxID, session.Session.ID); err != nil {
		t.Fatal(err)
	}
	claimTime := time.Now().UTC().Truncate(time.Millisecond)
	proof := signedHandoffClaim(t, device, created.HandoffTicket, session.Session.ID,
		created.HandoffID, claimTime, desktopNonce(61), 2)
	if _, err := manager.Claim(ctx, desktophandoff.ClaimInput{
		HandoffTicket: created.HandoffTicket, SessionID: session.Session.ID, HandoffID: created.HandoffID,
		TargetDeviceID: device.deviceID, KeyGeneration: 1, Proof: proof.verified, ClaimedAt: claimTime,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	}); err == nil {
		t.Fatal("forced outbox conflict did not roll back claim")
	}
	var handoffStatus, sessionStatus string
	var revision, sequence, deviceSequence, ledgerCount, eventCount int64
	if err := db.QueryRowContext(ctx, `
		SELECT handoff.status,session.status,session.revision,session.current_sequence,device.last_accepted_sequence,
		 (SELECT count(*) FROM ky_ai_executor_device_request_ledger WHERE device_id=device.id AND sequence=2),
		 (SELECT count(*) FROM ky_ai_executor_authorization_session_event WHERE session_id=session.id)
		FROM ky_ai_executor_desktop_handoff handoff
		JOIN ky_ai_executor_authorization_session session ON session.id=handoff.session_id
		JOIN ky_ai_executor_device device ON device.id=handoff.device_id
		WHERE handoff.id=$1
	`, created.HandoffID).Scan(&handoffStatus, &sessionStatus, &revision, &sequence, &deviceSequence,
		&ledgerCount, &eventCount); err != nil {
		t.Fatal(err)
	}
	if handoffStatus != "pending" || sessionStatus != "starting" || revision != 1 || sequence != 1 ||
		deviceSequence != 1 || ledgerCount != 0 || eventCount != 1 {
		t.Fatalf("rollback leaked handoff=%s session=%s revision=%d sequence=%d deviceSequence=%d ledger=%d events=%d",
			handoffStatus, sessionStatus, revision, sequence, deviceSequence, ledgerCount, eventCount)
	}
}

func assertDesktopClaimState(t *testing.T, ctx context.Context, db *sql.DB, sessionID, handoffID, deviceID string) {
	t.Helper()
	var handoffStatus, sessionStatus, boundDevice, snapshotStatus, snapshotDevice string
	var revision, sequence, snapshotRevision, snapshotSequence int64
	var ledgerCount, outboxCount int
	if err := db.QueryRowContext(ctx, `
		SELECT handoff.status,session.status,session.bound_device_id,session.revision,session.current_sequence,
		 event.safe_payload_json #>> '{session,status}',
		 (event.safe_payload_json #>> '{session,revision}')::bigint,
		 (event.safe_payload_json #>> '{session,sequence}')::bigint,
		 event.safe_payload_json #>> '{deviceId}',
		 (SELECT count(*) FROM ky_ai_executor_device_request_ledger WHERE device_id=$3 AND sequence=1),
		 (SELECT count(*) FROM ky_ai_executor_control_outbox WHERE aggregate_type='authorization_session'
		   AND aggregate_id=$1 AND event_type='authorization.desktop_claimed')
		FROM ky_ai_executor_desktop_handoff handoff
		JOIN ky_ai_executor_authorization_session session ON session.id=handoff.session_id
		JOIN ky_ai_executor_authorization_session_event event ON event.session_id=session.id AND event.sequence=2
		WHERE handoff.id=$2 AND session.id=$1
	`, sessionID, handoffID, deviceID).Scan(&handoffStatus, &sessionStatus, &boundDevice,
		&revision, &sequence, &snapshotStatus, &snapshotRevision, &snapshotSequence, &snapshotDevice,
		&ledgerCount, &outboxCount); err != nil {
		t.Fatal(err)
	}
	if handoffStatus != "claimed" || sessionStatus != "waiting_user" || boundDevice != deviceID ||
		revision != 2 || sequence != 2 || snapshotStatus != "waiting_user" || snapshotRevision != 2 ||
		snapshotSequence != 2 || snapshotDevice != deviceID || ledgerCount != 1 || outboxCount != 1 {
		t.Fatalf("claim state handoff=%s session=%s bound=%s revision=%d sequence=%d snapshot=%s/%d/%d device=%s ledger=%d outbox=%d",
			handoffStatus, sessionStatus, boundDevice, revision, sequence, snapshotStatus, snapshotRevision,
			snapshotSequence, snapshotDevice, ledgerCount, outboxCount)
	}
}

func assertNoDesktopHandoffSecrets(t *testing.T, ctx context.Context, db *sql.DB, sessionID, handoffID string, canaries []string) {
	t.Helper()
	var persisted string
	if err := db.QueryRowContext(ctx, `
		SELECT concat_ws('|',
		 row_to_json(handoff)::text,
		 row_to_json(session)::text,
		 COALESCE((SELECT json_agg(value)::text FROM ky_ai_executor_device_request_ledger value
		           WHERE response_reference='desktop_claim_' || $2),''),
		 COALESCE((SELECT json_agg(value)::text FROM ky_ai_executor_authorization_session_event value
		           WHERE session_id=$1),''),
		 COALESCE((SELECT json_agg(value)::text FROM ky_ai_executor_control_outbox value
		           WHERE aggregate_id=$1),''))
		FROM ky_ai_executor_desktop_handoff handoff
		JOIN ky_ai_executor_authorization_session session ON session.id=handoff.session_id
		WHERE handoff.id=$2
	`, sessionID, handoffID).Scan(&persisted); err != nil {
		t.Fatal(err)
	}
	for _, canary := range canaries {
		if canary != "" && strings.Contains(persisted, canary) {
			t.Fatalf("raw handoff secret reached PostgreSQL: %.24q", canary)
		}
	}
}

func desktopTokenSigner(t *testing.T, seedByte byte, keyID string) (*trustedtoken.Signer, ed25519.PublicKey) {
	t.Helper()
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = seedByte + byte(index)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	signer, err := trustedtoken.NewSigner(keyID, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	return signer, append(ed25519.PublicKey(nil), privateKey.Public().(ed25519.PublicKey)...)
}

func deterministicDesktopNonce(secret []byte, class, handoffID string) string {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte("aicrm-desktop-handoff-" + class + "-nonce-v1\n" + handoffID))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:16])
}

func desktopDigest(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func desktopNonce(seedByte byte) string {
	raw := make([]byte, 16)
	for index := range raw {
		raw[index] = seedByte + byte(index)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}
