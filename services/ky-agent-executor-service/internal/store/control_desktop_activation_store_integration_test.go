package store_test

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
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

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/desktopactivation"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/desktophandoff"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/store"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
	_ "github.com/jackc/pgx/v5/stdlib"
)

func TestDesktopAuthorizationProofAndActivationAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("KY_AGENT_EXECUTOR_DESKTOP_ACTIVATION_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set KY_AGENT_EXECUTOR_DESKTOP_ACTIVATION_TEST_DATABASE_URL for PostgreSQL integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
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
	actorID := "owner_activation_" + suffix
	signer, publicKey := desktopTokenSigner(t, 123, "desktop-activation-old")
	keys := trustedtoken.KeySet{"desktop-activation-old": publicKey}
	nonceSecret := []byte("desktop-activation-integration-secret-v1")
	handoffManager, err := desktophandoff.New(control, signer, keys, nonceSecret)
	if err != nil {
		t.Fatal(err)
	}
	activationManager, err := desktopactivation.New(control, signer, keys, nonceSecret)
	if err != nil {
		t.Fatal(err)
	}

	mainFlow := seedClaimedDesktopFlow(t, ctx, db, control, handoffManager,
		actorID, "main_"+suffix, 9, "authorize", "")
	proofTime := time.Now().UTC().Truncate(time.Millisecond)
	mainProofSigned := signedDesktopAuthorizationProof(t, mainFlow.device, mainFlow.claimToken,
		mainFlow.session.ID, mainFlow.handoffID, mainFlow.session.Revision,
		desktopDigest("login-main-"+suffix), "succeeded", proofTime,
		desktopDigest("account-main-"+suffix), desktopDigest("binding-main-"+suffix),
		desktopNonce(22), 2, nil)
	mainProof := desktopactivation.SubmitProofInput{
		ClaimToken: mainFlow.claimToken, SessionID: mainFlow.session.ID,
		HandoffID: mainFlow.handoffID, TargetDeviceID: mainFlow.device.deviceID,
		KeyGeneration: 1, SessionRevision: mainFlow.session.Revision,
		LoginIDHash: desktopDigest("login-main-" + suffix), Result: "succeeded",
		CheckedAt: proofTime, AccountFingerprint: desktopDigest("account-main-" + suffix),
		CandidateBindingDigest: desktopDigest("binding-main-" + suffix),
		Proof:                  mainProofSigned.verified,
		LedgerExpiresAt:        time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	}
	const proofWorkers = 12
	proofResults := make(chan desktopactivation.SubmitProofResult, proofWorkers)
	proofErrors := make(chan error, proofWorkers)
	var proofGroup sync.WaitGroup
	var proofAccepted, proofReplayed atomic.Int64
	for worker := 0; worker < proofWorkers; worker++ {
		proofGroup.Add(1)
		go func() {
			defer proofGroup.Done()
			result, submitErr := activationManager.SubmitProof(ctx, mainProof)
			if submitErr != nil {
				proofErrors <- submitErr
				return
			}
			if result.Replayed {
				proofReplayed.Add(1)
			} else {
				proofAccepted.Add(1)
			}
			proofResults <- result
		}()
	}
	proofGroup.Wait()
	close(proofResults)
	close(proofErrors)
	for submitErr := range proofErrors {
		t.Fatal(submitErr)
	}
	var prepared desktopactivation.SubmitProofResult
	for result := range proofResults {
		if prepared.ProofID == "" {
			prepared = result
		}
		if result.ProofID != prepared.ProofID || result.SessionRevision != prepared.SessionRevision ||
			result.Activation == nil || prepared.Activation == nil ||
			*result.Activation != *prepared.Activation {
			t.Fatalf("non-deterministic proof replay: first=%#v next=%#v", prepared, result)
		}
	}
	if proofAccepted.Load() != 1 || proofReplayed.Load() != proofWorkers-1 ||
		prepared.Activation == nil || prepared.SessionRevision != 3 {
		t.Fatalf("proof accepted=%d replayed=%d result=%#v",
			proofAccepted.Load(), proofReplayed.Load(), prepared)
	}
	assertDesktopPreparedState(t, ctx, db, mainFlow, prepared)
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_credential_activation SET binding_digest=$2 WHERE id=$1
	`, prepared.Activation.ActivationID, desktopDigest("tampered-frozen-binding-"+suffix)); err == nil {
		t.Fatal("activation frozen binding digest was mutable")
	}

	if err := control.Close(); err != nil {
		t.Fatal(err)
	}
	control, err = store.OpenControl(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	handoffManager, _ = desktophandoff.New(control, signer, keys, nonceSecret)
	activationManager, _ = desktopactivation.New(control, signer, keys, nonceSecret)
	restartedProof, err := activationManager.SubmitProof(ctx, mainProof)
	if err != nil || !restartedProof.Replayed || restartedProof.Activation == nil ||
		restartedProof.Activation.ActivationToken != prepared.Activation.ActivationToken {
		t.Fatalf("proof response-loss replay=%#v err=%v", restartedProof, err)
	}

	newSigner, newPublic := desktopTokenSigner(t, 137, "desktop-activation-new")
	rotatedKeys := trustedtoken.KeySet{
		"desktop-activation-old": publicKey,
		"desktop-activation-new": newPublic,
	}
	rotatedManager, err := desktopactivation.New(control, newSigner, rotatedKeys, nonceSecret)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rotatedManager.SubmitProof(ctx, mainProof); !errors.Is(err, desktopactivation.ErrTokenKeyUnavailable) {
		t.Fatalf("rotated key reconstructed old activation token: %v", err)
	}
	assertAlteredDesktopProofs(t, ctx, activationManager, mainFlow, mainProof, proofTime)

	barrierAt := time.Now().UTC().Truncate(time.Millisecond)
	ackSigned := signedDesktopActivationACK(t, mainFlow.device, prepared.Activation.ActivationToken,
		mainFlow.session.ID, *prepared.Activation, barrierAt, desktopNonce(23), 3, nil)
	ackInput := desktopactivation.AcknowledgeInput{
		ActivationToken: prepared.Activation.ActivationToken,
		SessionID:       mainFlow.session.ID, ActivationID: prepared.Activation.ActivationID,
		TargetDeviceID: mainFlow.device.deviceID, KeyGeneration: 1,
		OperationID:               prepared.Activation.OperationID,
		CredentialRevision:        prepared.Activation.CredentialRevision,
		LeaseEpoch:                prepared.Activation.LeaseEpoch,
		SourceCredentialRevision:  prepared.Activation.SourceCredentialRevision,
		RevocationEpoch:           prepared.Activation.RevocationEpoch,
		DurableBarrierCompletedAt: barrierAt, BindingDigest: prepared.Activation.BindingDigest,
		Proof:           ackSigned.verified,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	}
	const ackWorkers = 12
	ackResults := make(chan desktopactivation.AcknowledgeResult, ackWorkers)
	ackErrors := make(chan error, ackWorkers)
	var ackGroup sync.WaitGroup
	var ackAccepted, ackReplayed atomic.Int64
	for worker := 0; worker < ackWorkers; worker++ {
		ackGroup.Add(1)
		go func() {
			defer ackGroup.Done()
			result, ackErr := activationManager.Acknowledge(ctx, ackInput)
			if ackErr != nil {
				ackErrors <- ackErr
				return
			}
			if result.Replayed {
				ackReplayed.Add(1)
			} else {
				ackAccepted.Add(1)
			}
			ackResults <- result
		}()
	}
	ackGroup.Wait()
	close(ackResults)
	close(ackErrors)
	for ackErr := range ackErrors {
		t.Fatal(ackErr)
	}
	var activated desktopactivation.AcknowledgeResult
	for result := range ackResults {
		if activated.ActivationID == "" {
			activated = result
		}
		if result.ActivationID != activated.ActivationID || result.ExecutorID != activated.ExecutorID ||
			result.CredentialRevision != activated.CredentialRevision ||
			result.SessionRevision != activated.SessionRevision {
			t.Fatalf("non-deterministic ACK replay: first=%#v next=%#v", activated, result)
		}
	}
	if ackAccepted.Load() != 1 || ackReplayed.Load() != ackWorkers-1 || activated.SessionRevision != 4 {
		t.Fatalf("ACK accepted=%d replayed=%d result=%#v", ackAccepted.Load(), ackReplayed.Load(), activated)
	}
	assertDesktopActivatedState(t, ctx, db, mainFlow, prepared, activated)
	assertAlteredDesktopACKs(t, ctx, activationManager, mainFlow, prepared, ackInput, barrierAt)

	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_device
		SET status='disabled',key_generation=2,last_heartbeat_at=transaction_timestamp()-interval '10 minutes'
		WHERE id=$1
	`, mainFlow.device.deviceID); err != nil {
		t.Fatal(err)
	}
	terminalACKReplay, err := activationManager.Acknowledge(ctx, ackInput)
	if err != nil || !terminalACKReplay.Replayed || terminalACKReplay.CredentialRevision != activated.CredentialRevision {
		t.Fatalf("terminal/disabled/rekey ACK replay=%#v err=%v", terminalACKReplay, err)
	}

	testTerminalDesktopProofs(t, ctx, db, control, handoffManager, activationManager, actorID, suffix)
	testDesktopActivationFences(t, ctx, db, control, handoffManager, activationManager, signer, nonceSecret, actorID, suffix)
	testDesktopActivationInterleavingWinners(t, ctx, db, control, handoffManager, activationManager, actorID, suffix)
	testExpiredDesktopActivationToken(t, ctx, db, control, handoffManager, activationManager, signer, nonceSecret, actorID, suffix)
	testDesktopAccountIntentAndSwap(t, ctx, db, control, handoffManager, activationManager, actorID, suffix)
	testDesktopOldCredentialSwapRollback(t, ctx, db, control, handoffManager, activationManager, actorID, suffix)

	assertNoDesktopActivationSecrets(t, ctx, db, mainFlow, prepared, []string{
		mainFlow.claimToken, prepared.Activation.ActivationToken,
		mainProofSigned.signature, ackSigned.signature,
		"AiCRM-Claim " + mainFlow.claimToken,
		"AiCRM-Activation " + prepared.Activation.ActivationToken,
	})
}

type claimedDesktopFlow struct {
	device     bindingDeviceFixture
	executorID string
	session    store.AuthorizationSessionProjection
	handoffID  string
	claimToken string
}

type signedActivationRequest struct {
	verified  deviceauth.VerifiedRequest
	signature string
}

func seedClaimedDesktopFlow(
	t *testing.T,
	ctx context.Context,
	db *sql.DB,
	control *store.ControlStore,
	handoffManager *desktophandoff.Manager,
	actorID, label string,
	seedByte byte,
	intent string,
	activeFingerprint string,
) claimedDesktopFlow {
	t.Helper()
	device := newBindingDeviceFixture(t, seedByte)
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_device (
		 id,public_key,status,label,registered_by,workspace_type,workspace_id,last_heartbeat_at
		) VALUES ($1,$2,'active',$3,$4,'platform','platform_root',transaction_timestamp())
	`, device.deviceID, device.publicKey, label, actorID); err != nil {
		t.Fatal(err)
	}
	executorID := "aiexec_activation_" + label
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_config (
		 id,name,scope_type,scope_id,executor_type,runtime_type,status,is_default,
		 max_concurrency,credential_status
		) VALUES ($1,'Desktop activation integration','platform','platform_root','codex','desktop',
		 'enabled',false,1,'not_authorized')
	`, executorID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_device_binding (executor_id,device_id,revision,status,bound_by)
		VALUES ($1,$2,1,'active',$3)
	`, executorID, device.deviceID, actorID); err != nil {
		t.Fatal(err)
	}
	if activeFingerprint != "" {
		if _, err := db.ExecContext(ctx, `
			INSERT INTO ky_ai_executor_credential_binding (
			 executor_id,revision,status,runtime_type,runtime_binding_id,runtime_binding_revision,
			 device_id,account_fingerprint,auth_mode,binding_digest,revocation_epoch,
			 verified_at,activated_at,operation_id,lease_epoch,source_credential_revision,digest_algorithm
			) VALUES ($1,1,'active','desktop',$2,1,$2,$3,'browser',$4,0,
			 transaction_timestamp(),transaction_timestamp(),$5,1,0,$6)
		`, executorID, device.deviceID, activeFingerprint, desktopDigest("old-binding-"+label),
			"old_operation_"+label, "aicrm-credential-tree-rfc8785-nfc-v1"); err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `
			UPDATE ky_ai_executor_config
			SET credential_status='authorized',current_credential_revision=1,
			    credential_revision_counter=1,runtime_binding_id=$2,runtime_binding_revision=1
			WHERE id=$1
		`, executorID, device.deviceID); err != nil {
			t.Fatal(err)
		}
	}
	sessionResult, err := control.CreateAuthorizationSession(ctx, store.CreateAuthorizationSessionInput{
		ID: "auth_activation_" + label, ExecutorID: executorID, Intent: intent, ActorID: actorID,
		IdempotencyKeyHash: desktopDigest(label + ":session-key"),
		RequestHash:        desktopDigest(label + ":session-body"),
		Deadline:           time.Now().UTC().Add(15 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	handoff, err := handoffManager.Create(ctx, desktophandoff.CreateInput{
		SessionID: sessionResult.Session.ID, ActorID: actorID, DeviceID: device.deviceID,
		ExpectedSessionRevision: sessionResult.Session.Revision,
		IdempotencyKeyHash:      desktopDigest(label + ":handoff-key"),
		RequestHash:             desktopDigest(label + ":handoff-body"),
	})
	if err != nil {
		t.Fatal(err)
	}
	claimTime := time.Now().UTC().Truncate(time.Millisecond)
	claimSigned := signedHandoffClaim(t, device, handoff.HandoffTicket, sessionResult.Session.ID,
		handoff.HandoffID, claimTime, desktopNonce(1), 1)
	claim, err := handoffManager.Claim(ctx, desktophandoff.ClaimInput{
		HandoffTicket: handoff.HandoffTicket, SessionID: sessionResult.Session.ID,
		HandoffID: handoff.HandoffID, TargetDeviceID: device.deviceID,
		KeyGeneration: 1, Proof: claimSigned.verified, ClaimedAt: claimTime,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := control.GetAuthorizationSession(ctx, sessionResult.Session.ID)
	if err != nil || session.Status != "waiting_user" || session.Revision != 2 {
		t.Fatalf("claimed session=%#v err=%v", session, err)
	}
	return claimedDesktopFlow{
		device: device, executorID: executorID, session: session,
		handoffID: handoff.HandoffID, claimToken: claim.ClaimToken,
	}
}

func signedDesktopAuthorizationProof(
	t *testing.T,
	device bindingDeviceFixture,
	claimToken, sessionID, handoffID string,
	sessionRevision int64,
	loginIDHash, result string,
	checkedAt time.Time,
	accountFingerprint, bindingDigest, nonce string,
	sequence uint64,
	bodyOverride []byte,
) signedActivationRequest {
	t.Helper()
	body := bodyOverride
	if body == nil {
		body = []byte(fmt.Sprintf(`{"handoffId":%q,"sessionRevision":%d,"loginIdHash":%q,"result":%q,"checkedAt":%q,"accountFingerprint":%q,"candidateBindingDigest":%q}`,
			handoffID, sessionRevision, loginIDHash, result, checkedAt.UTC().Format(time.RFC3339Nano),
			accountFingerprint, bindingDigest))
	}
	path := "/api/v1/ai-executor-authorization-sessions/" + sessionID + "/desktop-proofs"
	return signedActivationDeviceRequest(t, device, "POST", path, body,
		"AiCRM-Claim "+claimToken, "AiCRM-Claim", checkedAt, nonce, sequence)
}

func signedDesktopActivationACK(
	t *testing.T,
	device bindingDeviceFixture,
	activationToken, sessionID string,
	activation desktopactivation.ActivationResult,
	barrierAt time.Time,
	nonce string,
	sequence uint64,
	bodyOverride []byte,
) signedActivationRequest {
	t.Helper()
	body := bodyOverride
	if body == nil {
		body = []byte(fmt.Sprintf(`{"operationId":%q,"activationId":%q,"credentialRevision":%d,"leaseEpoch":%d,"sourceCredentialRevision":%d,"revocationEpoch":%d,"durableBarrierCompletedAt":%q,"bindingDigest":%q}`,
			activation.OperationID, activation.ActivationID, activation.CredentialRevision,
			activation.LeaseEpoch, activation.SourceCredentialRevision, activation.RevocationEpoch,
			barrierAt.UTC().Format(time.RFC3339Nano), activation.BindingDigest))
	}
	path := "/api/v1/ai-executor-authorization-sessions/" + sessionID +
		"/desktop-activations/" + activation.ActivationID + "/ack"
	return signedActivationDeviceRequest(t, device, "POST", path, body,
		"AiCRM-Activation "+activationToken, "AiCRM-Activation", barrierAt, nonce, sequence)
}

func signedActivationDeviceRequest(
	t *testing.T,
	device bindingDeviceFixture,
	method, path string,
	body []byte,
	authorization, scheme string,
	timestamp time.Time,
	nonce string,
	sequence uint64,
) signedActivationRequest {
	t.Helper()
	authorizationHash, err := deviceauth.AuthorizationTokenHash(authorization, []string{scheme})
	if err != nil {
		t.Fatal(err)
	}
	headers := deviceauth.ProofHeaders{
		DeviceID: device.deviceID, TimestampMilli: timestamp.UnixMilli(), Nonce: nonce,
		Sequence: sequence, BodySHA256: deviceauth.HashBody(body),
	}
	input, err := deviceauth.SigningInput(method, path, headers, authorizationHash)
	if err != nil {
		t.Fatal(err)
	}
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(device.privateKey, input))
	httpHeaders := make(http.Header)
	httpHeaders.Set(deviceauth.HeaderDeviceID, device.deviceID)
	httpHeaders.Set(deviceauth.HeaderTimestamp, fmt.Sprintf("%d", timestamp.UnixMilli()))
	httpHeaders.Set(deviceauth.HeaderNonce, nonce)
	httpHeaders.Set(deviceauth.HeaderSequence, fmt.Sprintf("%d", sequence))
	httpHeaders.Set(deviceauth.HeaderContentSHA256, deviceauth.HashBody(body))
	httpHeaders.Set(deviceauth.HeaderSignature, signature)
	httpHeaders.Set("Authorization", authorization)
	verified, err := deviceauth.VerifyRequest(deviceauth.VerifyInput{
		PublicKey: device.publicKey, Method: method, RequestTarget: path,
		Headers: httpHeaders, Body: body, AllowedAuthorizationSchemes: []string{scheme}, Now: timestamp,
	})
	if err != nil {
		t.Fatal(err)
	}
	return signedActivationRequest{verified: verified, signature: signature}
}

func assertDesktopPreparedState(t *testing.T, ctx context.Context, db *sql.DB, flow claimedDesktopFlow, result desktopactivation.SubmitProofResult) {
	t.Helper()
	var sessionStatus, handoffStatus, bindingStatus, activationStatus, leaseStatus, eventStatus string
	var sessionRevision, sessionSequence, credentialRevision, leaseEpoch, proofCount, ledgerCount int64
	if err := db.QueryRowContext(ctx, `
		SELECT session.status,session.revision,session.current_sequence,handoff.status,
		 binding.status,binding.revision,activation.status,lease.status,lease.lease_epoch,
		 event.safe_payload_json #>> '{session,status}',
		 (SELECT count(*) FROM ky_ai_executor_desktop_authorization_proof WHERE handoff_id=handoff.id),
		 (SELECT count(*) FROM ky_ai_executor_device_request_ledger WHERE device_id=$3 AND sequence=2)
		FROM ky_ai_executor_authorization_session session
		JOIN ky_ai_executor_desktop_handoff handoff ON handoff.session_id=session.id
		JOIN ky_ai_executor_credential_activation activation ON activation.session_id=session.id
		JOIN ky_ai_executor_credential_binding binding ON binding.executor_id=session.executor_id
		 AND binding.revision=activation.credential_revision
		JOIN ky_ai_executor_operation_lease lease ON lease.executor_id=session.executor_id
		JOIN ky_ai_executor_authorization_session_event event ON event.session_id=session.id AND event.sequence=3
		WHERE session.id=$1 AND activation.id=$2
	`, flow.session.ID, result.Activation.ActivationID, flow.device.deviceID).Scan(
		&sessionStatus, &sessionRevision, &sessionSequence, &handoffStatus,
		&bindingStatus, &credentialRevision, &activationStatus, &leaseStatus, &leaseEpoch,
		&eventStatus, &proofCount, &ledgerCount); err != nil {
		t.Fatal(err)
	}
	if sessionStatus != "verifying" || sessionRevision != 3 || sessionSequence != 3 ||
		handoffStatus != "proof_submitted" || bindingStatus != "prepared" ||
		credentialRevision != result.Activation.CredentialRevision || activationStatus != "pending" ||
		leaseStatus != "active" || leaseEpoch != result.Activation.LeaseEpoch ||
		eventStatus != "verifying" || proofCount != 1 || ledgerCount != 1 {
		t.Fatalf("prepared state session=%s/%d/%d handoff=%s binding=%s/%d activation=%s lease=%s/%d event=%s proof=%d ledger=%d",
			sessionStatus, sessionRevision, sessionSequence, handoffStatus, bindingStatus,
			credentialRevision, activationStatus, leaseStatus, leaseEpoch, eventStatus, proofCount, ledgerCount)
	}
}

func assertDesktopActivatedState(t *testing.T, ctx context.Context, db *sql.DB, flow claimedDesktopFlow, proof desktopactivation.SubmitProofResult, ack desktopactivation.AcknowledgeResult) {
	t.Helper()
	var sessionStatus, credentialStatus, bindingStatus, activationStatus, leaseStatus string
	var sessionRevision, sessionSequence, currentRevision, auditCount, ledgerCount int64
	if err := db.QueryRowContext(ctx, `
		SELECT session.status,session.revision,session.current_sequence,config.credential_status,
		 config.current_credential_revision,binding.status,activation.status,lease.status,
		 (SELECT count(*) FROM ky_ai_executor_credential_activation_audit WHERE activation_id=activation.id),
		 (SELECT count(*) FROM ky_ai_executor_device_request_ledger WHERE device_id=$3)
		FROM ky_ai_executor_authorization_session session
		JOIN ky_ai_executor_config config ON config.id=session.executor_id
		JOIN ky_ai_executor_credential_activation activation ON activation.session_id=session.id
		JOIN ky_ai_executor_credential_binding binding ON binding.executor_id=session.executor_id
		 AND binding.revision=activation.credential_revision
		JOIN ky_ai_executor_operation_lease lease ON lease.executor_id=session.executor_id
		WHERE session.id=$1 AND activation.id=$2
	`, flow.session.ID, proof.Activation.ActivationID, flow.device.deviceID).Scan(
		&sessionStatus, &sessionRevision, &sessionSequence, &credentialStatus,
		&currentRevision, &bindingStatus, &activationStatus, &leaseStatus,
		&auditCount, &ledgerCount); err != nil {
		t.Fatal(err)
	}
	if sessionStatus != "succeeded" || sessionRevision != ack.SessionRevision || sessionSequence != 6 ||
		credentialStatus != "authorized" || currentRevision != ack.CredentialRevision ||
		bindingStatus != "active" || activationStatus != "active" || leaseStatus != "released" ||
		auditCount != 2 || ledgerCount != 3 {
		t.Fatalf("activated state session=%s/%d/%d config=%s/%d binding=%s activation=%s lease=%s audit=%d ledger=%d",
			sessionStatus, sessionRevision, sessionSequence, credentialStatus, currentRevision,
			bindingStatus, activationStatus, leaseStatus, auditCount, ledgerCount)
	}
}

func assertAlteredDesktopProofs(t *testing.T, ctx context.Context, manager *desktopactivation.Manager, flow claimedDesktopFlow, original desktopactivation.SubmitProofInput, at time.Time) {
	t.Helper()
	for _, alteration := range []string{"body", "nonce", "token"} {
		changed := original
		token := original.ClaimToken
		nonce := desktopNonce(22)
		body := []byte(`{"altered":"body"}`)
		if alteration == "nonce" {
			nonce = desktopNonce(66)
			body = nil
		}
		if alteration == "token" {
			token = "altered-claim-token-canary"
			body = nil
		}
		changed.ClaimToken = token
		changed.Proof = signedDesktopAuthorizationProof(t, flow.device, token, flow.session.ID,
			flow.handoffID, flow.session.Revision, original.LoginIDHash, original.Result, at,
			original.AccountFingerprint, original.CandidateBindingDigest, nonce, 2, body).verified
		if _, err := manager.SubmitProof(ctx, changed); !errors.Is(err, store.ErrDeviceProofReplayed) {
			t.Fatalf("altered proof %s error=%v", alteration, err)
		}
	}
	changedSequence := original
	changedSequence.Proof = signedDesktopAuthorizationProof(t, flow.device, original.ClaimToken,
		flow.session.ID, flow.handoffID, flow.session.Revision, original.LoginIDHash, original.Result,
		at, original.AccountFingerprint, original.CandidateBindingDigest, desktopNonce(67), 3, nil).verified
	if _, err := manager.SubmitProof(ctx, changedSequence); !errors.Is(err, store.ErrDesktopProofConflict) {
		t.Fatalf("altered proof sequence error=%v", err)
	}
}

func assertAlteredDesktopACKs(t *testing.T, ctx context.Context, manager *desktopactivation.Manager, flow claimedDesktopFlow, proof desktopactivation.SubmitProofResult, original desktopactivation.AcknowledgeInput, at time.Time) {
	t.Helper()
	for _, alteration := range []string{"body", "nonce", "token"} {
		changed := original
		token := original.ActivationToken
		nonce := desktopNonce(23)
		body := []byte(`{"altered":"ack"}`)
		if alteration == "nonce" {
			nonce = desktopNonce(68)
			body = nil
		}
		if alteration == "token" {
			token = "altered-activation-token-canary"
			body = nil
		}
		changed.ActivationToken = token
		changed.Proof = signedDesktopActivationACK(t, flow.device, token, flow.session.ID,
			*proof.Activation, at, nonce, 3, body).verified
		if _, err := manager.Acknowledge(ctx, changed); !errors.Is(err, store.ErrDeviceProofReplayed) {
			t.Fatalf("altered ACK %s error=%v", alteration, err)
		}
	}
	changedSequence := original
	changedSequence.Proof = signedDesktopActivationACK(t, flow.device, original.ActivationToken,
		flow.session.ID, *proof.Activation, at, desktopNonce(69), 4, nil).verified
	if _, err := manager.Acknowledge(ctx, changedSequence); !errors.Is(err, store.ErrDesktopActivationConflict) {
		t.Fatalf("altered ACK sequence error=%v", err)
	}
}

func testTerminalDesktopProofs(t *testing.T, ctx context.Context, db *sql.DB, control *store.ControlStore, handoffManager *desktophandoff.Manager, activationManager *desktopactivation.Manager, actorID, suffix string) {
	t.Helper()
	for index, resultName := range []string{"failed", "cancelled"} {
		flow := seedClaimedDesktopFlow(t, ctx, db, control, handoffManager, actorID,
			resultName+"_"+suffix, byte(31+index*7), "authorize", "")
		checkedAt := time.Now().UTC().Truncate(time.Millisecond)
		signed := signedDesktopAuthorizationProof(t, flow.device, flow.claimToken, flow.session.ID,
			flow.handoffID, flow.session.Revision, desktopDigest(resultName+suffix), resultName,
			checkedAt, "", "", desktopNonce(2), 2, nil)
		input := desktopactivation.SubmitProofInput{
			ClaimToken: flow.claimToken, SessionID: flow.session.ID, HandoffID: flow.handoffID,
			TargetDeviceID: flow.device.deviceID, KeyGeneration: 1,
			SessionRevision: flow.session.Revision, LoginIDHash: desktopDigest(resultName + suffix),
			Result: resultName, CheckedAt: checkedAt, Proof: signed.verified,
			LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
		}
		first, err := activationManager.SubmitProof(ctx, input)
		if err != nil || first.Result != resultName || first.Activation != nil || first.SessionRevision != 3 {
			t.Fatalf("terminal proof result=%#v err=%v", first, err)
		}
		replay, err := activationManager.SubmitProof(ctx, input)
		if err != nil || !replay.Replayed || replay.ProofID != first.ProofID {
			t.Fatalf("terminal replay=%#v err=%v", replay, err)
		}
		var status string
		var credentialCount, activationCount, eventCount int
		if err := db.QueryRowContext(ctx, `
			SELECT status,
			 (SELECT count(*) FROM ky_ai_executor_credential_binding WHERE authorization_session_id=$1),
			 (SELECT count(*) FROM ky_ai_executor_credential_activation WHERE session_id=$1),
			 (SELECT count(*) FROM ky_ai_executor_authorization_session_event WHERE session_id=$1)
			FROM ky_ai_executor_authorization_session WHERE id=$1
		`, flow.session.ID).Scan(&status, &credentialCount, &activationCount, &eventCount); err != nil {
			t.Fatal(err)
		}
		if status != resultName || credentialCount != 0 || activationCount != 0 || eventCount != 5 {
			t.Fatalf("terminal state status=%s credentials=%d activations=%d events=%d",
				status, credentialCount, activationCount, eventCount)
		}
	}
}

func testDesktopActivationFences(t *testing.T, ctx context.Context, db *sql.DB, control *store.ControlStore, handoffManager *desktophandoff.Manager, activationManager *desktopactivation.Manager, signer *trustedtoken.Signer, nonceSecret []byte, actorID, suffix string) {
	t.Helper()
	flow := seedClaimedDesktopFlow(t, ctx, db, control, handoffManager, actorID,
		"fence_"+suffix, 57, "authorize", "")
	checkedAt := time.Now().UTC().Truncate(time.Millisecond)
	proofSigned := signedDesktopAuthorizationProof(t, flow.device, flow.claimToken, flow.session.ID,
		flow.handoffID, 2, desktopDigest("fence-login-"+suffix), "succeeded", checkedAt,
		desktopDigest("fence-account-"+suffix), desktopDigest("fence-binding-"+suffix),
		desktopNonce(2), 2, nil)
	proof, err := activationManager.SubmitProof(ctx, desktopactivation.SubmitProofInput{
		ClaimToken: flow.claimToken, SessionID: flow.session.ID, HandoffID: flow.handoffID,
		TargetDeviceID: flow.device.deviceID, KeyGeneration: 1, SessionRevision: 2,
		LoginIDHash: desktopDigest("fence-login-" + suffix), Result: "succeeded", CheckedAt: checkedAt,
		AccountFingerprint:     desktopDigest("fence-account-" + suffix),
		CandidateBindingDigest: desktopDigest("fence-binding-" + suffix), Proof: proofSigned.verified,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_operation_lease SET lease_expires_at=transaction_timestamp()-interval '1 second'
		WHERE executor_id=$1
	`, flow.executorID); err != nil {
		t.Fatal(err)
	}
	barrier := time.Now().UTC().Truncate(time.Millisecond)
	ackSigned := signedDesktopActivationACK(t, flow.device, proof.Activation.ActivationToken,
		flow.session.ID, *proof.Activation, barrier, desktopNonce(3), 3, nil)
	ack := desktopactivation.AcknowledgeInput{
		ActivationToken: proof.Activation.ActivationToken, SessionID: flow.session.ID,
		ActivationID: proof.Activation.ActivationID, TargetDeviceID: flow.device.deviceID,
		KeyGeneration: 1, OperationID: proof.Activation.OperationID,
		CredentialRevision: proof.Activation.CredentialRevision, LeaseEpoch: proof.Activation.LeaseEpoch,
		SourceCredentialRevision:  proof.Activation.SourceCredentialRevision,
		RevocationEpoch:           proof.Activation.RevocationEpoch,
		DurableBarrierCompletedAt: barrier, BindingDigest: proof.Activation.BindingDigest,
		Proof:           ackSigned.verified,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	}
	if _, err := activationManager.Acknowledge(ctx, ack); !errors.Is(err, store.ErrExecutorFenced) {
		t.Fatalf("expired lease ACK error=%v", err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_operation_lease
		SET operation_id=$2,owner_instance_id=$3,lease_epoch=lease_epoch+1,
		    lease_expires_at=transaction_timestamp()+interval '30 seconds',status='active'
		WHERE executor_id=$1
	`, flow.executorID, "takeover_operation_"+suffix, "takeover_owner_"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err := activationManager.Acknowledge(ctx, ack); !errors.Is(err, store.ErrExecutorFenced) {
		t.Fatalf("taken-over lease ACK error=%v", err)
	}
	var activationStatus, sessionStatus string
	var activatedAudit, ackLedger int
	if err := db.QueryRowContext(ctx, `
		SELECT activation.status,session.status,
		 (SELECT count(*) FROM ky_ai_executor_credential_activation_audit WHERE activation_id=activation.id AND event_type='activated'),
		 (SELECT count(*) FROM ky_ai_executor_device_request_ledger WHERE device_id=$3 AND sequence=3)
		FROM ky_ai_executor_credential_activation activation
		JOIN ky_ai_executor_authorization_session session ON session.id=activation.session_id
		WHERE activation.id=$1 AND session.id=$2
	`, proof.Activation.ActivationID, flow.session.ID, flow.device.deviceID).Scan(
		&activationStatus, &sessionStatus, &activatedAudit, &ackLedger); err != nil {
		t.Fatal(err)
	}
	if activationStatus != "pending" || sessionStatus != "verifying" || activatedAudit != 0 || ackLedger != 0 {
		t.Fatalf("fenced ACK leaked activation=%s session=%s audit=%d ledger=%d",
			activationStatus, sessionStatus, activatedAudit, ackLedger)
	}

	// A database-clock-expired claim token is rejected before any new ledger
	// or state mutation. Rebuild a valid old JWS and freeze its digest metadata.
	expiredFlow := seedClaimedDesktopFlow(t, ctx, db, control, handoffManager, actorID,
		"expired_claim_"+suffix, 71, "authorize", "")
	expiredIssued := time.Now().UTC().Add(-10 * time.Minute).Truncate(time.Second)
	expiredClaim := issueClaimTokenForTest(t, signer, nonceSecret, expiredFlow, expiredIssued)
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_desktop_handoff
		SET claim_token_hash=$2,claim_token_key_id=$3,claim_token_nonce_hash=$4,
		    claim_token_issued_at=$5,claim_expires_at=$6
		WHERE id=$1
	`, expiredFlow.handoffID, trustedtoken.Hash(expiredClaim.token), signer.KeyID(),
		desktopDigest(expiredClaim.nonce), expiredIssued,
		expiredIssued.Add(5*time.Minute)); err != nil {
		t.Fatal(err)
	}
	expiredAt := time.Now().UTC().Truncate(time.Millisecond)
	expiredProofSigned := signedDesktopAuthorizationProof(t, expiredFlow.device, expiredClaim.token,
		expiredFlow.session.ID, expiredFlow.handoffID, 2, desktopDigest("expired-login-"+suffix),
		"failed", expiredAt, "", "", desktopNonce(2), 2, nil)
	if _, err := activationManager.SubmitProof(ctx, desktopactivation.SubmitProofInput{
		ClaimToken: expiredClaim.token, SessionID: expiredFlow.session.ID,
		HandoffID: expiredFlow.handoffID, TargetDeviceID: expiredFlow.device.deviceID,
		KeyGeneration: 1, SessionRevision: 2, LoginIDHash: desktopDigest("expired-login-" + suffix),
		Result: "failed", CheckedAt: expiredAt, Proof: expiredProofSigned.verified,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	}); !errors.Is(err, trustedtoken.ErrExpired) {
		t.Fatalf("expired claim token error=%v", err)
	}
}

type testToken struct {
	token string
	nonce string
}

func issueClaimTokenForTest(t *testing.T, signer *trustedtoken.Signer, secret []byte, flow claimedDesktopFlow, issuedAt time.Time) testToken {
	t.Helper()
	nonce := deterministicClassNonce(secret, "aicrm-desktop-handoff-claim-token-nonce-v1\n", flow.handoffID)
	claims, err := trustedtoken.NewClaims(trustedtoken.AudienceClaim,
		trustedtoken.PurposeAuthorizationClaim, flow.handoffID, nonce, issuedAt)
	if err != nil {
		t.Fatal(err)
	}
	claims.SessionID, claims.ExecutorID, claims.DeviceID = flow.session.ID, flow.executorID, flow.device.deviceID
	claims.HandoffID = flow.handoffID
	revision := int64(2)
	claims.ExpectedSessionRevision = &revision
	token, err := signer.Issue(claims)
	if err != nil {
		t.Fatal(err)
	}
	return testToken{token: token, nonce: nonce}
}

func deterministicClassNonce(secret []byte, domain, id string) string {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(domain + id))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:16])
}

func prepareDesktopActivationFixture(
	t *testing.T,
	ctx context.Context,
	db *sql.DB,
	control *store.ControlStore,
	handoffManager *desktophandoff.Manager,
	activationManager *desktopactivation.Manager,
	actorID, label string,
	seedByte byte,
	intent, activeFingerprint, candidateFingerprint string,
) (claimedDesktopFlow, desktopactivation.SubmitProofResult) {
	t.Helper()
	flow := seedClaimedDesktopFlow(t, ctx, db, control, handoffManager,
		actorID, label, seedByte, intent, activeFingerprint)
	checkedAt := time.Now().UTC().Truncate(time.Millisecond)
	loginHash := desktopDigest("login-" + label)
	bindingDigest := desktopDigest("binding-" + label)
	signed := signedDesktopAuthorizationProof(t, flow.device, flow.claimToken, flow.session.ID,
		flow.handoffID, flow.session.Revision, loginHash, "succeeded", checkedAt,
		candidateFingerprint, bindingDigest, desktopNonce(2), 2, nil)
	proof, err := activationManager.SubmitProof(ctx, desktopactivation.SubmitProofInput{
		ClaimToken: flow.claimToken, SessionID: flow.session.ID, HandoffID: flow.handoffID,
		TargetDeviceID: flow.device.deviceID, KeyGeneration: 1,
		SessionRevision: flow.session.Revision, LoginIDHash: loginHash,
		Result: "succeeded", CheckedAt: checkedAt, AccountFingerprint: candidateFingerprint,
		CandidateBindingDigest: bindingDigest, Proof: signed.verified,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	return flow, proof
}

func desktopACKInputForFixture(
	t *testing.T,
	flow claimedDesktopFlow,
	proof desktopactivation.SubmitProofResult,
	token string,
	barrier time.Time,
) desktopactivation.AcknowledgeInput {
	t.Helper()
	signed := signedDesktopActivationACK(t, flow.device, token, flow.session.ID,
		*proof.Activation, barrier, desktopNonce(3), 3, nil)
	return desktopactivation.AcknowledgeInput{
		ActivationToken: token, SessionID: flow.session.ID,
		ActivationID: proof.Activation.ActivationID, TargetDeviceID: flow.device.deviceID,
		KeyGeneration: 1, OperationID: proof.Activation.OperationID,
		CredentialRevision:        proof.Activation.CredentialRevision,
		LeaseEpoch:                proof.Activation.LeaseEpoch,
		SourceCredentialRevision:  proof.Activation.SourceCredentialRevision,
		RevocationEpoch:           proof.Activation.RevocationEpoch,
		DurableBarrierCompletedAt: barrier, BindingDigest: proof.Activation.BindingDigest,
		Proof:           signed.verified,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	}
}

func testDesktopActivationInterleavingWinners(
	t *testing.T,
	ctx context.Context,
	db *sql.DB,
	control *store.ControlStore,
	handoffManager *desktophandoff.Manager,
	activationManager *desktopactivation.Manager,
	actorID, suffix string,
) {
	t.Helper()

	cancelFlow, cancelProof := prepareDesktopActivationFixture(t, ctx, db, control,
		handoffManager, activationManager, actorID, "cancel_winner_"+suffix, 91,
		"authorize", "", desktopDigest("cancel-account-"+suffix))
	if _, transitioned, err := control.CancelAuthorizationSession(ctx, store.CancelAuthorizationInput{
		SessionID: cancelFlow.session.ID, ActorID: actorID,
		ExpectedRevision:   cancelProof.SessionRevision,
		IdempotencyKeyHash: desktopDigest("cancel-winner-key-" + suffix),
		RequestHash:        desktopDigest("cancel-winner-body-" + suffix),
	}); err != nil || !transitioned {
		t.Fatalf("cancel winner transition=%v err=%v", transitioned, err)
	}
	cancelBarrier := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := activationManager.Acknowledge(ctx,
		desktopACKInputForFixture(t, cancelFlow, cancelProof,
			cancelProof.Activation.ActivationToken, cancelBarrier)); !errors.Is(err, store.ErrRevisionConflict) {
		t.Fatalf("cancel-winner late ACK error=%v", err)
	}

	revokeFlow, revokeProof := prepareDesktopActivationFixture(t, ctx, db, control,
		handoffManager, activationManager, actorID, "revoke_winner_"+suffix, 97,
		"authorize", "", desktopDigest("revoke-account-"+suffix))
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_config
		SET revocation_epoch=revocation_epoch+1,credential_status='revoked',updated_at=transaction_timestamp()
		WHERE id=$1
	`, revokeFlow.executorID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_operation_lease SET status='fenced',updated_at=transaction_timestamp()
		WHERE executor_id=$1
	`, revokeFlow.executorID); err != nil {
		t.Fatal(err)
	}
	revokeBarrier := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := activationManager.Acknowledge(ctx,
		desktopACKInputForFixture(t, revokeFlow, revokeProof,
			revokeProof.Activation.ActivationToken, revokeBarrier)); !errors.Is(err, store.ErrExecutorFenced) {
		t.Fatalf("revoke-winner late ACK error=%v", err)
	}

	rebindFlow, rebindProof := prepareDesktopActivationFixture(t, ctx, db, control,
		handoffManager, activationManager, actorID, "rebind_winner_"+suffix, 103,
		"authorize", "", desktopDigest("rebind-account-"+suffix))
	newDevice := newBindingDeviceFixture(t, 104)
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_device (
		 id,public_key,status,label,registered_by,workspace_type,workspace_id,last_heartbeat_at
		) VALUES ($1,$2,'active','rebind-winner',$3,'platform','platform_root',transaction_timestamp())
	`, newDevice.deviceID, newDevice.publicKey, actorID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_device_binding
		SET device_id=$2,revision=revision+1,updated_at=transaction_timestamp()
		WHERE executor_id=$1 AND status='active'
	`, rebindFlow.executorID, newDevice.deviceID); err != nil {
		t.Fatal(err)
	}
	rebindBarrier := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := activationManager.Acknowledge(ctx,
		desktopACKInputForFixture(t, rebindFlow, rebindProof,
			rebindProof.Activation.ActivationToken, rebindBarrier)); !errors.Is(err, store.ErrDesktopHandoffTargetMismatch) {
		t.Fatalf("rebind-winner late ACK error=%v", err)
	}

	for _, proof := range []desktopactivation.SubmitProofResult{cancelProof, revokeProof, rebindProof} {
		var status string
		var activatedAudits int
		if err := db.QueryRowContext(ctx, `
			SELECT status,(SELECT count(*) FROM ky_ai_executor_credential_activation_audit
			 WHERE activation_id=$1 AND event_type='activated')
			FROM ky_ai_executor_credential_activation WHERE id=$1
		`, proof.Activation.ActivationID).Scan(&status, &activatedAudits); err != nil {
			t.Fatal(err)
		}
		if status != "pending" || activatedAudits != 0 {
			t.Fatalf("race winner leaked activation status=%s audits=%d", status, activatedAudits)
		}
	}
}

func testExpiredDesktopActivationToken(
	t *testing.T,
	ctx context.Context,
	db *sql.DB,
	control *store.ControlStore,
	handoffManager *desktophandoff.Manager,
	activationManager *desktopactivation.Manager,
	signer *trustedtoken.Signer,
	nonceSecret []byte,
	actorID, suffix string,
) {
	t.Helper()
	flow := seedClaimedDesktopFlow(t, ctx, db, control, handoffManager,
		actorID, "expired_activation_"+suffix, 111, "authorize", "")
	activation := desktopactivation.ActivationResult{
		ActivationID:       "desktop_activation_expired_" + suffix,
		OperationID:        "desktop_operation_expired_" + suffix,
		CredentialRevision: 1, LeaseEpoch: 1, SourceCredentialRevision: 0,
		RevocationEpoch: 0, BindingDigest: desktopDigest("expired-activation-binding-" + suffix),
	}
	issuedAt := time.Now().UTC().Add(-20 * time.Minute).Truncate(time.Second)
	expired := issueActivationTokenForTest(t, signer, nonceSecret, flow, activation, issuedAt)
	proofID := "desktop_proof_expired_" + suffix
	proofRequestHash := desktopDigest("expired-activation-proof-request-" + suffix)
	checkedAt := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_desktop_handoff
		SET status='proof_submitted',claim_consumed_at=transaction_timestamp()
		WHERE id=$1 AND status='claimed';
	`, flow.handoffID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_device SET last_accepted_sequence=2 WHERE id=$1
	`, flow.device.deviceID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_desktop_authorization_proof (
		 id,session_id,handoff_id,executor_id,device_id,session_revision,login_id_hash,
		 result,account_fingerprint,candidate_binding_digest,request_hash,checked_at,
		 claim_token_hash,device_key_generation,device_sequence,response_reference,
		 response_session_revision
		) VALUES ($1,$2,$3,$4,$5,2,$6,'succeeded',$7,$8,$9,$10,$11,1,2,$12,3)
	`, proofID, flow.session.ID, flow.handoffID, flow.executorID, flow.device.deviceID,
		desktopDigest("expired-activation-login-"+suffix),
		desktopDigest("expired-activation-account-"+suffix), activation.BindingDigest,
		proofRequestHash, checkedAt, trustedtoken.Hash(flow.claimToken),
		"desktop_proof_"+flow.handoffID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_authorization_session
		SET status='verifying',login_id_hash=$2,prepared_credential_revision=1,
		    operation_id=$3,revision=3,current_sequence=3
		WHERE id=$1
	`, flow.session.ID, desktopDigest("expired-activation-login-"+suffix), activation.OperationID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_config SET credential_revision_counter=1 WHERE id=$1
	`, flow.executorID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_operation_lease (
		 executor_id,operation_id,owner_instance_id,lease_epoch,lease_expires_at,
		 source_credential_revision,revocation_epoch,status
		) VALUES ($1,$2,$3,1,transaction_timestamp()+interval '30 seconds',0,0,'active')
	`, flow.executorID, activation.OperationID, "desktop_"+flow.device.deviceID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_credential_binding (
		 executor_id,revision,status,authorization_session_id,runtime_type,runtime_binding_id,
		 runtime_binding_revision,device_id,account_fingerprint,auth_mode,binding_digest,
		 revocation_epoch,verified_at,operation_id,lease_epoch,source_credential_revision,digest_algorithm
		) VALUES ($1,1,'prepared',$2,'desktop',$3,1,$3,$4,'browser',$5,0,$6,$7,1,0,$8)
	`, flow.executorID, flow.session.ID, flow.device.deviceID,
		desktopDigest("expired-activation-account-"+suffix), activation.BindingDigest,
		checkedAt, activation.OperationID, "aicrm-credential-tree-rfc8785-nfc-v1"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_credential_activation (
		 id,session_id,proof_id,executor_id,device_id,operation_id,credential_revision,
		 lease_epoch,source_credential_revision,revocation_epoch,binding_digest,
		 activation_token_hash,request_hash,status,issued_at,expires_at,
		 device_binding_revision,activation_token_key_id,activation_token_nonce_hash
		) VALUES ($1,$2,$3,$4,$5,$6,1,1,0,0,$7,$8,$9,'pending',$10,$11,1,$12,$13)
	`, activation.ActivationID, flow.session.ID, proofID, flow.executorID, flow.device.deviceID,
		activation.OperationID, activation.BindingDigest, trustedtoken.Hash(expired.token),
		proofRequestHash, issuedAt, issuedAt.Add(store.DesktopActivationLifetime),
		signer.KeyID(), desktopDigest(expired.nonce)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_credential_activation_audit (
		 activation_id,sequence,event_type,session_id,proof_id,executor_id,device_id,
		 operation_id,credential_revision,lease_epoch,source_credential_revision,
		 revocation_epoch,binding_digest,request_hash,occurred_at
		) VALUES ($1,1,'prepared',$2,$3,$4,$5,$6,1,1,0,0,$7,$8,transaction_timestamp())
	`, activation.ActivationID, flow.session.ID, proofID, flow.executorID,
		flow.device.deviceID, activation.OperationID, activation.BindingDigest, proofRequestHash); err != nil {
		t.Fatal(err)
	}
	barrier := time.Now().UTC().Truncate(time.Millisecond)
	proofResult := desktopactivation.SubmitProofResult{Activation: &activation}
	ack := desktopACKInputForFixture(t, flow, proofResult, expired.token, barrier)
	if _, err := activationManager.Acknowledge(ctx, ack); !errors.Is(err, trustedtoken.ErrExpired) {
		t.Fatalf("expired activation token error=%v", err)
	}
	var status string
	var ledger int
	if err := db.QueryRowContext(ctx, `
		SELECT status,(SELECT count(*) FROM ky_ai_executor_device_request_ledger
		 WHERE device_id=$2 AND sequence=3)
		FROM ky_ai_executor_credential_activation WHERE id=$1
	`, activation.ActivationID, flow.device.deviceID).Scan(&status, &ledger); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || ledger != 0 {
		t.Fatalf("expired activation mutated status=%s ledger=%d", status, ledger)
	}
}

func issueActivationTokenForTest(
	t *testing.T,
	signer *trustedtoken.Signer,
	secret []byte,
	flow claimedDesktopFlow,
	activation desktopactivation.ActivationResult,
	issuedAt time.Time,
) testToken {
	t.Helper()
	nonce := deterministicClassNonce(secret, "aicrm-desktop-activation-nonce-v1\n", activation.ActivationID)
	claims, err := trustedtoken.NewClaims(trustedtoken.AudienceActivation,
		trustedtoken.PurposeCredentialActivation, activation.ActivationID, nonce, issuedAt)
	if err != nil {
		t.Fatal(err)
	}
	claims.SessionID, claims.ExecutorID, claims.DeviceID = flow.session.ID, flow.executorID, flow.device.deviceID
	claims.OperationID, claims.ActivationID = activation.OperationID, activation.ActivationID
	claims.BindingDigest = activation.BindingDigest
	credentialRevision := activation.CredentialRevision
	leaseEpoch := activation.LeaseEpoch
	sourceRevision := activation.SourceCredentialRevision
	revocationEpoch := activation.RevocationEpoch
	claims.CredentialRevision = &credentialRevision
	claims.LeaseEpoch = &leaseEpoch
	claims.SourceCredentialRevision = &sourceRevision
	claims.RevocationEpoch = &revocationEpoch
	token, err := signer.Issue(claims)
	if err != nil {
		t.Fatal(err)
	}
	return testToken{token: token, nonce: nonce}
}

func testDesktopAccountIntentAndSwap(
	t *testing.T,
	ctx context.Context,
	db *sql.DB,
	control *store.ControlStore,
	handoffManager *desktophandoff.Manager,
	activationManager *desktopactivation.Manager,
	actorID, suffix string,
) {
	t.Helper()
	oldFingerprint := desktopDigest("intent-old-account-" + suffix)
	sameFlow := seedClaimedDesktopFlow(t, ctx, db, control, handoffManager, actorID,
		"same_account_"+suffix, 117, "change_account", oldFingerprint)
	checkedAt := time.Now().UTC().Truncate(time.Millisecond)
	sameSigned := signedDesktopAuthorizationProof(t, sameFlow.device, sameFlow.claimToken,
		sameFlow.session.ID, sameFlow.handoffID, 2, desktopDigest("same-login-"+suffix),
		"succeeded", checkedAt, oldFingerprint, desktopDigest("same-binding-"+suffix),
		desktopNonce(2), 2, nil)
	if _, err := activationManager.SubmitProof(ctx, desktopactivation.SubmitProofInput{
		ClaimToken: sameFlow.claimToken, SessionID: sameFlow.session.ID, HandoffID: sameFlow.handoffID,
		TargetDeviceID: sameFlow.device.deviceID, KeyGeneration: 1, SessionRevision: 2,
		LoginIDHash: desktopDigest("same-login-" + suffix), Result: "succeeded", CheckedAt: checkedAt,
		AccountFingerprint:     oldFingerprint,
		CandidateBindingDigest: desktopDigest("same-binding-" + suffix), Proof: sameSigned.verified,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	}); !errors.Is(err, store.ErrDesktopAccountIntentConflict) {
		t.Fatalf("same-account change proof error=%v", err)
	}

	driftFingerprint := desktopDigest("drift-old-account-" + suffix)
	proofDriftFlow := seedClaimedDesktopFlow(t, ctx, db, control, handoffManager, actorID,
		"proof_config_drift_"+suffix, 121, "change_account", driftFingerprint)
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_config
		SET runtime_binding_id=$2,runtime_binding_revision=2
		WHERE id=$1
	`, proofDriftFlow.executorID, desktopDigest("proof-drift-device-"+suffix)); err != nil {
		t.Fatal(err)
	}
	driftCheckedAt := time.Now().UTC().Truncate(time.Millisecond)
	driftSigned := signedDesktopAuthorizationProof(t, proofDriftFlow.device, proofDriftFlow.claimToken,
		proofDriftFlow.session.ID, proofDriftFlow.handoffID, 2,
		desktopDigest("proof-drift-login-"+suffix), "succeeded", driftCheckedAt,
		desktopDigest("proof-drift-new-account-"+suffix), desktopDigest("proof-drift-binding-"+suffix),
		desktopNonce(2), 2, nil)
	if _, err := activationManager.SubmitProof(ctx, desktopactivation.SubmitProofInput{
		ClaimToken: proofDriftFlow.claimToken, SessionID: proofDriftFlow.session.ID,
		HandoffID: proofDriftFlow.handoffID, TargetDeviceID: proofDriftFlow.device.deviceID,
		KeyGeneration: 1, SessionRevision: 2,
		LoginIDHash: desktopDigest("proof-drift-login-" + suffix), Result: "succeeded",
		CheckedAt: driftCheckedAt, AccountFingerprint: desktopDigest("proof-drift-new-account-" + suffix),
		CandidateBindingDigest: desktopDigest("proof-drift-binding-" + suffix), Proof: driftSigned.verified,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	}); !errors.Is(err, store.ErrExecutorFenced) {
		t.Fatalf("proof config-runtime drift error=%v", err)
	}
	var driftHandoffStatus string
	var driftSequence, driftProofRows, driftLedgerRows int
	if err := db.QueryRowContext(ctx, `
		SELECT handoff.status,device.last_accepted_sequence,
		 (SELECT count(*) FROM ky_ai_executor_desktop_authorization_proof WHERE handoff_id=handoff.id),
		 (SELECT count(*) FROM ky_ai_executor_device_request_ledger WHERE device_id=device.id AND sequence=2)
		FROM ky_ai_executor_desktop_handoff handoff
		JOIN ky_ai_executor_device device ON device.id=handoff.device_id
		WHERE handoff.id=$1
	`, proofDriftFlow.handoffID).Scan(&driftHandoffStatus, &driftSequence,
		&driftProofRows, &driftLedgerRows); err != nil {
		t.Fatal(err)
	}
	if driftHandoffStatus != "claimed" || driftSequence != 1 || driftProofRows != 0 || driftLedgerRows != 0 {
		t.Fatalf("proof drift consumed state handoff=%s sequence=%d proof=%d ledger=%d",
			driftHandoffStatus, driftSequence, driftProofRows, driftLedgerRows)
	}

	ackDriftFlow, ackDriftProof := prepareDesktopActivationFixture(t, ctx, db, control,
		handoffManager, activationManager, actorID, "ack_config_drift_"+suffix, 127,
		"change_account", driftFingerprint, desktopDigest("ack-drift-new-account-"+suffix))
	if _, err := db.ExecContext(ctx, `
		UPDATE ky_ai_executor_config
		SET runtime_binding_id=$2,runtime_binding_revision=2
		WHERE id=$1
	`, ackDriftFlow.executorID, desktopDigest("ack-drift-device-"+suffix)); err != nil {
		t.Fatal(err)
	}
	ackDriftBarrier := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := activationManager.Acknowledge(ctx, desktopACKInputForFixture(t,
		ackDriftFlow, ackDriftProof, ackDriftProof.Activation.ActivationToken,
		ackDriftBarrier)); !errors.Is(err, store.ErrExecutorFenced) {
		t.Fatalf("ACK config-runtime drift error=%v", err)
	}
	var driftCurrent int64
	var driftOldStatus, driftCandidateStatus, driftActivationStatus string
	var driftACKLedger, driftActivatedAudit int
	if err := db.QueryRowContext(ctx, `
		SELECT config.current_credential_revision,old.status,candidate.status,activation.status,
		 (SELECT count(*) FROM ky_ai_executor_device_request_ledger WHERE device_id=activation.device_id AND sequence=3),
		 (SELECT count(*) FROM ky_ai_executor_credential_activation_audit WHERE activation_id=activation.id AND event_type='activated')
		FROM ky_ai_executor_config config
		JOIN ky_ai_executor_credential_binding old ON old.executor_id=config.id AND old.revision=1
		JOIN ky_ai_executor_credential_binding candidate ON candidate.executor_id=config.id AND candidate.revision=2
		JOIN ky_ai_executor_credential_activation activation ON activation.executor_id=config.id
		WHERE config.id=$1
	`, ackDriftFlow.executorID).Scan(&driftCurrent, &driftOldStatus,
		&driftCandidateStatus, &driftActivationStatus, &driftACKLedger, &driftActivatedAudit); err != nil {
		t.Fatal(err)
	}
	if driftCurrent != 1 || driftOldStatus != "active" || driftCandidateStatus != "prepared" ||
		driftActivationStatus != "pending" || driftACKLedger != 0 || driftActivatedAudit != 0 {
		t.Fatalf("ACK drift leaked current=%d old=%s candidate=%s activation=%s ledger=%d audit=%d",
			driftCurrent, driftOldStatus, driftCandidateStatus, driftActivationStatus,
			driftACKLedger, driftActivatedAudit)
	}

	swapFlow, swapProof := prepareDesktopActivationFixture(t, ctx, db, control,
		handoffManager, activationManager, actorID, "swap_success_"+suffix, 119,
		"change_account", oldFingerprint, desktopDigest("intent-new-account-"+suffix))
	barrier := time.Now().UTC().Truncate(time.Millisecond)
	ack, err := activationManager.Acknowledge(ctx, desktopACKInputForFixture(t, swapFlow,
		swapProof, swapProof.Activation.ActivationToken, barrier))
	if err != nil {
		t.Fatal(err)
	}
	var current int64
	var oldStatus, newStatus string
	if err := db.QueryRowContext(ctx, `
		SELECT config.current_credential_revision,old.status,new.status
		FROM ky_ai_executor_config config
		JOIN ky_ai_executor_credential_binding old ON old.executor_id=config.id AND old.revision=1
		JOIN ky_ai_executor_credential_binding new ON new.executor_id=config.id AND new.revision=2
		WHERE config.id=$1
	`, swapFlow.executorID).Scan(&current, &oldStatus, &newStatus); err != nil {
		t.Fatal(err)
	}
	if current != ack.CredentialRevision || oldStatus != "revoked" || newStatus != "active" {
		t.Fatalf("successful swap current=%d old=%s new=%s", current, oldStatus, newStatus)
	}
}

func testDesktopOldCredentialSwapRollback(t *testing.T, ctx context.Context, db *sql.DB, control *store.ControlStore, handoffManager *desktophandoff.Manager, activationManager *desktopactivation.Manager, actorID, suffix string) {
	t.Helper()
	oldFingerprint := desktopDigest("old-account-" + suffix)
	flow := seedClaimedDesktopFlow(t, ctx, db, control, handoffManager, actorID,
		"rollback_swap_"+suffix, 83, "change_account", oldFingerprint)
	checkedAt := time.Now().UTC().Truncate(time.Millisecond)
	proofSigned := signedDesktopAuthorizationProof(t, flow.device, flow.claimToken, flow.session.ID,
		flow.handoffID, 2, desktopDigest("swap-login-"+suffix), "succeeded", checkedAt,
		desktopDigest("new-account-"+suffix), desktopDigest("swap-binding-"+suffix),
		desktopNonce(2), 2, nil)
	proof, err := activationManager.SubmitProof(ctx, desktopactivation.SubmitProofInput{
		ClaimToken: flow.claimToken, SessionID: flow.session.ID, HandoffID: flow.handoffID,
		TargetDeviceID: flow.device.deviceID, KeyGeneration: 1, SessionRevision: 2,
		LoginIDHash: desktopDigest("swap-login-" + suffix), Result: "succeeded", CheckedAt: checkedAt,
		AccountFingerprint:     desktopDigest("new-account-" + suffix),
		CandidateBindingDigest: desktopDigest("swap-binding-" + suffix), Proof: proofSigned.verified,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	})
	if err != nil || proof.Activation.SourceCredentialRevision != 1 || proof.Activation.CredentialRevision != 2 {
		t.Fatalf("swap proof=%#v err=%v", proof, err)
	}
	outboxID := "control_outbox_" + flow.executorID + ":2_2_credential_promoted"
	if _, err := db.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_control_outbox (
		 id,aggregate_type,aggregate_id,aggregate_revision,event_type,safe_reference_json,occurred_at
		) VALUES ($1,'credential_binding',$2,2,'credential_promoted','{}'::jsonb,transaction_timestamp())
	`, outboxID, flow.executorID+":2"); err != nil {
		t.Fatal(err)
	}
	barrier := time.Now().UTC().Truncate(time.Millisecond)
	ackSigned := signedDesktopActivationACK(t, flow.device, proof.Activation.ActivationToken,
		flow.session.ID, *proof.Activation, barrier, desktopNonce(3), 3, nil)
	if _, err := activationManager.Acknowledge(ctx, desktopactivation.AcknowledgeInput{
		ActivationToken: proof.Activation.ActivationToken, SessionID: flow.session.ID,
		ActivationID: proof.Activation.ActivationID, TargetDeviceID: flow.device.deviceID,
		KeyGeneration: 1, OperationID: proof.Activation.OperationID,
		CredentialRevision: 2, LeaseEpoch: proof.Activation.LeaseEpoch,
		SourceCredentialRevision: 1, RevocationEpoch: proof.Activation.RevocationEpoch,
		DurableBarrierCompletedAt: barrier, BindingDigest: proof.Activation.BindingDigest,
		Proof:           ackSigned.verified,
		LedgerExpiresAt: time.Now().UTC().Add(store.DeviceLedgerAuditRetention + time.Hour),
	}); err == nil {
		t.Fatal("forced outbox conflict did not roll back old-active swap")
	}
	var currentRevision int64
	var oldStatus, candidateStatus, activationStatus, sessionStatus string
	var sequence, ackLedger int64
	if err := db.QueryRowContext(ctx, `
		SELECT config.current_credential_revision,old.status,candidate.status,activation.status,
		 session.status,device.last_accepted_sequence,
		 (SELECT count(*) FROM ky_ai_executor_device_request_ledger WHERE device_id=device.id AND sequence=3)
		FROM ky_ai_executor_config config
		JOIN ky_ai_executor_credential_binding old ON old.executor_id=config.id AND old.revision=1
		JOIN ky_ai_executor_credential_binding candidate ON candidate.executor_id=config.id AND candidate.revision=2
		JOIN ky_ai_executor_credential_activation activation ON activation.executor_id=config.id
		JOIN ky_ai_executor_authorization_session session ON session.id=activation.session_id
		JOIN ky_ai_executor_device device ON device.id=activation.device_id
		WHERE config.id=$1
	`, flow.executorID).Scan(&currentRevision, &oldStatus, &candidateStatus,
		&activationStatus, &sessionStatus, &sequence, &ackLedger); err != nil {
		t.Fatal(err)
	}
	if currentRevision != 1 || oldStatus != "active" || candidateStatus != "prepared" ||
		activationStatus != "pending" || sessionStatus != "verifying" || sequence != 2 || ackLedger != 0 {
		t.Fatalf("swap rollback current=%d old=%s candidate=%s activation=%s session=%s sequence=%d ledger=%d",
			currentRevision, oldStatus, candidateStatus, activationStatus, sessionStatus, sequence, ackLedger)
	}
}

func assertNoDesktopActivationSecrets(t *testing.T, ctx context.Context, db *sql.DB, flow claimedDesktopFlow, proof desktopactivation.SubmitProofResult, canaries []string) {
	t.Helper()
	var persisted string
	if err := db.QueryRowContext(ctx, `
		SELECT concat_ws('|',
		 row_to_json(handoff)::text,row_to_json(proof)::text,row_to_json(activation)::text,
		 COALESCE((SELECT json_agg(value)::text FROM ky_ai_executor_credential_activation_audit value WHERE activation_id=activation.id),''),
		 COALESCE((SELECT json_agg(value)::text FROM ky_ai_executor_device_request_ledger value WHERE device_id=$3),''),
		 COALESCE((SELECT json_agg(value)::text FROM ky_ai_executor_authorization_session_event value WHERE session_id=$1),''),
		 COALESCE((SELECT json_agg(value)::text FROM ky_ai_executor_control_outbox value WHERE aggregate_id=$1 OR aggregate_id=$4),''))
		FROM ky_ai_executor_desktop_handoff handoff
		JOIN ky_ai_executor_desktop_authorization_proof proof ON proof.handoff_id=handoff.id
		JOIN ky_ai_executor_credential_activation activation ON activation.proof_id=proof.id
		WHERE handoff.session_id=$1 AND activation.id=$2
	`, flow.session.ID, proof.Activation.ActivationID, flow.device.deviceID,
		flow.executorID+":"+fmt.Sprintf("%d", proof.Activation.CredentialRevision)).Scan(&persisted); err != nil {
		t.Fatal(err)
	}
	for _, canary := range canaries {
		if canary != "" && strings.Contains(persisted, canary) {
			t.Fatalf("raw activation secret reached PostgreSQL: %.24q", canary)
		}
	}
}
