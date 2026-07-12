package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
)

const (
	DesktopActivationLifetime = 10 * time.Minute
	desktopOperationLeaseTTL  = 30 * time.Second
	desktopDigestAlgorithm    = "aicrm-credential-tree-rfc8785-nfc-v1"
)

var (
	ErrDesktopProofInputInvalid             = errors.New("desktop authorization proof input invalid")
	ErrDesktopProofConflict                 = errors.New("desktop authorization proof conflict")
	ErrDesktopClaimTokenMismatch            = errors.New("desktop claim token mismatch")
	ErrDesktopAccountIntentConflict         = errors.New("desktop authorization account does not match intent")
	ErrDesktopActivationInputInvalid        = errors.New("desktop activation input invalid")
	ErrDesktopActivationConflict            = errors.New("desktop activation conflict")
	ErrDesktopActivationTokenMismatch       = errors.New("desktop activation token mismatch")
	ErrDesktopActivationTokenReconstruction = errors.New("desktop activation token reconstruction failed")
)

type DesktopAuthorizationProofProjection struct {
	ID                      string
	SessionID               string
	HandoffID               string
	ExecutorID              string
	DeviceID                string
	SessionRevision         int64
	LoginIDHash             string
	Result                  string
	AccountFingerprint      string
	CandidateBindingDigest  string
	RequestHash             string
	ClaimTokenHash          string
	DeviceKeyGeneration     int64
	DeviceSequence          int64
	ResponseReference       string
	ResponseSessionRevision int64
	CheckedAt               time.Time
	CreatedAt               time.Time
}

type DesktopCredentialActivationProjection struct {
	ID                       string
	SessionID                string
	ProofID                  string
	ExecutorID               string
	DeviceID                 string
	OperationID              string
	CredentialRevision       int64
	LeaseEpoch               int64
	SourceCredentialRevision int64
	RevocationEpoch          int64
	DeviceBindingRevision    int64
	BindingDigest            string
	ActivationTokenHash      string
	ActivationTokenKeyID     string
	ActivationTokenNonceHash string
	RequestHash              string
	AckRequestHash           string
	AckDeviceKeyGeneration   int64
	AckDeviceSequence        int64
	Status                   string
	IssuedAt                 time.Time
	ExpiresAt                time.Time
	DurableBarrierAt         sql.NullTime
	AcknowledgedAt           sql.NullTime
	ActivatedAt              sql.NullTime
}

type VerifiedDesktopClaimToken struct {
	TokenID                 string
	HandoffID               string
	SessionID               string
	ExecutorID              string
	DeviceID                string
	ExpectedSessionRevision int64
	TokenHash               string
}

type DesktopClaimTokenVerifier func(time.Time) (VerifiedDesktopClaimToken, error)
type DesktopActivationTokenIssuer func(DesktopCredentialActivationProjection, time.Time) (IssuedDesktopToken, error)

type SubmitDesktopAuthorizationProofInput struct {
	ProofID                string
	OperationID            string
	ActivationID           string
	SessionID              string
	HandoffID              string
	TargetDeviceID         string
	KeyGeneration          uint64
	SessionRevision        int64
	LoginIDHash            string
	Result                 string
	CheckedAt              time.Time
	AccountFingerprint     string
	CandidateBindingDigest string
	Proof                  deviceauth.VerifiedRequest
	LedgerExpiresAt        time.Time
}

type SubmitDesktopAuthorizationProofResult struct {
	Proof           DesktopAuthorizationProofProjection
	Activation      *DesktopCredentialActivationProjection
	ActivationToken string
	SessionRevision int64
	Replayed        bool
}

type VerifiedDesktopActivationToken struct {
	TokenID                  string
	ActivationID             string
	SessionID                string
	ExecutorID               string
	DeviceID                 string
	OperationID              string
	CredentialRevision       int64
	LeaseEpoch               int64
	SourceCredentialRevision int64
	RevocationEpoch          int64
	BindingDigest            string
	TokenHash                string
}

type DesktopActivationTokenVerifier func(time.Time) (VerifiedDesktopActivationToken, error)

type AcknowledgeDesktopCredentialActivationInput struct {
	SessionID                 string
	ActivationID              string
	TargetDeviceID            string
	KeyGeneration             uint64
	OperationID               string
	CredentialRevision        int64
	LeaseEpoch                int64
	SourceCredentialRevision  int64
	RevocationEpoch           int64
	DurableBarrierCompletedAt time.Time
	BindingDigest             string
	Proof                     deviceauth.VerifiedRequest
	LedgerExpiresAt           time.Time
}

type AcknowledgeDesktopCredentialActivationResult struct {
	ActivationID       string
	ExecutorID         string
	CredentialRevision int64
	SessionRevision    int64
	Replayed           bool
}

type storedDesktopActivationSession struct {
	ID                         string
	ExecutorID                 string
	RuntimeType                string
	FlowType                   string
	Intent                     string
	Status                     string
	RequestedBy                string
	BoundDeviceID              string
	LoginIDHash                string
	OperationID                string
	PreparedCredentialRevision sql.NullInt64
	Revision                   int64
	CurrentSequence            int64
	SessionDeadlineAt          time.Time
}

type storedDesktopActivationExecutor struct {
	RuntimeType               string
	Status                    string
	CredentialStatus          string
	CurrentCredentialRevision sql.NullInt64
	CredentialRevisionCounter int64
	RevocationEpoch           int64
	RuntimeBindingID          string
	RuntimeBindingRevision    int64
}

func (s *ControlStore) SubmitDesktopAuthorizationProof(
	ctx context.Context,
	input SubmitDesktopAuthorizationProofInput,
	verifier DesktopClaimTokenVerifier,
	issuer DesktopActivationTokenIssuer,
) (SubmitDesktopAuthorizationProofResult, error) {
	request, err := validateDesktopAuthorizationProofInput(input)
	if err != nil || verifier == nil || issuer == nil {
		return SubmitDesktopAuthorizationProofResult{}, errOrDesktopProofInputInvalid(err)
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return SubmitDesktopAuthorizationProofResult{}, err
	}
	defer tx.Rollback()
	if result, handled, err := replayDesktopAuthorizationProof(ctx, tx, input, request, issuer); handled || err != nil {
		return commitDesktopAuthorizationProofReplay(tx, result, err)
	}
	initialHandoff, found, err := loadDesktopHandoffByID(ctx, tx, input.HandoffID, false)
	if err != nil {
		return SubmitDesktopAuthorizationProofResult{}, err
	}
	if !found {
		return SubmitDesktopAuthorizationProofResult{}, ErrNotFound
	}
	if err := lockBindableExecutor(ctx, tx, initialHandoff.ExecutorID); err != nil {
		return SubmitDesktopAuthorizationProofResult{}, err
	}
	executor, err := loadDesktopActivationExecutor(ctx, tx, initialHandoff.ExecutorID)
	if err != nil {
		return SubmitDesktopAuthorizationProofResult{}, err
	}
	session, found, err := loadDesktopActivationSessionForUpdate(ctx, tx, input.SessionID)
	if err != nil {
		return SubmitDesktopAuthorizationProofResult{}, err
	}
	if !found {
		return SubmitDesktopAuthorizationProofResult{}, ErrNotFound
	}
	handoff, found, err := loadDesktopHandoffForUpdate(ctx, tx, input.HandoffID)
	if err != nil {
		return SubmitDesktopAuthorizationProofResult{}, err
	}
	if !found {
		return SubmitDesktopAuthorizationProofResult{}, ErrNotFound
	}
	binding, bindingFound, err := loadDeviceBindingForUpdate(ctx, tx, initialHandoff.ExecutorID)
	if err != nil {
		return SubmitDesktopAuthorizationProofResult{}, err
	}
	device, deviceFound, err := loadDeviceForUpdate(ctx, tx, input.TargetDeviceID)
	if err != nil {
		return SubmitDesktopAuthorizationProofResult{}, err
	}
	if result, handled, err := replayDesktopAuthorizationProof(ctx, tx, input, request, issuer); handled || err != nil {
		return commitDesktopAuthorizationProofReplay(tx, result, err)
	}
	now, err := transactionNow(ctx, tx)
	if err != nil {
		return SubmitDesktopAuthorizationProofResult{}, err
	}
	claim, err := verifier(now)
	if err != nil {
		return SubmitDesktopAuthorizationProofResult{}, err
	}
	if err := validateNewDesktopAuthorizationProof(
		input, request, claim, executor, session, handoff, binding, bindingFound, device, deviceFound, now,
	); err != nil {
		return SubmitDesktopAuthorizationProofResult{}, err
	}
	if input.Result == "succeeded" {
		if err := validateDesktopAccountIntent(ctx, tx, session.ExecutorID, session.Intent, executor, input.AccountFingerprint); err != nil {
			return SubmitDesktopAuthorizationProofResult{}, err
		}
	}
	responseReference := desktopProofResponseReference(input.HandoffID)
	if err := acceptDesktopHandoffClaimProof(ctx, tx, request, device, now, input.LedgerExpiresAt, responseReference); err != nil {
		return SubmitDesktopAuthorizationProofResult{}, err
	}
	if err := consumeDesktopClaim(ctx, tx, handoff, request.AuthorizationTokenHash, now); err != nil {
		return SubmitDesktopAuthorizationProofResult{}, err
	}

	responseRevision := session.Revision + 1
	proof := DesktopAuthorizationProofProjection{
		ID: input.ProofID, SessionID: input.SessionID, HandoffID: input.HandoffID,
		ExecutorID: handoff.ExecutorID, DeviceID: input.TargetDeviceID,
		SessionRevision: input.SessionRevision, LoginIDHash: input.LoginIDHash,
		Result: input.Result, AccountFingerprint: input.AccountFingerprint,
		CandidateBindingDigest: input.CandidateBindingDigest, RequestHash: request.RequestHash,
		ClaimTokenHash: request.AuthorizationTokenHash, DeviceKeyGeneration: int64(input.KeyGeneration),
		DeviceSequence: int64(request.Sequence), ResponseReference: responseReference,
		ResponseSessionRevision: responseRevision, CheckedAt: input.CheckedAt, CreatedAt: now,
	}
	if input.Result != "succeeded" {
		if err := terminalizeDesktopAuthorizationProof(ctx, tx, session, proof, now); err != nil {
			return SubmitDesktopAuthorizationProofResult{}, err
		}
		if err := insertDesktopAuthorizationProof(ctx, tx, proof); err != nil {
			return SubmitDesktopAuthorizationProofResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return SubmitDesktopAuthorizationProofResult{}, classifyControlWrite(err)
		}
		return SubmitDesktopAuthorizationProofResult{
			Proof: proof, SessionRevision: responseRevision,
		}, nil
	}

	if err := insertDesktopAuthorizationProof(ctx, tx, proof); err != nil {
		return SubmitDesktopAuthorizationProofResult{}, err
	}
	activation, activationToken, err := prepareDesktopCredentialActivation(
		ctx, tx, input, proof, executor, binding, now, issuer,
	)
	if err != nil {
		return SubmitDesktopAuthorizationProofResult{}, err
	}
	if err := markDesktopSessionVerifying(ctx, tx, session, proof, activation, now); err != nil {
		return SubmitDesktopAuthorizationProofResult{}, err
	}
	if err := insertDesktopActivationAudit(ctx, tx, activation, 1, "prepared", request.RequestHash, now); err != nil {
		return SubmitDesktopAuthorizationProofResult{}, err
	}
	if err := insertControlOutbox(ctx, tx, "credential_binding",
		activation.ExecutorID+":"+itoa64(activation.CredentialRevision), 1,
		"credential_prepared", map[string]any{
			"executorId": activation.ExecutorID, "sessionId": activation.SessionID,
			"credentialRevision": activation.CredentialRevision,
		}); err != nil {
		return SubmitDesktopAuthorizationProofResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return SubmitDesktopAuthorizationProofResult{}, classifyControlWrite(err)
	}
	return SubmitDesktopAuthorizationProofResult{
		Proof: proof, Activation: &activation, ActivationToken: activationToken,
		SessionRevision: responseRevision,
	}, nil
}

func (s *ControlStore) AcknowledgeDesktopCredentialActivation(
	ctx context.Context,
	input AcknowledgeDesktopCredentialActivationInput,
	verifier DesktopActivationTokenVerifier,
) (AcknowledgeDesktopCredentialActivationResult, error) {
	request, err := validateDesktopActivationACKInput(input)
	if err != nil || verifier == nil {
		return AcknowledgeDesktopCredentialActivationResult{}, errOrDesktopActivationInputInvalid(err)
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return AcknowledgeDesktopCredentialActivationResult{}, err
	}
	defer tx.Rollback()
	if result, handled, err := replayDesktopActivationACK(ctx, tx, input, request); handled || err != nil {
		return commitDesktopActivationACKReplay(tx, result, err)
	}
	initial, found, err := loadDesktopActivationByID(ctx, tx, input.ActivationID, false)
	if err != nil {
		return AcknowledgeDesktopCredentialActivationResult{}, err
	}
	if !found {
		return AcknowledgeDesktopCredentialActivationResult{}, ErrNotFound
	}
	if err := lockBindableExecutor(ctx, tx, initial.ExecutorID); err != nil {
		return AcknowledgeDesktopCredentialActivationResult{}, err
	}
	executor, err := loadDesktopActivationExecutor(ctx, tx, initial.ExecutorID)
	if err != nil {
		return AcknowledgeDesktopCredentialActivationResult{}, err
	}
	session, found, err := loadDesktopActivationSessionForUpdate(ctx, tx, input.SessionID)
	if err != nil {
		return AcknowledgeDesktopCredentialActivationResult{}, err
	}
	if !found {
		return AcknowledgeDesktopCredentialActivationResult{}, ErrNotFound
	}
	activation, found, err := loadDesktopActivationByID(ctx, tx, input.ActivationID, true)
	if err != nil {
		return AcknowledgeDesktopCredentialActivationResult{}, err
	}
	if !found {
		return AcknowledgeDesktopCredentialActivationResult{}, ErrNotFound
	}
	binding, bindingFound, err := loadDeviceBindingForUpdate(ctx, tx, activation.ExecutorID)
	if err != nil {
		return AcknowledgeDesktopCredentialActivationResult{}, err
	}
	device, deviceFound, err := loadDeviceForUpdate(ctx, tx, input.TargetDeviceID)
	if err != nil {
		return AcknowledgeDesktopCredentialActivationResult{}, err
	}
	if result, handled, err := replayDesktopActivationACK(ctx, tx, input, request); handled || err != nil {
		return commitDesktopActivationACKReplay(tx, result, err)
	}
	now, err := transactionNow(ctx, tx)
	if err != nil {
		return AcknowledgeDesktopCredentialActivationResult{}, err
	}
	token, err := verifier(now)
	if err != nil {
		return AcknowledgeDesktopCredentialActivationResult{}, err
	}
	if err := validateNewDesktopActivationACK(
		ctx, tx, input, request, token, executor, session, activation,
		binding, bindingFound, device, deviceFound, now,
	); err != nil {
		return AcknowledgeDesktopCredentialActivationResult{}, err
	}
	responseReference := desktopActivationResponseReference(input.ActivationID)
	if err := acceptDesktopHandoffClaimProof(ctx, tx, request, device, now, input.LedgerExpiresAt, responseReference); err != nil {
		return AcknowledgeDesktopCredentialActivationResult{}, err
	}
	if err := activateDesktopCredential(ctx, tx, input, request, executor, session, activation, now); err != nil {
		return AcknowledgeDesktopCredentialActivationResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return AcknowledgeDesktopCredentialActivationResult{}, classifyControlWrite(err)
	}
	return AcknowledgeDesktopCredentialActivationResult{
		ActivationID: input.ActivationID, ExecutorID: activation.ExecutorID,
		CredentialRevision: activation.CredentialRevision, SessionRevision: session.Revision + 1,
	}, nil
}

func prepareDesktopCredentialActivation(
	ctx context.Context,
	tx *sql.Tx,
	input SubmitDesktopAuthorizationProofInput,
	proof DesktopAuthorizationProofProjection,
	executor storedDesktopActivationExecutor,
	binding storedDeviceBinding,
	now time.Time,
	issuer DesktopActivationTokenIssuer,
) (DesktopCredentialActivationProjection, string, error) {
	sourceRevision := int64(0)
	if executor.CurrentCredentialRevision.Valid {
		sourceRevision = executor.CurrentCredentialRevision.Int64
	}
	var leaseEpoch int64
	err := tx.QueryRowContext(ctx, `
		INSERT INTO ky_ai_executor_operation_lease (
		 executor_id,operation_id,owner_instance_id,lease_epoch,lease_expires_at,
		 source_credential_revision,revocation_epoch,status
		) VALUES ($1,$2,$3,1,$4,$5,$6,'active')
		ON CONFLICT (executor_id) DO UPDATE SET
		 operation_id=EXCLUDED.operation_id,
		 owner_instance_id=EXCLUDED.owner_instance_id,
		 lease_epoch=ky_ai_executor_operation_lease.lease_epoch+1,
		 lease_expires_at=EXCLUDED.lease_expires_at,
		 source_credential_revision=EXCLUDED.source_credential_revision,
		 revocation_epoch=EXCLUDED.revocation_epoch,
		 status='active',updated_at=$7
		WHERE ky_ai_executor_operation_lease.status<>'active'
		   OR ky_ai_executor_operation_lease.lease_expires_at<=$7
		RETURNING lease_epoch
	`, proof.ExecutorID, input.OperationID, desktopLeaseOwner(input.TargetDeviceID),
		now.Add(desktopOperationLeaseTTL), sourceRevision, executor.RevocationEpoch, now).Scan(&leaseEpoch)
	if errors.Is(err, sql.ErrNoRows) {
		return DesktopCredentialActivationProjection{}, "", ErrExecutorBusy
	}
	if err != nil {
		return DesktopCredentialActivationProjection{}, "", classifyControlWrite(err)
	}
	credentialRevision := executor.CredentialRevisionCounter + 1
	activation := DesktopCredentialActivationProjection{
		ID: input.ActivationID, SessionID: input.SessionID, ProofID: input.ProofID,
		ExecutorID: proof.ExecutorID, DeviceID: input.TargetDeviceID, OperationID: input.OperationID,
		CredentialRevision: credentialRevision, LeaseEpoch: leaseEpoch,
		SourceCredentialRevision: sourceRevision, RevocationEpoch: executor.RevocationEpoch,
		DeviceBindingRevision: binding.Revision, BindingDigest: input.CandidateBindingDigest,
		RequestHash: proof.RequestHash, Status: "pending",
		IssuedAt: now.UTC().Truncate(time.Second),
	}
	activation.ExpiresAt = activation.IssuedAt.Add(DesktopActivationLifetime)
	issued, err := issuer(activation, activation.IssuedAt)
	if err != nil {
		return DesktopCredentialActivationProjection{}, "", err
	}
	if !validIssuedDesktopToken(issued, activation.IssuedAt, DesktopActivationLifetime) {
		return DesktopCredentialActivationProjection{}, "", ErrDesktopActivationInputInvalid
	}
	activation.ActivationTokenHash = issued.Hash
	activation.ActivationTokenKeyID = issued.KeyID
	activation.ActivationTokenNonceHash = issued.NonceHash
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_credential_binding (
		 executor_id,revision,status,authorization_session_id,runtime_type,
		 runtime_binding_id,runtime_binding_revision,device_id,account_fingerprint,
		 auth_mode,plan_type,binding_digest,revocation_epoch,verified_at,
		 operation_id,lease_epoch,source_credential_revision,digest_algorithm
		) VALUES ($1,$2,'prepared',$3,'desktop',$4,$5,$4,$6,'browser','',$7,$8,$9,$10,$11,$12,$13)
	`, activation.ExecutorID, credentialRevision, activation.SessionID, activation.DeviceID,
		binding.Revision, input.AccountFingerprint, input.CandidateBindingDigest,
		executor.RevocationEpoch, input.CheckedAt, input.OperationID, leaseEpoch,
		sourceRevision, desktopDigestAlgorithm); err != nil {
		return DesktopCredentialActivationProjection{}, "", classifyControlWrite(err)
	}
	updated, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_config
		SET credential_revision_counter=$2,updated_at=$3
		WHERE id=$1 AND credential_revision_counter=$4 AND revocation_epoch=$5
		  AND COALESCE(current_credential_revision,0)=$6
		  AND runtime_binding_id=$7 AND runtime_binding_revision=$8
	`, activation.ExecutorID, credentialRevision, now, executor.CredentialRevisionCounter,
		executor.RevocationEpoch, sourceRevision,
		executor.RuntimeBindingID, executor.RuntimeBindingRevision)
	if err != nil {
		return DesktopCredentialActivationProjection{}, "", err
	}
	if affected, _ := updated.RowsAffected(); affected != 1 {
		return DesktopCredentialActivationProjection{}, "", ErrExecutorFenced
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_credential_activation (
		 id,session_id,proof_id,executor_id,device_id,operation_id,
		 credential_revision,lease_epoch,source_credential_revision,revocation_epoch,
		 binding_digest,activation_token_hash,request_hash,status,issued_at,expires_at,
		 device_binding_revision,activation_token_key_id,activation_token_nonce_hash
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14,$15,$16,$17,$18)
	`, activation.ID, activation.SessionID, activation.ProofID, activation.ExecutorID,
		activation.DeviceID, activation.OperationID, activation.CredentialRevision,
		activation.LeaseEpoch, activation.SourceCredentialRevision, activation.RevocationEpoch,
		activation.BindingDigest, activation.ActivationTokenHash, activation.RequestHash,
		activation.IssuedAt, activation.ExpiresAt, activation.DeviceBindingRevision,
		activation.ActivationTokenKeyID, activation.ActivationTokenNonceHash); err != nil {
		return DesktopCredentialActivationProjection{}, "", classifyControlWrite(err)
	}
	return activation, issued.Token, nil
}

func terminalizeDesktopAuthorizationProof(
	ctx context.Context,
	tx *sql.Tx,
	session storedDesktopActivationSession,
	proof DesktopAuthorizationProofProjection,
	now time.Time,
) error {
	failureCode := ""
	if proof.Result == "failed" {
		failureCode = "desktop_authorization_failed"
	}
	updated, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_authorization_session
		SET status=$2,login_id_hash=$3,failure_code=$4,
		    current_sequence=current_sequence+3,revision=revision+1,
		    finished_at=$5,updated_at=$5
		WHERE id=$1 AND status='waiting_user' AND revision=$6 AND bound_device_id=$7
	`, session.ID, proof.Result, proof.LoginIDHash, failureCode, now, session.Revision, proof.DeviceID)
	if err != nil {
		return err
	}
	if affected, _ := updated.RowsAffected(); affected != 1 {
		return ErrRevisionConflict
	}
	if err := insertSessionEvent(ctx, tx, session.ID, session.CurrentSequence+1,
		AuthorizationEventChanged, map[string]any{"change": "desktop_proof", "status": proof.Result}); err != nil {
		return err
	}
	if err := insertSessionEvent(ctx, tx, session.ID, session.CurrentSequence+2,
		AuthorizationEventTerminal, map[string]any{"status": proof.Result}); err != nil {
		return err
	}
	if err := insertSessionEvent(ctx, tx, session.ID, session.CurrentSequence+3,
		AuthorizationEventClosed, map[string]any{"reason": "terminal"}); err != nil {
		return err
	}
	return insertControlOutbox(ctx, tx, "authorization_session", session.ID,
		session.Revision+1, proof.Result, map[string]any{
			"executorId": session.ExecutorID, "status": proof.Result,
		})
}

func markDesktopSessionVerifying(
	ctx context.Context,
	tx *sql.Tx,
	session storedDesktopActivationSession,
	proof DesktopAuthorizationProofProjection,
	activation DesktopCredentialActivationProjection,
	now time.Time,
) error {
	updated, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_authorization_session
		SET status='verifying',login_id_hash=$2,prepared_credential_revision=$3,
		    operation_id=$4,current_sequence=current_sequence+1,revision=revision+1,updated_at=$5
		WHERE id=$1 AND status='waiting_user' AND revision=$6 AND bound_device_id=$7
	`, session.ID, proof.LoginIDHash, activation.CredentialRevision, activation.OperationID,
		now, session.Revision, activation.DeviceID)
	if err != nil {
		return err
	}
	if affected, _ := updated.RowsAffected(); affected != 1 {
		return ErrRevisionConflict
	}
	if err := insertSessionEvent(ctx, tx, session.ID, session.CurrentSequence+1,
		AuthorizationEventChanged, map[string]any{
			"change": "desktop_proof_succeeded", "credentialRevision": activation.CredentialRevision,
		}); err != nil {
		return err
	}
	return insertControlOutbox(ctx, tx, "authorization_session", session.ID,
		session.Revision+1, "verifying", map[string]any{
			"executorId": session.ExecutorID, "credentialRevision": activation.CredentialRevision,
		})
}

func activateDesktopCredential(
	ctx context.Context,
	tx *sql.Tx,
	input AcknowledgeDesktopCredentialActivationInput,
	request deviceauth.LedgerRequest,
	executor storedDesktopActivationExecutor,
	session storedDesktopActivationSession,
	activation DesktopCredentialActivationProjection,
	now time.Time,
) error {
	if activation.SourceCredentialRevision > 0 {
		updated, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_credential_binding
			SET status='revoked',revoked_at=$3
			WHERE executor_id=$1 AND revision=$2 AND status='active' AND revocation_epoch=$4
		`, activation.ExecutorID, activation.SourceCredentialRevision, now, activation.RevocationEpoch)
		if err != nil {
			return err
		}
		if affected, _ := updated.RowsAffected(); affected != 1 {
			return ErrExecutorFenced
		}
	}
	updated, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_credential_binding
		SET status='active',verified_at=COALESCE(verified_at,$8),activated_at=$8
		WHERE executor_id=$1 AND revision=$2 AND status='prepared'
		  AND operation_id=$3 AND lease_epoch=$4 AND source_credential_revision=$5
		  AND revocation_epoch=$6 AND binding_digest=$7
	`, activation.ExecutorID, activation.CredentialRevision, activation.OperationID,
		activation.LeaseEpoch, activation.SourceCredentialRevision, activation.RevocationEpoch,
		activation.BindingDigest, now)
	if err != nil {
		return err
	}
	if affected, _ := updated.RowsAffected(); affected != 1 {
		return ErrExecutorFenced
	}
	updated, err = tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_config
		SET credential_status='authorized',current_credential_revision=$2,
		    runtime_binding_id=$3,runtime_binding_revision=$4,
		    readiness_status='degraded',readiness_reason_code='desktop_readiness_required',
		    readiness_revision=readiness_revision+1,config_revision=config_revision+1,
		    updated_at=$5
		WHERE id=$1 AND COALESCE(current_credential_revision,0)=$6
		  AND credential_revision_counter=$2 AND revocation_epoch=$7
		  AND runtime_binding_id=$8 AND runtime_binding_revision=$9
	`, activation.ExecutorID, activation.CredentialRevision, activation.DeviceID,
		activation.DeviceBindingRevision, now, activation.SourceCredentialRevision,
		activation.RevocationEpoch, executor.RuntimeBindingID, executor.RuntimeBindingRevision)
	if err != nil {
		return err
	}
	if affected, _ := updated.RowsAffected(); affected != 1 {
		return ErrExecutorFenced
	}
	var accountFingerprint string
	if err := tx.QueryRowContext(ctx, `
		SELECT account_fingerprint FROM ky_ai_executor_credential_binding
		WHERE executor_id=$1 AND revision=$2 AND status='active'
	`, activation.ExecutorID, activation.CredentialRevision).Scan(&accountFingerprint); err != nil {
		return ErrExecutorFenced
	}
	accountSummary, err := json.Marshal(map[string]string{"accountFingerprint": accountFingerprint})
	if err != nil {
		return err
	}
	updated, err = tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_authorization_session
		SET status='succeeded',account_summary_json=$2::jsonb,
		    current_sequence=current_sequence+3,revision=revision+1,
		    finished_at=$3,updated_at=$3
		WHERE id=$1 AND status='verifying' AND revision=$4
		  AND operation_id=$5 AND prepared_credential_revision=$6 AND bound_device_id=$7
	`, session.ID, string(accountSummary), now, session.Revision, activation.OperationID,
		activation.CredentialRevision, activation.DeviceID)
	if err != nil {
		return err
	}
	if affected, _ := updated.RowsAffected(); affected != 1 {
		return ErrRevisionConflict
	}
	updated, err = tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_credential_activation
		SET status='active',ack_request_hash=$2,ack_device_key_generation=$3,
		    ack_device_sequence=$4,durable_barrier_completed_at=$5,
		    acknowledged_at=$6,activated_at=$6,updated_at=$6
		WHERE id=$1 AND status='pending' AND operation_id=$7
		  AND credential_revision=$8 AND lease_epoch=$9
		  AND source_credential_revision=$10 AND revocation_epoch=$11
		  AND binding_digest=$12
	`, activation.ID, request.RequestHash, int64(input.KeyGeneration), int64(request.Sequence),
		input.DurableBarrierCompletedAt, now, activation.OperationID,
		activation.CredentialRevision, activation.LeaseEpoch,
		activation.SourceCredentialRevision, activation.RevocationEpoch,
		activation.BindingDigest)
	if err != nil {
		return err
	}
	if affected, _ := updated.RowsAffected(); affected != 1 {
		return ErrDesktopActivationConflict
	}
	updated, err = tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_operation_lease
		SET status='released',updated_at=$7
		WHERE executor_id=$1 AND operation_id=$2 AND owner_instance_id=$3
		  AND lease_epoch=$4 AND source_credential_revision=$5 AND revocation_epoch=$6
		  AND status='active' AND lease_expires_at>$7
	`, activation.ExecutorID, activation.OperationID, desktopLeaseOwner(activation.DeviceID),
		activation.LeaseEpoch, activation.SourceCredentialRevision, activation.RevocationEpoch, now)
	if err != nil {
		return err
	}
	if affected, _ := updated.RowsAffected(); affected != 1 {
		return ErrExecutorFenced
	}
	if err := insertDesktopActivationAudit(ctx, tx, activation, 2, "activated", request.RequestHash, now); err != nil {
		return err
	}
	if err := insertSessionEvent(ctx, tx, session.ID, session.CurrentSequence+1,
		AuthorizationEventChanged, map[string]any{
			"change": "credential_promoted", "credentialRevision": activation.CredentialRevision,
		}); err != nil {
		return err
	}
	if err := insertSessionEvent(ctx, tx, session.ID, session.CurrentSequence+2,
		AuthorizationEventTerminal, map[string]any{"status": "succeeded"}); err != nil {
		return err
	}
	if err := insertSessionEvent(ctx, tx, session.ID, session.CurrentSequence+3,
		AuthorizationEventClosed, map[string]any{"reason": "terminal"}); err != nil {
		return err
	}
	if err := insertControlOutbox(ctx, tx, "credential_binding",
		activation.ExecutorID+":"+itoa64(activation.CredentialRevision), 2,
		"credential_promoted", map[string]any{
			"executorId": activation.ExecutorID, "sessionId": activation.SessionID,
			"credentialRevision": activation.CredentialRevision,
		}); err != nil {
		return err
	}
	return insertControlOutbox(ctx, tx, "authorization_session", session.ID,
		session.Revision+1, "succeeded", map[string]any{
			"executorId": activation.ExecutorID, "credentialRevision": activation.CredentialRevision,
		})
}

func validateNewDesktopAuthorizationProof(
	input SubmitDesktopAuthorizationProofInput,
	request deviceauth.LedgerRequest,
	claim VerifiedDesktopClaimToken,
	executor storedDesktopActivationExecutor,
	session storedDesktopActivationSession,
	handoff DesktopHandoffProjection,
	binding storedDeviceBinding,
	bindingFound bool,
	device storedDevice,
	deviceFound bool,
	now time.Time,
) error {
	if handoff.Status != "claimed" || handoff.ClaimedAt.Valid == false ||
		handoff.ClaimTokenIssuedAt.Valid == false || handoff.ClaimExpiresAt.Valid == false ||
		handoff.ClaimedSessionRevision.Valid == false || handoff.ClaimTokenHash == "" ||
		handoff.ClaimTokenKeyID == "" || handoff.ClaimTokenNonceHash == "" {
		return ErrDesktopProofConflict
	}
	if claim.TokenID != handoff.ID || claim.HandoffID != handoff.ID ||
		claim.SessionID != handoff.SessionID || claim.ExecutorID != handoff.ExecutorID ||
		claim.DeviceID != handoff.DeviceID || claim.ExpectedSessionRevision != input.SessionRevision ||
		claim.TokenHash != request.AuthorizationTokenHash || handoff.ClaimTokenHash != request.AuthorizationTokenHash ||
		handoff.ClaimedSessionRevision.Int64 != input.SessionRevision {
		return ErrDesktopClaimTokenMismatch
	}
	if session.ID != input.SessionID || session.ExecutorID != handoff.ExecutorID ||
		session.RuntimeType != "desktop" || session.FlowType != "browser" ||
		session.Status != "waiting_user" || session.BoundDeviceID != input.TargetDeviceID ||
		session.Revision != input.SessionRevision || session.PreparedCredentialRevision.Valid || session.OperationID != "" {
		return ErrRevisionConflict
	}
	if !now.Before(session.SessionDeadlineAt) {
		return ErrDesktopHandoffExpired
	}
	if executor.RuntimeType != "desktop" || executor.Status != "enabled" {
		return ErrDesktopHandoffTargetMismatch
	}
	if !bindingFound || binding.Status != "active" || binding.ExecutorID != handoff.ExecutorID ||
		binding.DeviceID != input.TargetDeviceID {
		return ErrDesktopHandoffTargetMismatch
	}
	if !deviceFound || device.Projection.ID != input.TargetDeviceID || device.Projection.Status != "active" ||
		device.Projection.WorkspaceType != "platform" || device.Projection.WorkspaceID != "platform_root" {
		return ErrDesktopHandoffTargetMismatch
	}
	if device.Projection.KeyGeneration != input.KeyGeneration {
		return ErrDeviceKeyGenerationMismatch
	}
	if !desktopConfigRuntimeMatches(executor, binding, input.TargetDeviceID) {
		return ErrExecutorFenced
	}
	if err := deviceauth.ValidateTimestamp(input.Proof.TimestampMilli, now); err != nil {
		return err
	}
	if input.CheckedAt.Before(now.Add(-deviceauth.ClockWindow)) || input.CheckedAt.After(now.Add(deviceauth.ClockWindow)) {
		return deviceauth.ErrTimestampOutsideWindow
	}
	if err := validateLedgerExpiry(input.LedgerExpiresAt, now); err != nil {
		return err
	}
	if input.Result != "succeeded" {
		return nil
	}
	sourceRevision := int64(0)
	if executor.CurrentCredentialRevision.Valid {
		sourceRevision = executor.CurrentCredentialRevision.Int64
	}
	switch session.Intent {
	case "authorize":
		if sourceRevision != 0 {
			return ErrDesktopAccountIntentConflict
		}
	case "change_account":
		if sourceRevision == 0 {
			return ErrDesktopAccountIntentConflict
		}
	default:
		return ErrDesktopAccountIntentConflict
	}
	return nil
}

func validateDesktopAccountIntent(
	ctx context.Context,
	tx *sql.Tx,
	executorID string,
	intent string,
	executor storedDesktopActivationExecutor,
	candidateFingerprint string,
) error {
	sourceRevision := coalesceRevision(executor.CurrentCredentialRevision)
	if intent == "authorize" {
		if sourceRevision != 0 || executor.CredentialStatus == "authorized" {
			return ErrDesktopAccountIntentConflict
		}
		return nil
	}
	if intent != "change_account" || sourceRevision <= 0 || executor.CredentialStatus != "authorized" {
		return ErrDesktopAccountIntentConflict
	}
	var status, currentFingerprint string
	if err := tx.QueryRowContext(ctx, `
		SELECT status,account_fingerprint
		FROM ky_ai_executor_credential_binding
		WHERE executor_id=$1 AND revision=$2 FOR UPDATE
	`, executorID, sourceRevision).Scan(&status, &currentFingerprint); err != nil {
		return ErrExecutorFenced
	}
	if status != "active" || currentFingerprint == candidateFingerprint {
		return ErrDesktopAccountIntentConflict
	}
	return nil
}

func validateNewDesktopActivationACK(
	ctx context.Context,
	tx *sql.Tx,
	input AcknowledgeDesktopCredentialActivationInput,
	request deviceauth.LedgerRequest,
	token VerifiedDesktopActivationToken,
	executor storedDesktopActivationExecutor,
	session storedDesktopActivationSession,
	activation DesktopCredentialActivationProjection,
	binding storedDeviceBinding,
	bindingFound bool,
	device storedDevice,
	deviceFound bool,
	now time.Time,
) error {
	if activation.Status != "pending" || activation.ID != input.ActivationID ||
		activation.SessionID != input.SessionID || activation.DeviceID != input.TargetDeviceID ||
		activation.OperationID != input.OperationID || activation.CredentialRevision != input.CredentialRevision ||
		activation.LeaseEpoch != input.LeaseEpoch || activation.SourceCredentialRevision != input.SourceCredentialRevision ||
		activation.RevocationEpoch != input.RevocationEpoch || activation.BindingDigest != input.BindingDigest ||
		activation.ActivationTokenHash != request.AuthorizationTokenHash {
		return ErrDesktopActivationConflict
	}
	if token.TokenID != activation.ID || token.ActivationID != activation.ID ||
		token.SessionID != activation.SessionID || token.ExecutorID != activation.ExecutorID ||
		token.DeviceID != activation.DeviceID || token.OperationID != activation.OperationID ||
		token.CredentialRevision != activation.CredentialRevision || token.LeaseEpoch != activation.LeaseEpoch ||
		token.SourceCredentialRevision != activation.SourceCredentialRevision ||
		token.RevocationEpoch != activation.RevocationEpoch || token.BindingDigest != activation.BindingDigest ||
		token.TokenHash != request.AuthorizationTokenHash {
		return ErrDesktopActivationTokenMismatch
	}
	if executor.RuntimeType != "desktop" || executor.Status != "enabled" ||
		executor.RevocationEpoch != activation.RevocationEpoch ||
		executor.CredentialRevisionCounter != activation.CredentialRevision ||
		coalesceRevision(executor.CurrentCredentialRevision) != activation.SourceCredentialRevision {
		return ErrExecutorFenced
	}
	if !desktopConfigRuntimeMatches(executor, binding, activation.DeviceID) {
		return ErrExecutorFenced
	}
	if session.Status != "verifying" || session.ExecutorID != activation.ExecutorID ||
		session.BoundDeviceID != activation.DeviceID || session.OperationID != activation.OperationID ||
		!session.PreparedCredentialRevision.Valid ||
		session.PreparedCredentialRevision.Int64 != activation.CredentialRevision {
		return ErrRevisionConflict
	}
	if !bindingFound || binding.Status != "active" || binding.ExecutorID != activation.ExecutorID ||
		binding.DeviceID != activation.DeviceID || binding.Revision != activation.DeviceBindingRevision {
		return ErrDesktopHandoffTargetMismatch
	}
	if !deviceFound || device.Projection.Status != "active" || device.Projection.ID != activation.DeviceID ||
		device.Projection.WorkspaceType != "platform" || device.Projection.WorkspaceID != "platform_root" {
		return ErrDesktopHandoffTargetMismatch
	}
	if device.Projection.KeyGeneration != input.KeyGeneration {
		return ErrDeviceKeyGenerationMismatch
	}
	if err := deviceauth.ValidateTimestamp(input.Proof.TimestampMilli, now); err != nil {
		return err
	}
	if input.DurableBarrierCompletedAt.Before(now.Add(-deviceauth.ClockWindow)) ||
		input.DurableBarrierCompletedAt.After(now) {
		return deviceauth.ErrTimestampOutsideWindow
	}
	if err := validateLedgerExpiry(input.LedgerExpiresAt, now); err != nil {
		return err
	}
	var leaseOperation, leaseOwner, leaseStatus string
	var leaseEpoch, sourceRevision, revocationEpoch int64
	var leaseExpiresAt time.Time
	if err := tx.QueryRowContext(ctx, `
		SELECT operation_id,owner_instance_id,lease_epoch,lease_expires_at,
		       source_credential_revision,revocation_epoch,status
		FROM ky_ai_executor_operation_lease WHERE executor_id=$1 FOR UPDATE
	`, activation.ExecutorID).Scan(&leaseOperation, &leaseOwner, &leaseEpoch, &leaseExpiresAt,
		&sourceRevision, &revocationEpoch, &leaseStatus); err != nil {
		return ErrExecutorFenced
	}
	if leaseOperation != activation.OperationID || leaseOwner != desktopLeaseOwner(activation.DeviceID) ||
		leaseEpoch != activation.LeaseEpoch || sourceRevision != activation.SourceCredentialRevision ||
		revocationEpoch != activation.RevocationEpoch || leaseStatus != "active" || !leaseExpiresAt.After(now) {
		return ErrExecutorFenced
	}
	var candidateStatus, candidateDigest, candidateDevice, runtimeBindingID string
	var candidateLease, candidateSource, candidateRevocation, runtimeBindingRevision int64
	if err := tx.QueryRowContext(ctx, `
		SELECT status,binding_digest,device_id,runtime_binding_id,runtime_binding_revision,
		       lease_epoch,source_credential_revision,revocation_epoch
		FROM ky_ai_executor_credential_binding
		WHERE executor_id=$1 AND revision=$2 FOR UPDATE
	`, activation.ExecutorID, activation.CredentialRevision).Scan(&candidateStatus,
		&candidateDigest, &candidateDevice, &runtimeBindingID, &runtimeBindingRevision,
		&candidateLease, &candidateSource, &candidateRevocation); err != nil {
		return ErrExecutorFenced
	}
	if candidateStatus != "prepared" || candidateDigest != activation.BindingDigest ||
		candidateDevice != activation.DeviceID || runtimeBindingID != activation.DeviceID ||
		runtimeBindingRevision != activation.DeviceBindingRevision || candidateLease != activation.LeaseEpoch ||
		candidateSource != activation.SourceCredentialRevision || candidateRevocation != activation.RevocationEpoch {
		return ErrExecutorFenced
	}
	return nil
}

func validateDesktopAuthorizationProofInput(input SubmitDesktopAuthorizationProofInput) (deviceauth.LedgerRequest, error) {
	if !validOpaqueValue(input.ProofID) || !validOpaqueValue(input.SessionID) || !validOpaqueValue(input.HandoffID) ||
		deviceauth.ValidateDeviceID(input.TargetDeviceID) != nil || input.KeyGeneration == 0 ||
		input.KeyGeneration > math.MaxInt64 || input.SessionRevision <= 0 || input.SessionRevision >= math.MaxInt64 ||
		validateStoreDigest(input.LoginIDHash, false) != nil || input.CheckedAt.IsZero() ||
		input.Proof.DeviceID != input.TargetDeviceID || input.Proof.Sequence == 0 || input.Proof.Sequence > math.MaxInt64 ||
		input.Proof.TimestampMilli <= 0 || validateStoreDigest(input.Proof.BodySHA256, false) != nil ||
		validateStoreDigest(input.Proof.AuthorizationTokenHash, false) != nil {
		return deviceauth.LedgerRequest{}, ErrDesktopProofInputInvalid
	}
	if input.Result != "succeeded" && input.Result != "failed" && input.Result != "cancelled" {
		return deviceauth.LedgerRequest{}, ErrDesktopProofInputInvalid
	}
	if input.Result == "succeeded" {
		if !validOpaqueValue(input.OperationID) || !validOpaqueValue(input.ActivationID) ||
			validateStoreDigest(input.AccountFingerprint, false) != nil ||
			validateStoreDigest(input.CandidateBindingDigest, false) != nil {
			return deviceauth.LedgerRequest{}, ErrDesktopProofInputInvalid
		}
	} else if input.OperationID != "" || input.ActivationID != "" ||
		input.AccountFingerprint != "" || input.CandidateBindingDigest != "" {
		return deviceauth.LedgerRequest{}, ErrDesktopProofInputInvalid
	}
	method, err := deviceauth.CanonicalMethod(input.Proof.CanonicalMethod)
	if err != nil || method != "POST" {
		return deviceauth.LedgerRequest{}, ErrDesktopProofInputInvalid
	}
	path, err := deviceauth.CanonicalPath(input.Proof.CanonicalPath)
	if err != nil || path != desktopProofPath(input.SessionID) {
		return deviceauth.LedgerRequest{}, ErrDesktopHandoffTargetMismatch
	}
	return ledgerRequestFromProof(input.Proof, input.KeyGeneration)
}

func validateDesktopActivationACKInput(input AcknowledgeDesktopCredentialActivationInput) (deviceauth.LedgerRequest, error) {
	if !validOpaqueValue(input.SessionID) || !validOpaqueValue(input.ActivationID) ||
		!validOpaqueValue(input.OperationID) || deviceauth.ValidateDeviceID(input.TargetDeviceID) != nil ||
		input.KeyGeneration == 0 || input.KeyGeneration > math.MaxInt64 || input.CredentialRevision <= 0 ||
		input.LeaseEpoch <= 0 || input.SourceCredentialRevision < 0 || input.RevocationEpoch < 0 ||
		input.DurableBarrierCompletedAt.IsZero() || validateStoreDigest(input.BindingDigest, false) != nil ||
		input.Proof.DeviceID != input.TargetDeviceID || input.Proof.Sequence == 0 ||
		input.Proof.Sequence > math.MaxInt64 || input.Proof.TimestampMilli <= 0 ||
		validateStoreDigest(input.Proof.BodySHA256, false) != nil ||
		validateStoreDigest(input.Proof.AuthorizationTokenHash, false) != nil {
		return deviceauth.LedgerRequest{}, ErrDesktopActivationInputInvalid
	}
	method, err := deviceauth.CanonicalMethod(input.Proof.CanonicalMethod)
	if err != nil || method != "POST" {
		return deviceauth.LedgerRequest{}, ErrDesktopActivationInputInvalid
	}
	path, err := deviceauth.CanonicalPath(input.Proof.CanonicalPath)
	if err != nil || path != desktopActivationACKPath(input.SessionID, input.ActivationID) {
		return deviceauth.LedgerRequest{}, ErrDesktopHandoffTargetMismatch
	}
	return ledgerRequestFromProof(input.Proof, input.KeyGeneration)
}

func replayDesktopAuthorizationProof(
	ctx context.Context,
	tx *sql.Tx,
	input SubmitDesktopAuthorizationProofInput,
	request deviceauth.LedgerRequest,
	issuer DesktopActivationTokenIssuer,
) (SubmitDesktopAuthorizationProofResult, bool, error) {
	existing, err := loadExactDeviceLedger(ctx, tx, request)
	if err != nil || existing == nil {
		return SubmitDesktopAuthorizationProofResult{}, false, err
	}
	decision, err := decideExactDeviceLedger(request, existing)
	if err != nil {
		return SubmitDesktopAuthorizationProofResult{}, true, err
	}
	if decision.Action != deviceauth.LedgerReturnRecorded ||
		decision.ResponseReference != desktopProofResponseReference(input.HandoffID) {
		return SubmitDesktopAuthorizationProofResult{}, true, ErrDeviceProofReplayed
	}
	proof, found, err := loadDesktopProofByHandoff(ctx, tx, input.HandoffID)
	if err != nil {
		return SubmitDesktopAuthorizationProofResult{}, true, err
	}
	if !found || proof.SessionID != input.SessionID || proof.DeviceID != input.TargetDeviceID ||
		proof.SessionRevision != input.SessionRevision || proof.LoginIDHash != input.LoginIDHash ||
		proof.Result != input.Result || proof.AccountFingerprint != input.AccountFingerprint ||
		proof.CandidateBindingDigest != input.CandidateBindingDigest ||
		proof.ResponseReference != decision.ResponseReference ||
		proof.ClaimTokenHash != request.AuthorizationTokenHash ||
		proof.DeviceKeyGeneration != int64(input.KeyGeneration) ||
		proof.DeviceSequence != int64(request.Sequence) || !proof.CheckedAt.Equal(input.CheckedAt) {
		return SubmitDesktopAuthorizationProofResult{}, true, deviceauth.ErrInvalidLedgerState
	}
	result := SubmitDesktopAuthorizationProofResult{
		Proof: proof, SessionRevision: proof.ResponseSessionRevision, Replayed: true,
	}
	if proof.Result != "succeeded" {
		return result, true, nil
	}
	activation, found, err := loadDesktopActivationByProof(ctx, tx, proof.ID)
	if err != nil {
		return SubmitDesktopAuthorizationProofResult{}, true, err
	}
	if !found || activation.ActivationTokenKeyID == "" || activation.ActivationTokenNonceHash == "" {
		return SubmitDesktopAuthorizationProofResult{}, true, deviceauth.ErrInvalidLedgerState
	}
	issued, err := issuer(activation, activation.IssuedAt)
	if err != nil {
		return SubmitDesktopAuthorizationProofResult{}, true, err
	}
	if !matchesPersistedDesktopToken(issued, activation.ActivationTokenHash,
		activation.ActivationTokenKeyID, activation.ActivationTokenNonceHash,
		activation.ExpiresAt, activation.IssuedAt, DesktopActivationLifetime) {
		return SubmitDesktopAuthorizationProofResult{}, true, ErrDesktopActivationTokenReconstruction
	}
	result.Activation = &activation
	result.ActivationToken = issued.Token
	return result, true, nil
}

func replayDesktopActivationACK(
	ctx context.Context,
	tx *sql.Tx,
	input AcknowledgeDesktopCredentialActivationInput,
	request deviceauth.LedgerRequest,
) (AcknowledgeDesktopCredentialActivationResult, bool, error) {
	existing, err := loadExactDeviceLedger(ctx, tx, request)
	if err != nil || existing == nil {
		return AcknowledgeDesktopCredentialActivationResult{}, false, err
	}
	decision, err := decideExactDeviceLedger(request, existing)
	if err != nil {
		return AcknowledgeDesktopCredentialActivationResult{}, true, err
	}
	if decision.Action != deviceauth.LedgerReturnRecorded ||
		decision.ResponseReference != desktopActivationResponseReference(input.ActivationID) {
		return AcknowledgeDesktopCredentialActivationResult{}, true, ErrDeviceProofReplayed
	}
	activation, found, err := loadDesktopActivationByID(ctx, tx, input.ActivationID, false)
	if err != nil {
		return AcknowledgeDesktopCredentialActivationResult{}, true, err
	}
	if !found || activation.Status != "active" || activation.SessionID != input.SessionID ||
		activation.DeviceID != input.TargetDeviceID || activation.OperationID != input.OperationID ||
		activation.CredentialRevision != input.CredentialRevision || activation.LeaseEpoch != input.LeaseEpoch ||
		activation.SourceCredentialRevision != input.SourceCredentialRevision ||
		activation.RevocationEpoch != input.RevocationEpoch || activation.BindingDigest != input.BindingDigest ||
		activation.AckRequestHash != request.RequestHash ||
		activation.AckDeviceKeyGeneration != int64(input.KeyGeneration) ||
		activation.AckDeviceSequence != int64(request.Sequence) ||
		!activation.DurableBarrierAt.Valid ||
		!activation.DurableBarrierAt.Time.Equal(input.DurableBarrierCompletedAt) {
		return AcknowledgeDesktopCredentialActivationResult{}, true, deviceauth.ErrInvalidLedgerState
	}
	session, found, err := loadDesktopActivationSession(ctx, tx, activation.SessionID, false)
	if err != nil {
		return AcknowledgeDesktopCredentialActivationResult{}, true, err
	}
	if !found || session.Status != "succeeded" {
		return AcknowledgeDesktopCredentialActivationResult{}, true, deviceauth.ErrInvalidLedgerState
	}
	return AcknowledgeDesktopCredentialActivationResult{
		ActivationID: activation.ID, ExecutorID: activation.ExecutorID,
		CredentialRevision: activation.CredentialRevision,
		SessionRevision:    session.Revision, Replayed: true,
	}, true, nil
}

func consumeDesktopClaim(ctx context.Context, tx *sql.Tx, handoff DesktopHandoffProjection, tokenHash string, now time.Time) error {
	updated, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_desktop_handoff
		SET status='proof_submitted',claim_consumed_at=$2
		WHERE id=$1 AND status='claimed' AND claim_consumed_at IS NULL
		  AND claim_token_hash=$3
	`, handoff.ID, now, tokenHash)
	if err != nil {
		return err
	}
	if affected, _ := updated.RowsAffected(); affected != 1 {
		return ErrDesktopProofConflict
	}
	return nil
}

func insertDesktopAuthorizationProof(ctx context.Context, tx *sql.Tx, proof DesktopAuthorizationProofProjection) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_desktop_authorization_proof (
		 id,session_id,handoff_id,executor_id,device_id,session_revision,
		 login_id_hash,result,account_fingerprint,candidate_binding_digest,
		 request_hash,checked_at,created_at,claim_token_hash,device_key_generation,
		 device_sequence,response_reference,response_session_revision
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
	`, proof.ID, proof.SessionID, proof.HandoffID, proof.ExecutorID, proof.DeviceID,
		proof.SessionRevision, proof.LoginIDHash, proof.Result, proof.AccountFingerprint,
		proof.CandidateBindingDigest, proof.RequestHash, proof.CheckedAt, proof.CreatedAt,
		proof.ClaimTokenHash, proof.DeviceKeyGeneration, proof.DeviceSequence,
		proof.ResponseReference, proof.ResponseSessionRevision)
	return classifyControlWrite(err)
}

func loadDesktopActivationExecutor(ctx context.Context, tx *sql.Tx, executorID string) (storedDesktopActivationExecutor, error) {
	var item storedDesktopActivationExecutor
	err := tx.QueryRowContext(ctx, `
		SELECT runtime_type,status,credential_status,current_credential_revision,
		       credential_revision_counter,revocation_epoch,
		       runtime_binding_id,runtime_binding_revision
		FROM ky_ai_executor_config WHERE id=$1
	`, executorID).Scan(&item.RuntimeType, &item.Status, &item.CredentialStatus,
		&item.CurrentCredentialRevision, &item.CredentialRevisionCounter, &item.RevocationEpoch,
		&item.RuntimeBindingID, &item.RuntimeBindingRevision)
	return item, err
}

func loadDesktopActivationSessionForUpdate(ctx context.Context, tx *sql.Tx, sessionID string) (storedDesktopActivationSession, bool, error) {
	return loadDesktopActivationSession(ctx, tx, sessionID, true)
}

func loadDesktopActivationSession(ctx context.Context, tx *sql.Tx, sessionID string, forUpdate bool) (storedDesktopActivationSession, bool, error) {
	query := `
		SELECT id,executor_id,runtime_type,flow_type,intent,status,requested_by,bound_device_id,
		       login_id_hash,operation_id,prepared_credential_revision,revision,current_sequence,
		       session_deadline_at
		FROM ky_ai_executor_authorization_session WHERE id=$1`
	if forUpdate {
		query += ` FOR UPDATE`
	}
	var item storedDesktopActivationSession
	err := tx.QueryRowContext(ctx, query, sessionID).Scan(&item.ID, &item.ExecutorID,
		&item.RuntimeType, &item.FlowType, &item.Intent, &item.Status, &item.RequestedBy,
		&item.BoundDeviceID, &item.LoginIDHash, &item.OperationID,
		&item.PreparedCredentialRevision, &item.Revision, &item.CurrentSequence,
		&item.SessionDeadlineAt)
	if errors.Is(err, sql.ErrNoRows) {
		return storedDesktopActivationSession{}, false, nil
	}
	return item, err == nil, err
}

func loadDesktopProofByHandoff(ctx context.Context, tx *sql.Tx, handoffID string) (DesktopAuthorizationProofProjection, bool, error) {
	return scanDesktopProof(tx.QueryRowContext(ctx, desktopProofSelect+` WHERE handoff_id=$1`, handoffID))
}

const desktopProofSelect = `
	SELECT id,session_id,handoff_id,executor_id,device_id,session_revision,
	       login_id_hash,result,account_fingerprint,candidate_binding_digest,
	       request_hash,claim_token_hash,device_key_generation,device_sequence,
	       response_reference,response_session_revision,checked_at,created_at
	FROM ky_ai_executor_desktop_authorization_proof
`

func scanDesktopProof(row rowScanner) (DesktopAuthorizationProofProjection, bool, error) {
	var item DesktopAuthorizationProofProjection
	err := row.Scan(&item.ID, &item.SessionID, &item.HandoffID, &item.ExecutorID,
		&item.DeviceID, &item.SessionRevision, &item.LoginIDHash, &item.Result,
		&item.AccountFingerprint, &item.CandidateBindingDigest, &item.RequestHash,
		&item.ClaimTokenHash, &item.DeviceKeyGeneration, &item.DeviceSequence,
		&item.ResponseReference, &item.ResponseSessionRevision, &item.CheckedAt, &item.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return DesktopAuthorizationProofProjection{}, false, nil
	}
	return item, err == nil, err
}

func loadDesktopActivationByProof(ctx context.Context, tx *sql.Tx, proofID string) (DesktopCredentialActivationProjection, bool, error) {
	return scanDesktopActivation(tx.QueryRowContext(ctx, desktopActivationSelect+` WHERE proof_id=$1`, proofID))
}

func loadDesktopActivationByID(ctx context.Context, tx *sql.Tx, activationID string, forUpdate bool) (DesktopCredentialActivationProjection, bool, error) {
	query := desktopActivationSelect + ` WHERE id=$1`
	if forUpdate {
		query += ` FOR UPDATE`
	}
	return scanDesktopActivation(tx.QueryRowContext(ctx, query, activationID))
}

const desktopActivationSelect = `
	SELECT id,session_id,proof_id,executor_id,device_id,operation_id,
	       credential_revision,lease_epoch,source_credential_revision,revocation_epoch,
	       device_binding_revision,binding_digest,activation_token_hash,
	       activation_token_key_id,activation_token_nonce_hash,request_hash,ack_request_hash,
	       ack_device_key_generation,ack_device_sequence,status,issued_at,expires_at,
	       durable_barrier_completed_at,acknowledged_at,activated_at
	FROM ky_ai_executor_credential_activation
`

func scanDesktopActivation(row rowScanner) (DesktopCredentialActivationProjection, bool, error) {
	var item DesktopCredentialActivationProjection
	err := row.Scan(&item.ID, &item.SessionID, &item.ProofID, &item.ExecutorID,
		&item.DeviceID, &item.OperationID, &item.CredentialRevision, &item.LeaseEpoch,
		&item.SourceCredentialRevision, &item.RevocationEpoch, &item.DeviceBindingRevision,
		&item.BindingDigest, &item.ActivationTokenHash, &item.ActivationTokenKeyID,
		&item.ActivationTokenNonceHash, &item.RequestHash, &item.AckRequestHash,
		&item.AckDeviceKeyGeneration, &item.AckDeviceSequence, &item.Status,
		&item.IssuedAt, &item.ExpiresAt, &item.DurableBarrierAt,
		&item.AcknowledgedAt, &item.ActivatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return DesktopCredentialActivationProjection{}, false, nil
	}
	return item, err == nil, err
}

func insertDesktopActivationAudit(
	ctx context.Context,
	tx *sql.Tx,
	activation DesktopCredentialActivationProjection,
	sequence int64,
	eventType string,
	requestHash string,
	now time.Time,
) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_credential_activation_audit (
		 activation_id,sequence,event_type,session_id,proof_id,executor_id,device_id,
		 operation_id,credential_revision,lease_epoch,source_credential_revision,
		 revocation_epoch,binding_digest,request_hash,occurred_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
	`, activation.ID, sequence, eventType, activation.SessionID, activation.ProofID,
		activation.ExecutorID, activation.DeviceID, activation.OperationID,
		activation.CredentialRevision, activation.LeaseEpoch,
		activation.SourceCredentialRevision, activation.RevocationEpoch,
		activation.BindingDigest, requestHash, now)
	return classifyControlWrite(err)
}

func commitDesktopAuthorizationProofReplay(
	tx *sql.Tx,
	result SubmitDesktopAuthorizationProofResult,
	replayErr error,
) (SubmitDesktopAuthorizationProofResult, error) {
	if replayErr != nil {
		return SubmitDesktopAuthorizationProofResult{}, replayErr
	}
	if err := tx.Commit(); err != nil {
		return SubmitDesktopAuthorizationProofResult{}, classifyControlWrite(err)
	}
	return result, nil
}

func commitDesktopActivationACKReplay(
	tx *sql.Tx,
	result AcknowledgeDesktopCredentialActivationResult,
	replayErr error,
) (AcknowledgeDesktopCredentialActivationResult, error) {
	if replayErr != nil {
		return AcknowledgeDesktopCredentialActivationResult{}, replayErr
	}
	if err := tx.Commit(); err != nil {
		return AcknowledgeDesktopCredentialActivationResult{}, classifyControlWrite(err)
	}
	return result, nil
}

func desktopProofPath(sessionID string) string {
	return "/api/v1/ai-executor-authorization-sessions/" + sessionID + "/desktop-proofs"
}

func desktopActivationACKPath(sessionID, activationID string) string {
	return "/api/v1/ai-executor-authorization-sessions/" + sessionID + "/desktop-activations/" + activationID + "/ack"
}

func desktopProofResponseReference(handoffID string) string {
	return "desktop_proof_" + handoffID
}

func desktopActivationResponseReference(activationID string) string {
	return "desktop_activation_" + activationID
}

func desktopLeaseOwner(deviceID string) string {
	return "desktop_" + deviceID
}

func coalesceRevision(value sql.NullInt64) int64 {
	if value.Valid {
		return value.Int64
	}
	return 0
}

func desktopConfigRuntimeMatches(
	executor storedDesktopActivationExecutor,
	binding storedDeviceBinding,
	deviceID string,
) bool {
	if coalesceRevision(executor.CurrentCredentialRevision) == 0 {
		return executor.RuntimeBindingID == "" && executor.RuntimeBindingRevision == 0
	}
	return executor.RuntimeBindingID == deviceID &&
		executor.RuntimeBindingRevision == binding.Revision
}

func errOrDesktopProofInputInvalid(err error) error {
	if err != nil {
		return err
	}
	return ErrDesktopProofInputInvalid
}

func errOrDesktopActivationInputInvalid(err error) error {
	if err != nil {
		return err
	}
	return ErrDesktopActivationInputInvalid
}
