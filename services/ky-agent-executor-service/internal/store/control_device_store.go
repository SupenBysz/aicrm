package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
)

const (
	DeviceRegistrationPath  = "/api/v1/ai-executor-devices"
	deviceChallengeLifetime = 120 * time.Second
	minimumLedgerRetention  = deviceauth.ClockWindow
)

var (
	ErrDeviceChallengeExpired       = errors.New("device registration challenge expired")
	ErrDeviceChallengeConsumed      = errors.New("device registration challenge already consumed")
	ErrDeviceChallengeMismatch      = errors.New("device registration challenge mismatch")
	ErrDeviceAlreadyRegistered      = errors.New("device already registered")
	ErrDeviceProofReplayed          = errors.New("device proof replayed")
	ErrDeviceInactive               = errors.New("device is not active")
	ErrDeviceKeyGenerationMismatch  = errors.New("device key generation mismatch")
	ErrDeviceMismatch               = errors.New("device proof target mismatch")
	ErrDeviceLedgerRetentionInvalid = errors.New("device ledger retention is invalid")
	ErrDeviceStoreInputInvalid      = errors.New("device store input is invalid")
)

var deviceStoreOpaquePattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type CreateDeviceRegistrationChallengeInput struct {
	ID                 string
	PublicKey          string
	ActorID            string
	WorkspaceType      string
	WorkspaceID        string
	ChallengeHash      string
	RequestHash        string
	IdempotencyKeyHash string
	DeviceLabel        string
	AppVersion         string
}

type DeviceRegistrationChallengeProjection struct {
	ID              string  `json:"id"`
	PublicKeyDigest string  `json:"publicKeyDigest"`
	ActorID         string  `json:"actorId"`
	WorkspaceType   string  `json:"workspaceType"`
	WorkspaceID     string  `json:"workspaceId"`
	DeviceLabel     string  `json:"deviceLabel"`
	AppVersion      string  `json:"appVersion"`
	ExpiresAt       string  `json:"expiresAt"`
	ConsumedAt      *string `json:"consumedAt,omitempty"`
	CreatedAt       string  `json:"createdAt"`
}

type CreateDeviceRegistrationChallengeResult struct {
	Challenge DeviceRegistrationChallengeProjection `json:"challenge"`
	Created   bool                                  `json:"created"`
}

type RegisterDeviceInput struct {
	ChallengeID     string
	ActorID         string
	WorkspaceType   string
	WorkspaceID     string
	PublicKey       string
	ChallengeHash   string
	Proof           deviceauth.VerifiedRequest
	LedgerExpiresAt time.Time
}

type DeviceProjection struct {
	ID                   string  `json:"id"`
	Status               string  `json:"status"`
	Label                string  `json:"label"`
	AppVersion           string  `json:"appVersion"`
	RegisteredBy         string  `json:"registeredBy"`
	WorkspaceType        string  `json:"workspaceType"`
	WorkspaceID          string  `json:"workspaceId"`
	KeyGeneration        uint64  `json:"keyGeneration"`
	LastAcceptedSequence uint64  `json:"lastAcceptedSequence"`
	LastHeartbeatAt      *string `json:"lastHeartbeatAt,omitempty"`
	CreatedAt            string  `json:"createdAt"`
	UpdatedAt            string  `json:"updatedAt"`
}

type RegisterDeviceResult struct {
	Device            DeviceProjection `json:"device"`
	ResponseReference string           `json:"responseReference"`
	Replayed          bool             `json:"replayed"`
}

type RecordDeviceHeartbeatInput struct {
	TargetDeviceID  string
	KeyGeneration   uint64
	Proof           deviceauth.VerifiedRequest
	AppVersion      string
	LedgerExpiresAt time.Time
}

type DeviceHeartbeatResult struct {
	Device            DeviceProjection `json:"device"`
	Sequence          uint64           `json:"sequence"`
	AcceptedAt        string           `json:"acceptedAt"`
	ResponseReference string           `json:"responseReference"`
	Replayed          bool             `json:"replayed"`
}

type storedChallenge struct {
	Projection         DeviceRegistrationChallengeProjection
	ChallengeHash      string
	RequestHash        string
	IdempotencyKeyHash string
	ExpiresAt          time.Time
	ConsumedAt         sql.NullTime
	CreatedAt          time.Time
}

type storedDevice struct {
	Projection DeviceProjection
	PublicKey  string
	Heartbeat  sql.NullTime
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

type storedLedger struct {
	Record     deviceauth.LedgerRecord
	AcceptedAt time.Time
	ExpiresAt  time.Time
}

func (s *ControlStore) CreateDeviceRegistrationChallenge(
	ctx context.Context,
	input CreateDeviceRegistrationChallengeInput,
) (CreateDeviceRegistrationChallengeResult, error) {
	publicKey, err := deviceauth.ParsePublicKey(input.PublicKey)
	if err != nil {
		return CreateDeviceRegistrationChallengeResult{}, ErrDeviceStoreInputInvalid
	}
	publicKeyDigest, err := deviceauth.DeviceID(publicKey)
	if err != nil || !validChallengeInput(input) {
		return CreateDeviceRegistrationChallengeResult{}, ErrDeviceStoreInputInvalid
	}

	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return CreateDeviceRegistrationChallengeResult{}, err
	}
	defer tx.Rollback()

	row := tx.QueryRowContext(ctx, `
		INSERT INTO ky_ai_executor_device_registration_challenge (
		 id,public_key_digest,actor_id,workspace_type,workspace_id,
		 challenge_hash,request_hash,expires_at,created_at,
		 idempotency_key_hash,device_label,app_version
		) VALUES (
		 $1,$2,$3,$4,$5,$6,$7,
		 transaction_timestamp() + make_interval(secs => $11),transaction_timestamp(),
		 $8,$9,$10
		)
		ON CONFLICT (actor_id,public_key_digest,idempotency_key_hash) DO NOTHING
		RETURNING id,public_key_digest,actor_id,workspace_type,workspace_id,
		          device_label,app_version,expires_at,consumed_at,created_at,
		          challenge_hash,request_hash,idempotency_key_hash
	`, input.ID, publicKeyDigest, input.ActorID, input.WorkspaceType, input.WorkspaceID,
		input.ChallengeHash, input.RequestHash, input.IdempotencyKeyHash, input.DeviceLabel, input.AppVersion,
		int(deviceChallengeLifetime/time.Second))
	challenge, scanErr := scanStoredChallenge(row)
	created := scanErr == nil
	if errors.Is(scanErr, sql.ErrNoRows) {
		challenge, scanErr = scanStoredChallenge(tx.QueryRowContext(ctx, `
			SELECT id,public_key_digest,actor_id,workspace_type,workspace_id,
			       device_label,app_version,expires_at,consumed_at,created_at,
			       challenge_hash,request_hash,idempotency_key_hash
			FROM ky_ai_executor_device_registration_challenge
			WHERE actor_id=$1 AND public_key_digest=$2 AND idempotency_key_hash=$3
			FOR SHARE
		`, input.ActorID, publicKeyDigest, input.IdempotencyKeyHash))
	}
	if scanErr != nil {
		return CreateDeviceRegistrationChallengeResult{}, classifyControlWrite(scanErr)
	}
	if !created && (challenge.RequestHash != input.RequestHash ||
		challenge.ChallengeHash != input.ChallengeHash ||
		challenge.Projection.WorkspaceType != input.WorkspaceType ||
		challenge.Projection.WorkspaceID != input.WorkspaceID ||
		challenge.Projection.DeviceLabel != input.DeviceLabel ||
		challenge.Projection.AppVersion != input.AppVersion) {
		return CreateDeviceRegistrationChallengeResult{}, ErrIdempotencyReuse
	}
	if err := tx.Commit(); err != nil {
		return CreateDeviceRegistrationChallengeResult{}, classifyControlWrite(err)
	}
	return CreateDeviceRegistrationChallengeResult{Challenge: challenge.Projection, Created: created}, nil
}

func (s *ControlStore) RegisterDevice(ctx context.Context, input RegisterDeviceInput) (RegisterDeviceResult, error) {
	publicKey, err := deviceauth.ParsePublicKey(input.PublicKey)
	if err != nil || !validOpaqueValue(input.ChallengeID) || !validActorWorkspace(input.ActorID, input.WorkspaceType, input.WorkspaceID) ||
		validateStoreDigest(input.ChallengeHash, false) != nil {
		return RegisterDeviceResult{}, ErrDeviceStoreInputInvalid
	}
	deviceID, err := deviceauth.DeviceID(publicKey)
	if err != nil {
		return RegisterDeviceResult{}, ErrDeviceStoreInputInvalid
	}
	if err := validateVerifiedProof(input.Proof, deviceID, DeviceRegistrationPath, 1); err != nil || input.Proof.Sequence != 1 {
		return RegisterDeviceResult{}, errOrInputInvalid(err)
	}

	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return RegisterDeviceResult{}, err
	}
	defer tx.Rollback()

	challenge, dbNow, err := loadChallengeForUpdate(ctx, tx, input.ChallengeID)
	if err != nil {
		return RegisterDeviceResult{}, err
	}
	if err := deviceauth.ValidateTimestamp(input.Proof.TimestampMilli, dbNow); err != nil {
		return RegisterDeviceResult{}, err
	}
	if challenge.Projection.ActorID != input.ActorID ||
		challenge.Projection.WorkspaceType != input.WorkspaceType ||
		challenge.Projection.WorkspaceID != input.WorkspaceID ||
		challenge.Projection.PublicKeyDigest != deviceID ||
		challenge.ChallengeHash != input.ChallengeHash {
		return RegisterDeviceResult{}, ErrDeviceChallengeMismatch
	}

	device, deviceExists, err := loadDeviceForUpdate(ctx, tx, deviceID)
	if err != nil {
		return RegisterDeviceResult{}, err
	}
	ledgerRequest, err := ledgerRequestFromProof(input.Proof, 1)
	if err != nil {
		return RegisterDeviceResult{}, err
	}
	decision, existing, err := decideStoredLedger(ctx, tx, ledgerRequest, sequenceOf(device, deviceExists))
	if err != nil {
		return RegisterDeviceResult{}, err
	}
	if decision.Action == deviceauth.LedgerReturnRecorded {
		if !deviceExists || existing == nil || decision.ResponseReference != deviceID {
			return RegisterDeviceResult{}, deviceauth.ErrInvalidLedgerState
		}
		if err := tx.Commit(); err != nil {
			return RegisterDeviceResult{}, classifyControlWrite(err)
		}
		return RegisterDeviceResult{Device: device.Projection, ResponseReference: decision.ResponseReference, Replayed: true}, nil
	}
	if decision.Action == deviceauth.LedgerRejectReplay {
		return RegisterDeviceResult{}, ErrDeviceProofReplayed
	}
	if deviceExists {
		return RegisterDeviceResult{}, ErrDeviceAlreadyRegistered
	}
	if challenge.ConsumedAt.Valid {
		return RegisterDeviceResult{}, ErrDeviceChallengeConsumed
	}
	if !challenge.ExpiresAt.After(dbNow) {
		return RegisterDeviceResult{}, ErrDeviceChallengeExpired
	}
	if err := validateLedgerExpiry(input.LedgerExpiresAt, dbNow); err != nil {
		return RegisterDeviceResult{}, err
	}

	device, err = insertRegisteredDevice(ctx, tx, input.PublicKey, challenge, deviceID, dbNow)
	if err != nil {
		return RegisterDeviceResult{}, err
	}
	if err := insertDeviceLedger(ctx, tx, ledgerRequest, deviceID, dbNow, input.LedgerExpiresAt); err != nil {
		return RegisterDeviceResult{}, err
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_device_registration_challenge
		SET consumed_at=$2
		WHERE id=$1 AND consumed_at IS NULL AND expires_at>$2
	`, input.ChallengeID, dbNow)
	if err != nil {
		return RegisterDeviceResult{}, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return RegisterDeviceResult{}, ErrDeviceChallengeConsumed
	}
	if err := tx.Commit(); err != nil {
		return RegisterDeviceResult{}, classifyControlWrite(err)
	}
	return RegisterDeviceResult{Device: device.Projection, ResponseReference: deviceID}, nil
}

func (s *ControlStore) RecordDeviceHeartbeat(
	ctx context.Context,
	input RecordDeviceHeartbeatInput,
) (DeviceHeartbeatResult, error) {
	if deviceauth.ValidateDeviceID(input.TargetDeviceID) != nil || input.KeyGeneration == 0 || input.KeyGeneration > math.MaxInt64 ||
		!validAppVersion(input.AppVersion) {
		return DeviceHeartbeatResult{}, ErrDeviceStoreInputInvalid
	}
	expectedPath := DeviceRegistrationPath + "/" + input.TargetDeviceID + "/heartbeat"
	if err := validateVerifiedProof(input.Proof, input.TargetDeviceID, expectedPath, input.KeyGeneration); err != nil {
		return DeviceHeartbeatResult{}, err
	}

	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return DeviceHeartbeatResult{}, err
	}
	defer tx.Rollback()
	var dbNow time.Time
	if err := tx.QueryRowContext(ctx, `SELECT transaction_timestamp()`).Scan(&dbNow); err != nil {
		return DeviceHeartbeatResult{}, err
	}
	if err := deviceauth.ValidateTimestamp(input.Proof.TimestampMilli, dbNow); err != nil {
		return DeviceHeartbeatResult{}, err
	}
	device, exists, err := loadDeviceForUpdate(ctx, tx, input.TargetDeviceID)
	if err != nil {
		return DeviceHeartbeatResult{}, err
	}
	if !exists {
		return DeviceHeartbeatResult{}, ErrNotFound
	}
	if device.Projection.Status != "active" {
		return DeviceHeartbeatResult{}, ErrDeviceInactive
	}
	if device.Projection.KeyGeneration != input.KeyGeneration {
		return DeviceHeartbeatResult{}, ErrDeviceKeyGenerationMismatch
	}

	ledgerRequest, err := ledgerRequestFromProof(input.Proof, input.KeyGeneration)
	if err != nil {
		return DeviceHeartbeatResult{}, err
	}
	decision, existing, err := decideStoredLedger(ctx, tx, ledgerRequest, device.Projection.LastAcceptedSequence)
	if err != nil {
		return DeviceHeartbeatResult{}, err
	}
	responseReference := heartbeatResponseReference(input.TargetDeviceID, input.Proof.Sequence)
	if decision.Action == deviceauth.LedgerReturnRecorded {
		if existing == nil || decision.ResponseReference != responseReference {
			return DeviceHeartbeatResult{}, deviceauth.ErrInvalidLedgerState
		}
		if err := tx.Commit(); err != nil {
			return DeviceHeartbeatResult{}, classifyControlWrite(err)
		}
		return DeviceHeartbeatResult{
			Device: device.Projection, Sequence: input.Proof.Sequence,
			AcceptedAt:        existing.AcceptedAt.UTC().Format(time.RFC3339Nano),
			ResponseReference: decision.ResponseReference, Replayed: true,
		}, nil
	}
	if decision.Action == deviceauth.LedgerRejectReplay {
		return DeviceHeartbeatResult{}, ErrDeviceProofReplayed
	}
	if err := validateLedgerExpiry(input.LedgerExpiresAt, dbNow); err != nil {
		return DeviceHeartbeatResult{}, err
	}

	previousSequence := device.Projection.LastAcceptedSequence
	row := tx.QueryRowContext(ctx, `
		UPDATE ky_ai_executor_device
		SET last_accepted_sequence=$2,last_heartbeat_at=$3,app_version=$4,updated_at=$3
		WHERE id=$1 AND status='active' AND key_generation=$5 AND last_accepted_sequence=$6
		RETURNING id,public_key,status,label,app_version,registered_by,workspace_type,workspace_id,
		          key_generation,last_accepted_sequence,last_heartbeat_at,created_at,updated_at
	`, input.TargetDeviceID, int64(input.Proof.Sequence), dbNow, input.AppVersion,
		int64(input.KeyGeneration), int64(previousSequence))
	device, err = scanStoredDevice(row)
	if errors.Is(err, sql.ErrNoRows) {
		return DeviceHeartbeatResult{}, ErrDeviceProofReplayed
	}
	if err != nil {
		return DeviceHeartbeatResult{}, err
	}
	if err := insertDeviceLedger(ctx, tx, ledgerRequest, responseReference, dbNow, input.LedgerExpiresAt); err != nil {
		return DeviceHeartbeatResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return DeviceHeartbeatResult{}, classifyControlWrite(err)
	}
	return DeviceHeartbeatResult{
		Device: device.Projection, Sequence: input.Proof.Sequence,
		AcceptedAt: dbNow.UTC().Format(time.RFC3339Nano), ResponseReference: responseReference,
	}, nil
}

func validChallengeInput(input CreateDeviceRegistrationChallengeInput) bool {
	return validOpaqueValue(input.ID) && validActorWorkspace(input.ActorID, input.WorkspaceType, input.WorkspaceID) &&
		validateStoreDigest(input.ChallengeHash, false) == nil && validateStoreDigest(input.RequestHash, false) == nil &&
		validateStoreDigest(input.IdempotencyKeyHash, false) == nil && validDeviceLabel(input.DeviceLabel) &&
		validOptionalAppVersion(input.AppVersion)
}

func validActorWorkspace(actorID, workspaceType, workspaceID string) bool {
	return validOpaqueValue(actorID) && workspaceType == "platform" && workspaceID == "platform_root"
}

func validOpaqueValue(value string) bool {
	return value != "" && len(value) <= 160 && deviceStoreOpaquePattern.MatchString(value)
}

func validDeviceLabel(value string) bool {
	if !utf8.ValidString(value) || len(value) > 120 {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}

func validAppVersion(value string) bool {
	return value != "" && validOptionalAppVersion(value)
}

func validOptionalAppVersion(value string) bool {
	if len(value) > 64 || strings.TrimSpace(value) != value {
		return false
	}
	for index := 0; index < len(value); index++ {
		if value[index] < 0x21 || value[index] > 0x7e {
			return false
		}
	}
	return true
}

func validateStoreDigest(value string, allowEmpty bool) error {
	if value == "" && allowEmpty {
		return nil
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size || hex.EncodeToString(decoded) != value {
		return ErrDeviceStoreInputInvalid
	}
	return nil
}

func validateVerifiedProof(
	proof deviceauth.VerifiedRequest,
	expectedDeviceID string,
	expectedPath string,
	keyGeneration uint64,
) error {
	if proof.DeviceID != expectedDeviceID {
		return ErrDeviceMismatch
	}
	method, err := deviceauth.CanonicalMethod(proof.CanonicalMethod)
	if err != nil || method != "POST" {
		return ErrDeviceStoreInputInvalid
	}
	path, err := deviceauth.CanonicalPath(proof.CanonicalPath)
	if err != nil || path != expectedPath {
		return ErrDeviceMismatch
	}
	if proof.TimestampMilli <= 0 || proof.Sequence == 0 || proof.Sequence > math.MaxInt64 ||
		validateStoreDigest(proof.BodySHA256, false) != nil {
		return ErrDeviceStoreInputInvalid
	}
	_, err = ledgerRequestFromProof(proof, keyGeneration)
	return err
}

func ledgerRequestFromProof(proof deviceauth.VerifiedRequest, keyGeneration uint64) (deviceauth.LedgerRequest, error) {
	request := deviceauth.LedgerRequest{
		DeviceID: proof.DeviceID, KeyGeneration: keyGeneration, Sequence: proof.Sequence,
		Nonce: proof.Nonce, RequestHash: proof.RequestHash, AuthorizationTokenHash: proof.AuthorizationTokenHash,
	}
	decision, err := deviceauth.DecideLedgerRequest(request, deviceauth.LedgerState{})
	if err != nil || decision.Action != deviceauth.LedgerAcceptNew {
		if err != nil {
			return deviceauth.LedgerRequest{}, err
		}
		return deviceauth.LedgerRequest{}, ErrDeviceStoreInputInvalid
	}
	return request, nil
}

func validateLedgerExpiry(expiresAt, now time.Time) error {
	retention := expiresAt.Sub(now)
	if expiresAt.IsZero() || retention < minimumLedgerRetention {
		return ErrDeviceLedgerRetentionInvalid
	}
	return nil
}

func loadChallengeForUpdate(ctx context.Context, tx *sql.Tx, challengeID string) (storedChallenge, time.Time, error) {
	var dbNow time.Time
	challenge, err := scanStoredChallenge(tx.QueryRowContext(ctx, `
		SELECT id,public_key_digest,actor_id,workspace_type,workspace_id,
		       device_label,app_version,expires_at,consumed_at,created_at,
		       challenge_hash,request_hash,idempotency_key_hash
		FROM ky_ai_executor_device_registration_challenge
		WHERE id=$1
		FOR UPDATE
	`, challengeID))
	if errors.Is(err, sql.ErrNoRows) {
		return storedChallenge{}, time.Time{}, ErrNotFound
	}
	if err != nil {
		return storedChallenge{}, time.Time{}, err
	}
	if err := tx.QueryRowContext(ctx, `SELECT transaction_timestamp()`).Scan(&dbNow); err != nil {
		return storedChallenge{}, time.Time{}, err
	}
	return challenge, dbNow, nil
}

func scanStoredChallenge(row rowScanner) (storedChallenge, error) {
	var item storedChallenge
	err := row.Scan(
		&item.Projection.ID, &item.Projection.PublicKeyDigest, &item.Projection.ActorID,
		&item.Projection.WorkspaceType, &item.Projection.WorkspaceID,
		&item.Projection.DeviceLabel, &item.Projection.AppVersion,
		&item.ExpiresAt, &item.ConsumedAt, &item.CreatedAt,
		&item.ChallengeHash, &item.RequestHash, &item.IdempotencyKeyHash,
	)
	if err != nil {
		return storedChallenge{}, err
	}
	item.Projection.ExpiresAt = item.ExpiresAt.UTC().Format(time.RFC3339Nano)
	item.Projection.CreatedAt = item.CreatedAt.UTC().Format(time.RFC3339Nano)
	if item.ConsumedAt.Valid {
		value := item.ConsumedAt.Time.UTC().Format(time.RFC3339Nano)
		item.Projection.ConsumedAt = &value
	}
	return item, nil
}

func loadDeviceForUpdate(ctx context.Context, tx *sql.Tx, deviceID string) (storedDevice, bool, error) {
	item, err := scanStoredDevice(tx.QueryRowContext(ctx, `
		SELECT id,public_key,status,label,app_version,registered_by,workspace_type,workspace_id,
		       key_generation,last_accepted_sequence,last_heartbeat_at,created_at,updated_at
		FROM ky_ai_executor_device WHERE id=$1 FOR UPDATE
	`, deviceID))
	if errors.Is(err, sql.ErrNoRows) {
		return storedDevice{}, false, nil
	}
	return item, err == nil, err
}

func insertRegisteredDevice(
	ctx context.Context,
	tx *sql.Tx,
	publicKey string,
	challenge storedChallenge,
	deviceID string,
	now time.Time,
) (storedDevice, error) {
	row := tx.QueryRowContext(ctx, `
		INSERT INTO ky_ai_executor_device (
		 id,public_key,status,label,app_version,registered_by,workspace_type,workspace_id,
		 key_generation,last_accepted_sequence,created_at,updated_at
		) VALUES ($1,$2,'active',$3,$4,$5,$6,$7,1,1,$8,$8)
		RETURNING id,public_key,status,label,app_version,registered_by,workspace_type,workspace_id,
		          key_generation,last_accepted_sequence,last_heartbeat_at,created_at,updated_at
	`, deviceID, publicKey, challenge.Projection.DeviceLabel, challenge.Projection.AppVersion,
		challenge.Projection.ActorID, challenge.Projection.WorkspaceType, challenge.Projection.WorkspaceID, now)
	item, err := scanStoredDevice(row)
	if err != nil {
		if errors.Is(classifyControlWrite(err), ErrConflict) {
			return storedDevice{}, ErrDeviceAlreadyRegistered
		}
		return storedDevice{}, err
	}
	return item, nil
}

func scanStoredDevice(row rowScanner) (storedDevice, error) {
	var item storedDevice
	var keyGeneration, sequence int64
	err := row.Scan(
		&item.Projection.ID, &item.PublicKey, &item.Projection.Status,
		&item.Projection.Label, &item.Projection.AppVersion, &item.Projection.RegisteredBy,
		&item.Projection.WorkspaceType, &item.Projection.WorkspaceID,
		&keyGeneration, &sequence, &item.Heartbeat, &item.CreatedAt, &item.UpdatedAt,
	)
	if err != nil {
		return storedDevice{}, err
	}
	if keyGeneration <= 0 || sequence < 0 {
		return storedDevice{}, deviceauth.ErrInvalidLedgerState
	}
	item.Projection.KeyGeneration = uint64(keyGeneration)
	item.Projection.LastAcceptedSequence = uint64(sequence)
	publicKey, err := deviceauth.ParsePublicKey(item.PublicKey)
	if err != nil || deviceauth.MatchDeviceID(publicKey, item.Projection.ID) != nil {
		return storedDevice{}, deviceauth.ErrInvalidLedgerState
	}
	item.Projection.CreatedAt = item.CreatedAt.UTC().Format(time.RFC3339Nano)
	item.Projection.UpdatedAt = item.UpdatedAt.UTC().Format(time.RFC3339Nano)
	if item.Heartbeat.Valid {
		value := item.Heartbeat.Time.UTC().Format(time.RFC3339Nano)
		item.Projection.LastHeartbeatAt = &value
	}
	return item, nil
}

func decideStoredLedger(
	ctx context.Context,
	tx *sql.Tx,
	request deviceauth.LedgerRequest,
	lastAcceptedSequence uint64,
) (deviceauth.LedgerDecision, *storedLedger, error) {
	var existing storedLedger
	err := tx.QueryRowContext(ctx, `
		SELECT nonce,request_hash,authorization_token_hash,response_reference,accepted_at,expires_at
		FROM ky_ai_executor_device_request_ledger
		WHERE device_id=$1 AND key_generation=$2 AND sequence=$3
	`, request.DeviceID, int64(request.KeyGeneration), int64(request.Sequence)).Scan(
		&existing.Record.Nonce, &existing.Record.RequestHash, &existing.Record.AuthorizationTokenHash,
		&existing.Record.ResponseReference, &existing.AcceptedAt, &existing.ExpiresAt,
	)
	var existingPointer *storedLedger
	if err == nil {
		existing.Record.DeviceID = request.DeviceID
		existing.Record.KeyGeneration = request.KeyGeneration
		existing.Record.Sequence = request.Sequence
		existingPointer = &existing
	} else if !errors.Is(err, sql.ErrNoRows) {
		return deviceauth.LedgerDecision{}, nil, err
	}
	var nonceAlreadyUsed bool
	if existingPointer == nil {
		if err := tx.QueryRowContext(ctx, `
			SELECT EXISTS(
			 SELECT 1 FROM ky_ai_executor_device_request_ledger
			 WHERE device_id=$1 AND key_generation=$2 AND nonce=$3
			)
		`, request.DeviceID, int64(request.KeyGeneration), request.Nonce).Scan(&nonceAlreadyUsed); err != nil {
			return deviceauth.LedgerDecision{}, nil, err
		}
	}
	state := deviceauth.LedgerState{NonceAlreadyUsed: nonceAlreadyUsed, LastAcceptedSequence: lastAcceptedSequence}
	if existingPointer != nil {
		state.Existing = &existingPointer.Record
	}
	decision, err := deviceauth.DecideLedgerRequest(request, state)
	return decision, existingPointer, err
}

func insertDeviceLedger(
	ctx context.Context,
	tx *sql.Tx,
	request deviceauth.LedgerRequest,
	responseReference string,
	acceptedAt time.Time,
	expiresAt time.Time,
) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_device_request_ledger (
		 device_id,key_generation,sequence,nonce,request_hash,authorization_token_hash,
		 response_reference,accepted_at,expires_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
	`, request.DeviceID, int64(request.KeyGeneration), int64(request.Sequence), request.Nonce,
		request.RequestHash, request.AuthorizationTokenHash, responseReference, acceptedAt, expiresAt)
	if err != nil {
		if errors.Is(classifyControlWrite(err), ErrConflict) {
			return ErrDeviceProofReplayed
		}
		return err
	}
	return nil
}

func sequenceOf(device storedDevice, exists bool) uint64 {
	if !exists {
		return 0
	}
	return device.Projection.LastAcceptedSequence
}

func heartbeatResponseReference(deviceID string, sequence uint64) string {
	return fmt.Sprintf("heartbeat_%s_%d", deviceID, sequence)
}

func errOrInputInvalid(err error) error {
	if err != nil {
		return err
	}
	return ErrDeviceStoreInputInvalid
}
