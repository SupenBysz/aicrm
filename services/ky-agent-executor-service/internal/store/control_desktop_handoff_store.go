package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"math"
	"regexp"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
)

const (
	DesktopHandoffLifetime    = 120 * time.Second
	DesktopClaimTokenLifetime = 5 * time.Minute
	DesktopDeviceOnlineWindow = 2 * time.Minute
)

var (
	ErrDesktopHandoffInputInvalid        = errors.New("desktop handoff input invalid")
	ErrDesktopHandoffConflict            = errors.New("desktop handoff conflict")
	ErrDesktopHandoffExpired             = errors.New("desktop handoff expired")
	ErrDesktopHandoffTokenMismatch       = errors.New("desktop handoff token mismatch")
	ErrDesktopHandoffTokenReconstruction = errors.New("desktop handoff token reconstruction failed")
	ErrDesktopHandoffClaimConflict       = errors.New("desktop handoff claim conflict")
	ErrDesktopHandoffTargetMismatch      = errors.New("desktop handoff target mismatch")
	ErrDesktopDeviceOffline              = errors.New("desktop device offline")
)

var desktopHandoffKeyIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

type DesktopHandoffProjection struct {
	ID                      string
	SessionID               string
	ExecutorID              string
	DeviceID                string
	RequestedBy             string
	ExpectedSessionRevision int64
	Status                  string
	IssuedAt                time.Time
	ExpiresAt               time.Time
	ClaimedAt               sql.NullTime
	ClaimedSessionRevision  sql.NullInt64

	IdempotencyKeyHash  string
	RequestHash         string
	TicketHash          string
	TicketNonceHash     string
	TokenKeyID          string
	ClaimTokenHash      string
	ClaimTokenKeyID     string
	ClaimTokenNonceHash string
	ClaimTokenIssuedAt  sql.NullTime
	ClaimExpiresAt      sql.NullTime
}

type IssuedDesktopToken struct {
	Token     string
	Hash      string
	KeyID     string
	Nonce     string
	NonceHash string
	ExpiresAt time.Time
}

type DesktopHandoffTicketIssuer func(DesktopHandoffProjection, time.Time) (IssuedDesktopToken, error)
type DesktopClaimTokenIssuer func(DesktopHandoffProjection, time.Time) (IssuedDesktopToken, error)

type CreateDesktopHandoffInput struct {
	ID                      string
	SessionID               string
	ActorID                 string
	DeviceID                string
	ExpectedSessionRevision int64
	IdempotencyKeyHash      string
	RequestHash             string
}

type CreateDesktopHandoffResult struct {
	Handoff DesktopHandoffProjection
	Ticket  string
	Nonce   string
	Created bool
}

type VerifiedDesktopHandoffTicket struct {
	TokenID                 string
	HandoffID               string
	SessionID               string
	ExecutorID              string
	DeviceID                string
	ActorID                 string
	ExpectedSessionRevision int64
	TokenHash               string
}

type DesktopHandoffTicketVerifier func(time.Time) (VerifiedDesktopHandoffTicket, error)

type ClaimDesktopHandoffInput struct {
	SessionID       string
	HandoffID       string
	TargetDeviceID  string
	KeyGeneration   uint64
	Proof           deviceauth.VerifiedRequest
	ClaimedAt       time.Time
	LedgerExpiresAt time.Time
}

type ClaimDesktopHandoffResult struct {
	Handoff         DesktopHandoffProjection
	ClaimToken      string
	SessionRevision int64
	Replayed        bool
}

type storedDesktopHandoffSession struct {
	ID                string
	ExecutorID        string
	RuntimeType       string
	FlowType          string
	Status            string
	RequestedBy       string
	BoundDeviceID     string
	Revision          int64
	CurrentSequence   int64
	SessionDeadlineAt time.Time
}

func (s *ControlStore) CreateDesktopHandoff(
	ctx context.Context,
	input CreateDesktopHandoffInput,
	issuer DesktopHandoffTicketIssuer,
) (CreateDesktopHandoffResult, error) {
	if !validCreateDesktopHandoffInput(input) || issuer == nil {
		return CreateDesktopHandoffResult{}, ErrDesktopHandoffInputInvalid
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return CreateDesktopHandoffResult{}, err
	}
	defer tx.Rollback()
	if result, found, err := replayDesktopHandoffCreation(ctx, tx, input, issuer); found || err != nil {
		return commitDesktopHandoffCreationReplay(tx, result, err)
	}

	var executorID string
	if err := tx.QueryRowContext(ctx, `
		SELECT executor_id FROM ky_ai_executor_authorization_session WHERE id=$1
	`, input.SessionID).Scan(&executorID); errors.Is(err, sql.ErrNoRows) {
		return CreateDesktopHandoffResult{}, ErrNotFound
	} else if err != nil {
		return CreateDesktopHandoffResult{}, err
	}
	if err := lockBindableExecutor(ctx, tx, executorID); err != nil {
		return CreateDesktopHandoffResult{}, err
	}
	session, found, err := loadDesktopHandoffSessionForUpdate(ctx, tx, input.SessionID)
	if err != nil {
		return CreateDesktopHandoffResult{}, err
	}
	if !found {
		return CreateDesktopHandoffResult{}, ErrNotFound
	}
	if result, found, err := replayDesktopHandoffCreation(ctx, tx, input, issuer); found || err != nil {
		return commitDesktopHandoffCreationReplay(tx, result, err)
	}
	now, err := transactionNow(ctx, tx)
	if err != nil {
		return CreateDesktopHandoffResult{}, err
	}
	if session.ExecutorID != executorID || session.RuntimeType != "desktop" || session.FlowType != "browser" ||
		session.Status != "starting" || session.RequestedBy != input.ActorID || session.BoundDeviceID != "" {
		return CreateDesktopHandoffResult{}, ErrDesktopHandoffTargetMismatch
	}
	if session.Revision != input.ExpectedSessionRevision {
		return CreateDesktopHandoffResult{}, ErrRevisionConflict
	}
	if !now.Before(session.SessionDeadlineAt) {
		return CreateDesktopHandoffResult{}, ErrDesktopHandoffExpired
	}
	binding, bindingFound, err := loadDeviceBindingForUpdate(ctx, tx, executorID)
	if err != nil {
		return CreateDesktopHandoffResult{}, err
	}
	if !bindingFound || binding.Status != "active" || binding.DeviceID != input.DeviceID {
		return CreateDesktopHandoffResult{}, ErrDesktopHandoffTargetMismatch
	}
	device, deviceFound, err := loadDeviceForUpdate(ctx, tx, input.DeviceID)
	if err != nil {
		return CreateDesktopHandoffResult{}, err
	}
	if !deviceFound {
		return CreateDesktopHandoffResult{}, ErrNotFound
	}
	if device.Projection.Status != "active" || device.Projection.WorkspaceType != "platform" ||
		device.Projection.WorkspaceID != "platform_root" {
		return CreateDesktopHandoffResult{}, ErrDesktopHandoffTargetMismatch
	}
	if !device.Heartbeat.Valid || device.Heartbeat.Time.After(now) || now.Sub(device.Heartbeat.Time) > DesktopDeviceOnlineWindow {
		return CreateDesktopHandoffResult{}, ErrDesktopDeviceOffline
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_desktop_handoff
		SET status='expired'
		WHERE session_id=$1 AND status='pending' AND expires_at <= $2
	`, input.SessionID, now); err != nil {
		return CreateDesktopHandoffResult{}, classifyControlWrite(err)
	}
	var activeID string
	if err := tx.QueryRowContext(ctx, `
		SELECT id FROM ky_ai_executor_desktop_handoff
		WHERE session_id=$1 AND status IN ('pending','claimed','proof_submitted')
		LIMIT 1 FOR UPDATE
	`, input.SessionID).Scan(&activeID); err == nil {
		return CreateDesktopHandoffResult{}, ErrDesktopHandoffConflict
	} else if !errors.Is(err, sql.ErrNoRows) {
		return CreateDesktopHandoffResult{}, err
	}

	issuedAt := now.UTC().Truncate(time.Second)
	item := DesktopHandoffProjection{
		ID: input.ID, SessionID: input.SessionID, ExecutorID: executorID,
		DeviceID: input.DeviceID, RequestedBy: input.ActorID,
		ExpectedSessionRevision: input.ExpectedSessionRevision, Status: "pending",
		IdempotencyKeyHash: input.IdempotencyKeyHash, RequestHash: input.RequestHash,
		IssuedAt: issuedAt, ExpiresAt: issuedAt.Add(DesktopHandoffLifetime),
	}
	issued, err := issuer(item, issuedAt)
	if err != nil {
		return CreateDesktopHandoffResult{}, err
	}
	if !validIssuedDesktopToken(issued, issuedAt, DesktopHandoffLifetime) {
		return CreateDesktopHandoffResult{}, ErrDesktopHandoffInputInvalid
	}
	item.TicketHash, item.TicketNonceHash, item.TokenKeyID = issued.Hash, issued.NonceHash, issued.KeyID
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_desktop_handoff (
		 id,session_id,executor_id,device_id,requested_by,expected_session_revision,
		 idempotency_key_hash,request_hash,ticket_hash,ticket_nonce_hash,token_key_id,
		 status,issued_at,expires_at,created_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13,$12)
	`, item.ID, item.SessionID, item.ExecutorID, item.DeviceID, item.RequestedBy,
		item.ExpectedSessionRevision, item.IdempotencyKeyHash, item.RequestHash,
		item.TicketHash, item.TicketNonceHash, item.TokenKeyID, item.IssuedAt, item.ExpiresAt); err != nil {
		return CreateDesktopHandoffResult{}, classifyControlWrite(err)
	}
	if err := tx.Commit(); err != nil {
		return CreateDesktopHandoffResult{}, classifyControlWrite(err)
	}
	return CreateDesktopHandoffResult{Handoff: item, Ticket: issued.Token, Nonce: issued.Nonce, Created: true}, nil
}

func (s *ControlStore) ClaimDesktopHandoff(
	ctx context.Context,
	input ClaimDesktopHandoffInput,
	verifier DesktopHandoffTicketVerifier,
	issuer DesktopClaimTokenIssuer,
) (ClaimDesktopHandoffResult, error) {
	request, err := validateDesktopHandoffClaimInput(input)
	if err != nil || verifier == nil || issuer == nil {
		return ClaimDesktopHandoffResult{}, errOrDesktopHandoffInputInvalid(err)
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return ClaimDesktopHandoffResult{}, err
	}
	defer tx.Rollback()
	if result, handled, err := replayDesktopHandoffClaim(ctx, tx, input, request, issuer); handled || err != nil {
		return commitDesktopHandoffClaimReplay(tx, result, err)
	}
	initialHandoff, found, err := loadDesktopHandoffByID(ctx, tx, input.HandoffID, false)
	if err != nil {
		return ClaimDesktopHandoffResult{}, err
	}
	if !found {
		return ClaimDesktopHandoffResult{}, ErrNotFound
	}
	if err := lockBindableExecutor(ctx, tx, initialHandoff.ExecutorID); err != nil {
		return ClaimDesktopHandoffResult{}, err
	}
	session, found, err := loadDesktopHandoffSessionForUpdate(ctx, tx, input.SessionID)
	if err != nil {
		return ClaimDesktopHandoffResult{}, err
	}
	if !found {
		return ClaimDesktopHandoffResult{}, ErrNotFound
	}
	handoff, found, err := loadDesktopHandoffForUpdate(ctx, tx, input.HandoffID)
	if err != nil {
		return ClaimDesktopHandoffResult{}, err
	}
	if !found {
		return ClaimDesktopHandoffResult{}, ErrNotFound
	}
	binding, bindingFound, err := loadDeviceBindingForUpdate(ctx, tx, initialHandoff.ExecutorID)
	if err != nil {
		return ClaimDesktopHandoffResult{}, err
	}
	device, deviceFound, err := loadDeviceForUpdate(ctx, tx, input.TargetDeviceID)
	if err != nil {
		return ClaimDesktopHandoffResult{}, err
	}
	if result, handled, err := replayDesktopHandoffClaim(ctx, tx, input, request, issuer); handled || err != nil {
		return commitDesktopHandoffClaimReplay(tx, result, err)
	}
	now, err := transactionNow(ctx, tx)
	if err != nil {
		return ClaimDesktopHandoffResult{}, err
	}
	ticket, err := verifier(now)
	if err != nil {
		return ClaimDesktopHandoffResult{}, err
	}
	if !validVerifiedDesktopHandoffTicket(ticket, input, request) {
		return ClaimDesktopHandoffResult{}, ErrDesktopHandoffTokenMismatch
	}
	if err := validateNewDesktopHandoffClaim(
		input, request, ticket, session, handoff, binding, bindingFound, device, deviceFound, now,
	); err != nil {
		return ClaimDesktopHandoffResult{}, err
	}
	if err := acceptDesktopHandoffClaimProof(ctx, tx, request, device, now, input.LedgerExpiresAt, claimResponseReference(input.HandoffID)); err != nil {
		return ClaimDesktopHandoffResult{}, err
	}
	claimedRevision := session.Revision + 1
	issuedAt := now.UTC().Truncate(time.Second)
	handoff.Status = "claimed"
	handoff.ClaimedAt = sql.NullTime{Time: now, Valid: true}
	handoff.ClaimedSessionRevision = sql.NullInt64{Int64: claimedRevision, Valid: true}
	handoff.ClaimTokenIssuedAt = sql.NullTime{Time: issuedAt, Valid: true}
	handoff.ClaimExpiresAt = sql.NullTime{Time: issuedAt.Add(DesktopClaimTokenLifetime), Valid: true}
	issued, err := issuer(handoff, issuedAt)
	if err != nil {
		return ClaimDesktopHandoffResult{}, err
	}
	if !validIssuedDesktopToken(issued, issuedAt, DesktopClaimTokenLifetime) {
		return ClaimDesktopHandoffResult{}, ErrDesktopHandoffInputInvalid
	}
	handoff.ClaimTokenHash = issued.Hash
	handoff.ClaimTokenKeyID = issued.KeyID
	handoff.ClaimTokenNonceHash = issued.NonceHash
	result, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_desktop_handoff
		SET status='claimed',claimed_at=$2,claim_token_hash=$3,claim_token_key_id=$4,
		    claim_token_nonce_hash=$5,claim_token_issued_at=$6,claim_expires_at=$7,
		    claimed_session_revision=$8
		WHERE id=$1 AND status='pending' AND ticket_hash=$9
	`, handoff.ID, now, issued.Hash, issued.KeyID, issued.NonceHash, issuedAt,
		issued.ExpiresAt, claimedRevision, request.AuthorizationTokenHash)
	if err != nil {
		return ClaimDesktopHandoffResult{}, classifyControlWrite(err)
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ClaimDesktopHandoffResult{}, ErrDesktopHandoffClaimConflict
	}
	var sequence, persistedRevision int64
	row := tx.QueryRowContext(ctx, `
		UPDATE ky_ai_executor_authorization_session
		SET status='waiting_user',bound_device_id=$2,revision=revision+1,
		    current_sequence=current_sequence+1,updated_at=$3
		WHERE id=$1 AND executor_id=$4 AND requested_by=$5 AND runtime_type='desktop'
		  AND flow_type='browser' AND status='starting' AND revision=$6 AND bound_device_id=''
		RETURNING current_sequence,revision
	`, session.ID, input.TargetDeviceID, now, ticket.ExecutorID, ticket.ActorID, ticket.ExpectedSessionRevision)
	if err := row.Scan(&sequence, &persistedRevision); errors.Is(err, sql.ErrNoRows) {
		return ClaimDesktopHandoffResult{}, ErrRevisionConflict
	} else if err != nil {
		return ClaimDesktopHandoffResult{}, err
	}
	if persistedRevision != claimedRevision {
		return ClaimDesktopHandoffResult{}, deviceauth.ErrInvalidLedgerState
	}
	if err := insertSessionEvent(ctx, tx, session.ID, sequence, AuthorizationEventChanged, map[string]any{
		"change": "desktop_claimed", "handoffId": handoff.ID, "deviceId": handoff.DeviceID,
	}); err != nil {
		return ClaimDesktopHandoffResult{}, err
	}
	if err := insertControlOutbox(ctx, tx, "authorization_session", session.ID, claimedRevision,
		"authorization.desktop_claimed", map[string]any{
			"executorId": ticket.ExecutorID, "handoffId": handoff.ID, "deviceId": handoff.DeviceID,
		}); err != nil {
		return ClaimDesktopHandoffResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return ClaimDesktopHandoffResult{}, classifyControlWrite(err)
	}
	return ClaimDesktopHandoffResult{
		Handoff: handoff, ClaimToken: issued.Token, SessionRevision: claimedRevision,
	}, nil
}

func replayDesktopHandoffCreation(
	ctx context.Context,
	tx *sql.Tx,
	input CreateDesktopHandoffInput,
	issuer DesktopHandoffTicketIssuer,
) (CreateDesktopHandoffResult, bool, error) {
	item, found, err := loadDesktopHandoffByIdempotency(ctx, tx, input)
	if err != nil || !found {
		return CreateDesktopHandoffResult{}, found, err
	}
	if item.RequestHash != input.RequestHash || item.RequestedBy != input.ActorID ||
		item.SessionID != input.SessionID || item.DeviceID != input.DeviceID ||
		item.ExpectedSessionRevision != input.ExpectedSessionRevision {
		return CreateDesktopHandoffResult{}, true, ErrIdempotencyReuse
	}
	issued, err := issuer(item, item.IssuedAt)
	if err != nil {
		return CreateDesktopHandoffResult{}, true, err
	}
	if !matchesPersistedDesktopToken(issued, item.TicketHash, item.TokenKeyID,
		item.TicketNonceHash, item.ExpiresAt, item.IssuedAt, DesktopHandoffLifetime) {
		return CreateDesktopHandoffResult{}, true, ErrDesktopHandoffTokenReconstruction
	}
	return CreateDesktopHandoffResult{
		Handoff: item, Ticket: issued.Token, Nonce: issued.Nonce, Created: false,
	}, true, nil
}

func replayDesktopHandoffClaim(
	ctx context.Context,
	tx *sql.Tx,
	input ClaimDesktopHandoffInput,
	request deviceauth.LedgerRequest,
	issuer DesktopClaimTokenIssuer,
) (ClaimDesktopHandoffResult, bool, error) {
	existing, err := loadExactDeviceLedger(ctx, tx, request)
	if err != nil || existing == nil {
		return ClaimDesktopHandoffResult{}, false, err
	}
	decision, err := decideExactDeviceLedger(request, existing)
	if err != nil {
		return ClaimDesktopHandoffResult{}, true, err
	}
	if decision.Action != deviceauth.LedgerReturnRecorded || decision.ResponseReference != claimResponseReference(input.HandoffID) {
		return ClaimDesktopHandoffResult{}, true, ErrDeviceProofReplayed
	}
	item, found, err := loadDesktopHandoffByID(ctx, tx, input.HandoffID, false)
	if err != nil {
		return ClaimDesktopHandoffResult{}, true, err
	}
	if !found || item.SessionID != input.SessionID || item.DeviceID != input.TargetDeviceID ||
		!item.ClaimTokenIssuedAt.Valid || !item.ClaimedSessionRevision.Valid || !item.ClaimExpiresAt.Valid ||
		item.ClaimTokenHash == "" || item.ClaimTokenKeyID == "" || item.ClaimTokenNonceHash == "" {
		return ClaimDesktopHandoffResult{}, true, deviceauth.ErrInvalidLedgerState
	}
	issued, err := issuer(item, item.ClaimTokenIssuedAt.Time)
	if err != nil {
		return ClaimDesktopHandoffResult{}, true, err
	}
	if !matchesPersistedDesktopToken(issued, item.ClaimTokenHash, item.ClaimTokenKeyID,
		item.ClaimTokenNonceHash, item.ClaimExpiresAt.Time, item.ClaimTokenIssuedAt.Time, DesktopClaimTokenLifetime) {
		return ClaimDesktopHandoffResult{}, true, ErrDesktopHandoffTokenReconstruction
	}
	return ClaimDesktopHandoffResult{
		Handoff: item, ClaimToken: issued.Token,
		SessionRevision: item.ClaimedSessionRevision.Int64, Replayed: true,
	}, true, nil
}

func validateNewDesktopHandoffClaim(
	input ClaimDesktopHandoffInput,
	request deviceauth.LedgerRequest,
	ticket VerifiedDesktopHandoffTicket,
	session storedDesktopHandoffSession,
	handoff DesktopHandoffProjection,
	binding storedDeviceBinding,
	bindingFound bool,
	device storedDevice,
	deviceFound bool,
	now time.Time,
) error {
	if handoff.Status != "pending" {
		return ErrDesktopHandoffClaimConflict
	}
	if handoff.ID != ticket.HandoffID || handoff.SessionID != ticket.SessionID ||
		handoff.ExecutorID != ticket.ExecutorID || handoff.DeviceID != ticket.DeviceID ||
		handoff.RequestedBy != ticket.ActorID || handoff.ExpectedSessionRevision != ticket.ExpectedSessionRevision ||
		handoff.TicketHash != request.AuthorizationTokenHash || handoff.TicketHash != ticket.TokenHash {
		return ErrDesktopHandoffTokenMismatch
	}
	if !now.Before(handoff.ExpiresAt) {
		return ErrDesktopHandoffExpired
	}
	if session.ID != ticket.SessionID || session.ExecutorID != ticket.ExecutorID ||
		session.RuntimeType != "desktop" || session.FlowType != "browser" || session.Status != "starting" ||
		session.RequestedBy != ticket.ActorID || session.BoundDeviceID != "" {
		return ErrDesktopHandoffTargetMismatch
	}
	if session.Revision != ticket.ExpectedSessionRevision {
		return ErrRevisionConflict
	}
	if !now.Before(session.SessionDeadlineAt) {
		return ErrDesktopHandoffExpired
	}
	if !bindingFound || binding.Status != "active" || binding.ExecutorID != ticket.ExecutorID || binding.DeviceID != ticket.DeviceID {
		return ErrDesktopHandoffTargetMismatch
	}
	if !deviceFound {
		return ErrNotFound
	}
	if device.Projection.ID != ticket.DeviceID || device.Projection.Status != "active" ||
		device.Projection.WorkspaceType != "platform" || device.Projection.WorkspaceID != "platform_root" {
		return ErrDesktopHandoffTargetMismatch
	}
	if !device.Heartbeat.Valid || device.Heartbeat.Time.After(now) ||
		now.Sub(device.Heartbeat.Time) > DesktopDeviceOnlineWindow {
		return ErrDesktopDeviceOffline
	}
	if device.Projection.KeyGeneration != input.KeyGeneration {
		return ErrDeviceKeyGenerationMismatch
	}
	if err := deviceauth.ValidateTimestamp(input.Proof.TimestampMilli, now); err != nil {
		return err
	}
	if input.ClaimedAt.After(now.Add(deviceauth.ClockWindow)) || input.ClaimedAt.Before(now.Add(-deviceauth.ClockWindow)) {
		return deviceauth.ErrTimestampOutsideWindow
	}
	return validateLedgerExpiry(input.LedgerExpiresAt, now)
}

func acceptDesktopHandoffClaimProof(
	ctx context.Context,
	tx *sql.Tx,
	request deviceauth.LedgerRequest,
	device storedDevice,
	now time.Time,
	ledgerExpiresAt time.Time,
	responseReference string,
) error {
	decision, _, err := decideStoredLedger(ctx, tx, request, device.Projection.LastAcceptedSequence)
	if err != nil {
		return err
	}
	if decision.Action == deviceauth.LedgerReturnRecorded {
		return ErrDesktopHandoffTokenReconstruction
	}
	if decision.Action == deviceauth.LedgerRejectReplay {
		return ErrDeviceProofReplayed
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_device
		SET last_accepted_sequence=$2,updated_at=$3
		WHERE id=$1 AND status='active' AND workspace_type='platform' AND workspace_id='platform_root'
		  AND key_generation=$4 AND last_accepted_sequence=$5
	`, request.DeviceID, int64(request.Sequence), now, int64(request.KeyGeneration),
		int64(device.Projection.LastAcceptedSequence))
	if err != nil {
		return classifyControlWrite(err)
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ErrDeviceProofReplayed
	}
	return insertDeviceLedger(ctx, tx, request, responseReference, now, ledgerExpiresAt)
}

func validateDesktopHandoffClaimInput(input ClaimDesktopHandoffInput) (deviceauth.LedgerRequest, error) {
	if !validOpaqueValue(input.SessionID) || !validOpaqueValue(input.HandoffID) ||
		deviceauth.ValidateDeviceID(input.TargetDeviceID) != nil || input.KeyGeneration == 0 ||
		input.KeyGeneration > math.MaxInt64 || input.ClaimedAt.IsZero() ||
		input.Proof.DeviceID != input.TargetDeviceID || input.Proof.TimestampMilli <= 0 ||
		input.Proof.Sequence == 0 || input.Proof.Sequence > math.MaxInt64 ||
		validateStoreDigest(input.Proof.BodySHA256, false) != nil ||
		validateStoreDigest(input.Proof.AuthorizationTokenHash, false) != nil {
		return deviceauth.LedgerRequest{}, ErrDesktopHandoffInputInvalid
	}
	method, err := deviceauth.CanonicalMethod(input.Proof.CanonicalMethod)
	if err != nil || method != "POST" {
		return deviceauth.LedgerRequest{}, ErrDesktopHandoffInputInvalid
	}
	path, err := deviceauth.CanonicalPath(input.Proof.CanonicalPath)
	if err != nil || path != desktopHandoffClaimPath(input.SessionID, input.HandoffID) {
		return deviceauth.LedgerRequest{}, ErrDesktopHandoffTargetMismatch
	}
	request, err := ledgerRequestFromProof(input.Proof, input.KeyGeneration)
	if err != nil {
		return deviceauth.LedgerRequest{}, err
	}
	return request, nil
}

func validCreateDesktopHandoffInput(input CreateDesktopHandoffInput) bool {
	return validOpaqueValue(input.ID) && validOpaqueValue(input.SessionID) && validOpaqueValue(input.ActorID) &&
		deviceauth.ValidateDeviceID(input.DeviceID) == nil && input.ExpectedSessionRevision > 0 &&
		input.ExpectedSessionRevision < math.MaxInt64 && validateStoreDigest(input.IdempotencyKeyHash, false) == nil &&
		validateStoreDigest(input.RequestHash, false) == nil
}

func validVerifiedDesktopHandoffTicket(
	ticket VerifiedDesktopHandoffTicket,
	input ClaimDesktopHandoffInput,
	request deviceauth.LedgerRequest,
) bool {
	return ticket.TokenID == input.HandoffID && ticket.HandoffID == input.HandoffID &&
		ticket.SessionID == input.SessionID && ticket.DeviceID == input.TargetDeviceID &&
		validOpaqueValue(ticket.ExecutorID) && validOpaqueValue(ticket.ActorID) &&
		ticket.ExpectedSessionRevision > 0 && ticket.ExpectedSessionRevision < math.MaxInt64 &&
		validateStoreDigest(ticket.TokenHash, false) == nil && ticket.TokenHash == request.AuthorizationTokenHash
}

func validIssuedDesktopToken(issued IssuedDesktopToken, issuedAt time.Time, lifetime time.Duration) bool {
	return issued.Token != "" && len(issued.Token) <= 16<<10 &&
		validateStoreDigest(issued.Hash, false) == nil && trustedtoken.Hash(issued.Token) == issued.Hash &&
		desktopHandoffKeyIDPattern.MatchString(issued.KeyID) && deviceauth.ValidateNonce(issued.Nonce) == nil &&
		validateStoreDigest(issued.NonceHash, false) == nil && digestDesktopTokenNonce(issued.Nonce) == issued.NonceHash &&
		issued.ExpiresAt.Equal(issuedAt.Add(lifetime))
}

func matchesPersistedDesktopToken(
	issued IssuedDesktopToken,
	hash, keyID, nonceHash string,
	expiresAt, issuedAt time.Time,
	lifetime time.Duration,
) bool {
	return validIssuedDesktopToken(issued, issuedAt, lifetime) && issued.Hash == hash && issued.KeyID == keyID &&
		issued.NonceHash == nonceHash && issued.ExpiresAt.Equal(expiresAt)
}

func loadDesktopHandoffSessionForUpdate(
	ctx context.Context,
	tx *sql.Tx,
	sessionID string,
) (storedDesktopHandoffSession, bool, error) {
	var item storedDesktopHandoffSession
	err := tx.QueryRowContext(ctx, `
		SELECT id,executor_id,runtime_type,flow_type,status,requested_by,bound_device_id,
		       revision,current_sequence,session_deadline_at
		FROM ky_ai_executor_authorization_session WHERE id=$1 FOR UPDATE
	`, sessionID).Scan(&item.ID, &item.ExecutorID, &item.RuntimeType, &item.FlowType,
		&item.Status, &item.RequestedBy, &item.BoundDeviceID, &item.Revision,
		&item.CurrentSequence, &item.SessionDeadlineAt)
	if errors.Is(err, sql.ErrNoRows) {
		return storedDesktopHandoffSession{}, false, nil
	}
	return item, err == nil, err
}

func loadDesktopHandoffByIdempotency(
	ctx context.Context,
	tx *sql.Tx,
	input CreateDesktopHandoffInput,
) (DesktopHandoffProjection, bool, error) {
	row := tx.QueryRowContext(ctx, desktopHandoffSelect+`
		WHERE requested_by=$1 AND session_id=$2 AND device_id=$3 AND idempotency_key_hash=$4
	`, input.ActorID, input.SessionID, input.DeviceID, input.IdempotencyKeyHash)
	return scanDesktopHandoff(row)
}

func loadDesktopHandoffForUpdate(
	ctx context.Context,
	tx *sql.Tx,
	handoffID string,
) (DesktopHandoffProjection, bool, error) {
	return loadDesktopHandoffByID(ctx, tx, handoffID, true)
}

func loadDesktopHandoffByID(
	ctx context.Context,
	tx *sql.Tx,
	handoffID string,
	forUpdate bool,
) (DesktopHandoffProjection, bool, error) {
	query := desktopHandoffSelect + ` WHERE id=$1`
	if forUpdate {
		query += ` FOR UPDATE`
	}
	return scanDesktopHandoff(tx.QueryRowContext(ctx, query, handoffID))
}

const desktopHandoffSelect = `
	SELECT id,session_id,executor_id,device_id,requested_by,expected_session_revision,
	       idempotency_key_hash,request_hash,ticket_hash,ticket_nonce_hash,token_key_id,
	       status,issued_at,expires_at,claimed_at,claimed_session_revision,
	       claim_token_hash,claim_token_key_id,claim_token_nonce_hash,
	       claim_token_issued_at,claim_expires_at
	FROM ky_ai_executor_desktop_handoff
`

func scanDesktopHandoff(row rowScanner) (DesktopHandoffProjection, bool, error) {
	var item DesktopHandoffProjection
	err := row.Scan(&item.ID, &item.SessionID, &item.ExecutorID, &item.DeviceID,
		&item.RequestedBy, &item.ExpectedSessionRevision, &item.IdempotencyKeyHash,
		&item.RequestHash, &item.TicketHash, &item.TicketNonceHash, &item.TokenKeyID,
		&item.Status, &item.IssuedAt, &item.ExpiresAt, &item.ClaimedAt,
		&item.ClaimedSessionRevision, &item.ClaimTokenHash, &item.ClaimTokenKeyID,
		&item.ClaimTokenNonceHash, &item.ClaimTokenIssuedAt, &item.ClaimExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return DesktopHandoffProjection{}, false, nil
	}
	return item, err == nil, err
}

func commitDesktopHandoffCreationReplay(
	tx *sql.Tx,
	result CreateDesktopHandoffResult,
	replayErr error,
) (CreateDesktopHandoffResult, error) {
	if replayErr != nil {
		return CreateDesktopHandoffResult{}, replayErr
	}
	if err := tx.Commit(); err != nil {
		return CreateDesktopHandoffResult{}, classifyControlWrite(err)
	}
	return result, nil
}

func commitDesktopHandoffClaimReplay(
	tx *sql.Tx,
	result ClaimDesktopHandoffResult,
	replayErr error,
) (ClaimDesktopHandoffResult, error) {
	if replayErr != nil {
		return ClaimDesktopHandoffResult{}, replayErr
	}
	if err := tx.Commit(); err != nil {
		return ClaimDesktopHandoffResult{}, classifyControlWrite(err)
	}
	return result, nil
}

func claimResponseReference(handoffID string) string {
	return "desktop_claim_" + handoffID
}

func desktopHandoffClaimPath(sessionID, handoffID string) string {
	return "/api/v1/ai-executor-authorization-sessions/" + sessionID + "/desktop-handoffs/" + handoffID + "/claim"
}

func digestDesktopTokenNonce(nonce string) string {
	digest := sha256.Sum256([]byte(nonce))
	return hex.EncodeToString(digest[:])
}

func errOrDesktopHandoffInputInvalid(err error) error {
	if err != nil {
		return err
	}
	return ErrDesktopHandoffInputInvalid
}
