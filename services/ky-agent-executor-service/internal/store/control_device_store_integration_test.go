package store

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
)

func TestControlDeviceStoreAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("KY_AGENT_EXECUTOR_DEVICE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set KY_AGENT_EXECUTOR_DEVICE_TEST_DATABASE_URL for PostgreSQL integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	control, err := OpenControl(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = control.Close() }()

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	first := newDeviceStoreFixture(t, 1)
	challengeInput, registerInput := prepareDeviceRegistration(t, first, suffix, "owner_device_1")

	created, err := control.CreateDeviceRegistrationChallenge(ctx, challengeInput)
	if err != nil || !created.Created {
		t.Fatalf("challenge create=%#v err=%v", created, err)
	}
	replayedChallenge, err := control.CreateDeviceRegistrationChallenge(ctx, challengeInput)
	if err != nil || replayedChallenge.Created || replayedChallenge.Challenge.ID != created.Challenge.ID ||
		replayedChallenge.Challenge.ExpiresAt != created.Challenge.ExpiresAt {
		t.Fatalf("challenge replay=%#v err=%v", replayedChallenge, err)
	}
	createdAt := mustParseTime(t, created.Challenge.CreatedAt)
	expiresAt := mustParseTime(t, created.Challenge.ExpiresAt)
	if expiresAt.Sub(createdAt) != deviceChallengeLifetime {
		t.Fatalf("challenge lifetime=%s want=%s", expiresAt.Sub(createdAt), deviceChallengeLifetime)
	}
	reconstructedChallenge := challengeInput
	reconstructedChallenge.ID += "_retry"
	reconstructedChallenge.ChallengeHash = digestText("fresh-handler-candidate")
	reconstructed, err := control.CreateDeviceRegistrationChallenge(ctx, reconstructedChallenge)
	if err != nil || reconstructed.Created || reconstructed.Challenge.ID != created.Challenge.ID ||
		reconstructed.Challenge.ExpiresAt != created.Challenge.ExpiresAt {
		t.Fatalf("challenge deterministic replay=%#v err=%v", reconstructed, err)
	}
	changedChallenge := challengeInput
	changedChallenge.RequestHash = digestText("different-registration-request")
	if _, err := control.CreateDeviceRegistrationChallenge(ctx, changedChallenge); !errors.Is(err, ErrIdempotencyReuse) {
		t.Fatalf("changed idempotency request was not rejected: %v", err)
	}

	const registrationWorkers = 12
	registrationResults := make(chan RegisterDeviceResult, registrationWorkers)
	registrationErrors := make(chan error, registrationWorkers)
	var registrationGroup sync.WaitGroup
	for worker := 0; worker < registrationWorkers; worker++ {
		registrationGroup.Add(1)
		go func() {
			defer registrationGroup.Done()
			result, err := control.RegisterDevice(ctx, registerInput)
			if err != nil {
				registrationErrors <- err
				return
			}
			registrationResults <- result
		}()
	}
	registrationGroup.Wait()
	close(registrationResults)
	close(registrationErrors)
	for err := range registrationErrors {
		t.Fatalf("concurrent registration failed: %v", err)
	}
	registeredCount, registrationReplayCount := 0, 0
	for result := range registrationResults {
		if result.ResponseReference != first.deviceID || result.Device.ID != first.deviceID || result.Device.LastAcceptedSequence != 1 {
			t.Fatalf("unexpected registration result: %#v", result)
		}
		if result.Replayed {
			registrationReplayCount++
		} else {
			registeredCount++
		}
	}
	if registeredCount != 1 || registrationReplayCount != registrationWorkers-1 {
		t.Fatalf("registration created=%d replayed=%d", registeredCount, registrationReplayCount)
	}
	var consumedCount, deviceCount, registrationLedgerCount int
	if err := control.db.QueryRowContext(ctx, `
		SELECT
		 (SELECT count(*) FROM ky_ai_executor_device_registration_challenge WHERE id=$1 AND consumed_at IS NOT NULL),
		 (SELECT count(*) FROM ky_ai_executor_device WHERE id=$2),
		 (SELECT count(*) FROM ky_ai_executor_device_request_ledger WHERE device_id=$2 AND key_generation=1 AND sequence=1)
	`, challengeInput.ID, first.deviceID).Scan(&consumedCount, &deviceCount, &registrationLedgerCount); err != nil {
		t.Fatal(err)
	}
	if consumedCount != 1 || deviceCount != 1 || registrationLedgerCount != 1 {
		t.Fatalf("registration atomicity consumed=%d device=%d ledger=%d", consumedCount, deviceCount, registrationLedgerCount)
	}
	var sensitiveLeakCount int
	if err := control.db.QueryRowContext(ctx, `
		SELECT count(*) FROM (
		 SELECT concat_ws('|',id,public_key_digest,actor_id,workspace_type,workspace_id,
		                      challenge_hash,request_hash,idempotency_key_hash,device_label,app_version) AS payload
		 FROM ky_ai_executor_device_registration_challenge WHERE id=$1
		 UNION ALL
		 SELECT concat_ws('|',device_id,key_generation,sequence,nonce,request_hash,
		                      authorization_token_hash,response_reference)
		 FROM ky_ai_executor_device_request_ledger WHERE device_id=$2
		) rows
		WHERE payload LIKE '%' || $3 || '%' OR payload LIKE '%' || $4 || '%'
	`, challengeInput.ID, first.deviceID, "register-"+suffix, "registration-token").Scan(&sensitiveLeakCount); err != nil {
		t.Fatal(err)
	}
	if sensitiveLeakCount != 0 {
		t.Fatalf("device trust persistence leaked challenge/token canaries: %d", sensitiveLeakCount)
	}
	if _, err := control.db.ExecContext(ctx, `
		UPDATE ky_ai_executor_device_registration_challenge
		SET expires_at=transaction_timestamp()-interval '1 second'
		WHERE id=$1
	`, challengeInput.ID); err != nil {
		t.Fatal(err)
	}
	if replay, err := control.RegisterDevice(ctx, registerInput); err != nil || !replay.Replayed || replay.ResponseReference != first.deviceID {
		t.Fatalf("registration exact replay after challenge expiry=%#v err=%v", replay, err)
	}
	crossActorReplay := registerInput
	crossActorReplay.ActorID = "other_device_owner"
	if _, err := control.RegisterDevice(ctx, crossActorReplay); !errors.Is(err, ErrDeviceChallengeMismatch) {
		t.Fatalf("registration replay crossed actor boundary: %v", err)
	}

	changedRegistration := registerInput
	changedRegistration.Proof = signedDeviceProof(t, first, "POST", DeviceRegistrationPath,
		[]byte(`{"challengeId":"changed"}`), "Bearer registration-token", []string{"Bearer"},
		time.Now().UTC(), nonceFor(91), 1)
	if _, err := control.RegisterDevice(ctx, changedRegistration); !errors.Is(err, ErrDeviceProofReplayed) {
		t.Fatalf("same sequence different registration request was not rejected: %v", err)
	}

	expiredFixture := newDeviceStoreFixture(t, 2)
	expiredChallenge, expiredRegistration := prepareDeviceRegistration(t, expiredFixture, suffix+"_expired", "owner_device_expired")
	if _, err := control.CreateDeviceRegistrationChallenge(ctx, expiredChallenge); err != nil {
		t.Fatal(err)
	}
	if _, err := control.db.ExecContext(ctx, `
		UPDATE ky_ai_executor_device_registration_challenge SET expires_at=transaction_timestamp()-interval '1 second'
		WHERE id=$1
	`, expiredChallenge.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := control.RegisterDevice(ctx, expiredRegistration); !errors.Is(err, ErrDeviceChallengeExpired) {
		t.Fatalf("expired challenge was not rejected: %v", err)
	}

	second := newDeviceStoreFixture(t, 3)
	secondChallenge, secondRegistration := prepareDeviceRegistration(t, second, suffix+"_second", "owner_device_2")
	if _, err := control.CreateDeviceRegistrationChallenge(ctx, secondChallenge); err != nil {
		t.Fatal(err)
	}
	if _, err := control.RegisterDevice(ctx, secondRegistration); err != nil {
		t.Fatal(err)
	}

	heartbeatAt := time.Now().UTC()
	heartbeatBody := []byte(`{"bridgeVersion":2,"appVersion":"2.0.1","capabilities":{"deviceProof":true},"occurredAt":"2026-07-12T00:00:00Z"}`)
	heartbeatProof := signedDeviceProof(t, first, "POST", heartbeatPath(first.deviceID), heartbeatBody, "", nil,
		heartbeatAt, nonceFor(2), 2)
	heartbeatInput := RecordDeviceHeartbeatInput{
		TargetDeviceID:  first.deviceID,
		KeyGeneration:   1,
		Proof:           heartbeatProof,
		AppVersion:      "2.0.1",
		LedgerExpiresAt: time.Now().Add(DeviceLedgerAuditRetention + time.Hour),
	}

	const heartbeatWorkers = 20
	heartbeatResults := make(chan DeviceHeartbeatResult, heartbeatWorkers)
	heartbeatErrors := make(chan error, heartbeatWorkers)
	var heartbeatGroup sync.WaitGroup
	for worker := 0; worker < heartbeatWorkers; worker++ {
		heartbeatGroup.Add(1)
		go func() {
			defer heartbeatGroup.Done()
			result, err := control.RecordDeviceHeartbeat(ctx, heartbeatInput)
			if err != nil {
				heartbeatErrors <- err
				return
			}
			heartbeatResults <- result
		}()
	}
	heartbeatGroup.Wait()
	close(heartbeatResults)
	close(heartbeatErrors)
	for err := range heartbeatErrors {
		t.Fatalf("concurrent heartbeat failed: %v", err)
	}
	heartbeatAccepted, heartbeatReplayed := 0, 0
	responseReference := ""
	for result := range heartbeatResults {
		if responseReference == "" {
			responseReference = result.ResponseReference
		}
		if result.ResponseReference != responseReference || result.Sequence != 2 {
			t.Fatalf("heartbeat response mismatch: %#v", result)
		}
		if result.Replayed {
			heartbeatReplayed++
		} else {
			heartbeatAccepted++
		}
	}
	if heartbeatAccepted != 1 || heartbeatReplayed != heartbeatWorkers-1 {
		t.Fatalf("heartbeat accepted=%d replayed=%d", heartbeatAccepted, heartbeatReplayed)
	}
	var lastSequence int64
	var lastHeartbeat time.Time
	var heartbeatLedgerCount int
	if err := control.db.QueryRowContext(ctx, `
		SELECT device.last_accepted_sequence,device.last_heartbeat_at,
		       (SELECT count(*) FROM ky_ai_executor_device_request_ledger ledger
		        WHERE ledger.device_id=device.id AND ledger.key_generation=1 AND ledger.sequence=2)
		FROM ky_ai_executor_device device WHERE device.id=$1
	`, first.deviceID).Scan(&lastSequence, &lastHeartbeat, &heartbeatLedgerCount); err != nil {
		t.Fatal(err)
	}
	if lastSequence != 2 || lastHeartbeat.IsZero() || heartbeatLedgerCount != 1 {
		t.Fatalf("heartbeat atomicity sequence=%d heartbeat=%s ledger=%d", lastSequence, lastHeartbeat, heartbeatLedgerCount)
	}

	differentSequenceTwo := heartbeatInput
	differentSequenceTwo.Proof = signedDeviceProof(t, first, "POST", heartbeatPath(first.deviceID),
		[]byte(`{"bridgeVersion":2,"appVersion":"tampered"}`), "", nil,
		time.Now().UTC(), nonceFor(92), 2)
	if _, err := control.RecordDeviceHeartbeat(ctx, differentSequenceTwo); !errors.Is(err, ErrDeviceProofReplayed) {
		t.Fatalf("same sequence different request was not rejected: %v", err)
	}

	reusedNonce := heartbeatInput
	reusedNonce.Proof = signedDeviceProof(t, first, "POST", heartbeatPath(first.deviceID),
		[]byte(`{"bridgeVersion":2,"appVersion":"2.0.2"}`), "", nil,
		time.Now().UTC(), nonceFor(2), 3)
	if _, err := control.RecordDeviceHeartbeat(ctx, reusedNonce); !errors.Is(err, ErrDeviceProofReplayed) {
		t.Fatalf("reused nonce was not rejected: %v", err)
	}

	heartbeatThree := heartbeatInput
	heartbeatThree.Proof = signedDeviceProof(t, first, "POST", heartbeatPath(first.deviceID),
		[]byte(`{"bridgeVersion":2,"appVersion":"2.0.2"}`), "", nil,
		time.Now().UTC(), nonceFor(3), 3)
	heartbeatThree.AppVersion = "2.0.2"
	if _, err := control.RecordDeviceHeartbeat(ctx, heartbeatThree); err != nil {
		t.Fatal(err)
	}

	crossDevice := heartbeatInput
	crossDevice.TargetDeviceID = second.deviceID
	crossDevice.Proof = signedDeviceProof(t, first, "POST", heartbeatPath(second.deviceID),
		[]byte(`{"bridgeVersion":2,"appVersion":"2.0.2"}`), "", nil,
		time.Now().UTC(), nonceFor(4), 4)
	if _, err := control.RecordDeviceHeartbeat(ctx, crossDevice); !errors.Is(err, ErrDeviceMismatch) {
		t.Fatalf("cross-device proof was not rejected: %v", err)
	}

	expiredHeartbeat := heartbeatInput
	expiredHeartbeat.Proof = signedDeviceProof(t, first, "POST", heartbeatPath(first.deviceID),
		[]byte(`{"bridgeVersion":2,"appVersion":"2.0.3"}`), "", nil,
		time.Now().UTC().Add(-deviceauth.ClockWindow-time.Second), nonceFor(4), 4)
	if _, err := control.RecordDeviceHeartbeat(ctx, expiredHeartbeat); !errors.Is(err, deviceauth.ErrTimestampOutsideWindow) {
		t.Fatalf("expired device proof was not rejected: %v", err)
	}

	heartbeatFive := heartbeatInput
	heartbeatFive.Proof = signedDeviceProof(t, first, "POST", heartbeatPath(first.deviceID),
		[]byte(`{"bridgeVersion":2,"appVersion":"2.0.5"}`), "", nil,
		time.Now().UTC(), nonceFor(5), 5)
	heartbeatFive.AppVersion = "2.0.5"
	if _, err := control.RecordDeviceHeartbeat(ctx, heartbeatFive); err != nil {
		t.Fatal(err)
	}
	if err := control.Close(); err != nil {
		t.Fatal(err)
	}
	control, err = OpenControl(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if replay, err := control.RecordDeviceHeartbeat(ctx, heartbeatFive); err != nil || !replay.Replayed {
		t.Fatalf("restart exact replay=%#v err=%v", replay, err)
	}
	lateSequenceFour := heartbeatInput
	lateSequenceFour.Proof = signedDeviceProof(t, first, "POST", heartbeatPath(first.deviceID),
		[]byte(`{"bridgeVersion":2,"appVersion":"late"}`), "", nil,
		time.Now().UTC(), nonceFor(44), 4)
	if _, err := control.RecordDeviceHeartbeat(ctx, lateSequenceFour); !errors.Is(err, ErrDeviceProofReplayed) {
		t.Fatalf("restart lost persisted high-water mark: %v", err)
	}

	heartbeatSix := heartbeatInput
	heartbeatSix.Proof = signedDeviceProof(t, first, "POST", heartbeatPath(first.deviceID),
		[]byte(`{"bridgeVersion":2,"appVersion":"2.0.6"}`), "", nil,
		time.Now().UTC(), nonceFor(6), 6)
	heartbeatSix.AppVersion = "2.0.6"
	if _, err := control.RecordDeviceHeartbeat(ctx, heartbeatSix); err != nil {
		t.Fatal(err)
	}

	if _, err := control.db.ExecContext(ctx, `UPDATE ky_ai_executor_device SET status='disabled' WHERE id=$1`, first.deviceID); err != nil {
		t.Fatal(err)
	}
	if replay, err := control.RecordDeviceHeartbeat(ctx, heartbeatSix); err != nil || !replay.Replayed || replay.Sequence != 6 {
		t.Fatalf("disabled device exact replay=%#v err=%v", replay, err)
	}
	heartbeatSeven := heartbeatInput
	heartbeatSeven.Proof = signedDeviceProof(t, first, "POST", heartbeatPath(first.deviceID),
		[]byte(`{"bridgeVersion":2,"appVersion":"2.0.7"}`), "", nil,
		time.Now().UTC(), nonceFor(7), 7)
	heartbeatSeven.AppVersion = "2.0.7"
	if _, err := control.RecordDeviceHeartbeat(ctx, heartbeatSeven); !errors.Is(err, ErrDeviceInactive) {
		t.Fatalf("disabled device was not rejected: %v", err)
	}
	if _, err := control.db.ExecContext(ctx, `
		UPDATE ky_ai_executor_device SET status='active',key_generation=2,last_accepted_sequence=0 WHERE id=$1
	`, first.deviceID); err != nil {
		t.Fatal(err)
	}
	if _, err := control.RecordDeviceHeartbeat(ctx, heartbeatSeven); !errors.Is(err, ErrDeviceKeyGenerationMismatch) {
		t.Fatalf("old key generation was not rejected after rekey: %v", err)
	}
	newGeneration := heartbeatInput
	newGeneration.KeyGeneration = 2
	newGeneration.Proof = signedDeviceProof(t, first, "POST", heartbeatPath(first.deviceID),
		[]byte(`{"bridgeVersion":2,"appVersion":"2.1.0"}`), "", nil,
		time.Now().UTC(), nonceFor(101), 1)
	newGeneration.AppVersion = "2.1.0"
	if result, err := control.RecordDeviceHeartbeat(ctx, newGeneration); err != nil || result.Replayed ||
		result.Device.KeyGeneration != 2 || result.Device.LastAcceptedSequence != 1 {
		t.Fatalf("new key generation heartbeat=%#v err=%v", result, err)
	}
	var generationOneRows, generationTwoRows int
	if err := control.db.QueryRowContext(ctx, `
		SELECT
		 count(*) FILTER (WHERE key_generation=1),
		 count(*) FILTER (WHERE key_generation=2)
		FROM ky_ai_executor_device_request_ledger WHERE device_id=$1
	`, first.deviceID).Scan(&generationOneRows, &generationTwoRows); err != nil {
		t.Fatal(err)
	}
	if generationOneRows < 4 || generationTwoRows != 1 {
		t.Fatalf("rekey ledger generations old=%d new=%d", generationOneRows, generationTwoRows)
	}
}

type deviceStoreFixture struct {
	privateKey ed25519.PrivateKey
	publicKey  string
	deviceID   string
}

func newDeviceStoreFixture(t *testing.T, offset byte) deviceStoreFixture {
	t.Helper()
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = offset + byte(index)
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
	return deviceStoreFixture{privateKey: privateKey, publicKey: encoded, deviceID: deviceID}
}

func prepareDeviceRegistration(
	t *testing.T,
	fixture deviceStoreFixture,
	suffix string,
	actorID string,
) (CreateDeviceRegistrationChallengeInput, RegisterDeviceInput) {
	t.Helper()
	challengeID := "device_challenge_" + suffix
	challenge := "register-" + suffix
	challengeHash := digestText(challenge)
	challengeInput := CreateDeviceRegistrationChallengeInput{
		ID: challengeID, PublicKey: fixture.publicKey, ActorID: actorID,
		WorkspaceType: "platform", WorkspaceID: "platform_root",
		ChallengeHash: challengeHash, RequestHash: digestText("challenge-request-" + suffix),
		IdempotencyKeyHash: digestText("challenge-idempotency-" + suffix),
		DeviceLabel:        "Desktop " + suffix, AppVersion: "2.0.0",
	}
	body := []byte(fmt.Sprintf(
		`{"challengeId":%q,"challenge":%q,"publicKey":%q,"deviceLabel":%q,"appVersion":"2.0.0"}`,
		challengeID, challenge, fixture.publicKey, challengeInput.DeviceLabel,
	))
	proof := signedDeviceProof(t, fixture, "POST", DeviceRegistrationPath, body,
		"Bearer registration-token", []string{"Bearer"}, time.Now().UTC(), nonceFor(1), 1)
	return challengeInput, RegisterDeviceInput{
		ChallengeID: challengeID, ActorID: actorID,
		WorkspaceType: "platform", WorkspaceID: "platform_root",
		PublicKey: fixture.publicKey, ChallengeHash: challengeHash,
		DeviceLabel: challengeInput.DeviceLabel, AppVersion: challengeInput.AppVersion, Proof: proof,
		LedgerExpiresAt: time.Now().Add(DeviceLedgerAuditRetention + time.Hour),
	}
}

func signedDeviceProof(
	t *testing.T,
	fixture deviceStoreFixture,
	method string,
	path string,
	body []byte,
	authorization string,
	allowedSchemes []string,
	timestamp time.Time,
	nonce string,
	sequence uint64,
) deviceauth.VerifiedRequest {
	t.Helper()
	authorizationHash, err := deviceauth.AuthorizationTokenHash(authorization, allowedSchemes)
	if err != nil {
		t.Fatal(err)
	}
	proofHeaders := deviceauth.ProofHeaders{
		DeviceID: fixture.deviceID, TimestampMilli: timestamp.UnixMilli(),
		Nonce: nonce, Sequence: sequence, BodySHA256: deviceauth.HashBody(body),
	}
	signingInput, err := deviceauth.SigningInput(method, path, proofHeaders, authorizationHash)
	if err != nil {
		t.Fatal(err)
	}
	signature := ed25519.Sign(fixture.privateKey, signingInput)
	headers := make(http.Header)
	headers.Set(deviceauth.HeaderDeviceID, fixture.deviceID)
	headers.Set(deviceauth.HeaderTimestamp, fmt.Sprintf("%d", timestamp.UnixMilli()))
	headers.Set(deviceauth.HeaderNonce, nonce)
	headers.Set(deviceauth.HeaderSequence, fmt.Sprintf("%d", sequence))
	headers.Set(deviceauth.HeaderContentSHA256, deviceauth.HashBody(body))
	headers.Set(deviceauth.HeaderSignature, base64.RawURLEncoding.EncodeToString(signature))
	if authorization != "" {
		headers.Set("Authorization", authorization)
	}
	verified, err := deviceauth.VerifyRequest(deviceauth.VerifyInput{
		PublicKey: fixture.publicKey, Method: method, RequestTarget: path,
		Headers: headers, Body: body, AllowedAuthorizationSchemes: allowedSchemes, Now: timestamp,
	})
	if err != nil {
		t.Fatal(err)
	}
	return verified
}

func nonceFor(value byte) string {
	raw := make([]byte, 16)
	for index := range raw {
		raw[index] = value + byte(index)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func heartbeatPath(deviceID string) string {
	return DeviceRegistrationPath + "/" + deviceID + "/heartbeat"
}

func digestText(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func mustParseTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
