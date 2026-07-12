package store

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/deviceauth"
)

const (
	deviceBindingEventBound       = "bound"
	deviceBindingEventRebound     = "rebound"
	deviceBindingEventUnbound     = "unbound"
	deviceBindingEventForceUnbind = "force_unbound"
)

var (
	ErrDeviceBindingInputInvalid         = errors.New("device binding input invalid")
	ErrDeviceBindingAlreadyActive        = errors.New("device binding is already active")
	ErrDeviceBindingNotActive            = errors.New("device binding is not active")
	ErrDeviceBindingTargetMismatch       = errors.New("device binding target mismatch")
	ErrDeviceBindingConfirmationMismatch = errors.New("device binding confirmation mismatch")
	ErrDeviceBindingReplayMismatch       = errors.New("device binding replay mismatch")
)

type DeviceBindingProjection struct {
	ExecutorID string `json:"executorId"`
	DeviceID   string `json:"deviceId"`
	Status     string `json:"status"`
	Revision   int64  `json:"revision"`
	Force      bool   `json:"force"`
	UpdatedAt  string `json:"updatedAt"`
}

type DeviceBindingResult struct {
	Binding           DeviceBindingProjection `json:"binding"`
	ResponseReference string                  `json:"responseReference"`
	Replayed          bool                    `json:"replayed"`
}

type BindDeviceInput struct {
	ExecutorID         string
	ActorID            string
	ActorSessionID     string
	WorkspaceType      string
	WorkspaceID        string
	TargetDeviceID     string
	ExpectedRevision   int64
	OperationReference string
	KeyGeneration      uint64
	Proof              deviceauth.VerifiedRequest
	LedgerExpiresAt    time.Time
}

type RebindDeviceInput struct {
	ExecutorID         string
	ActorID            string
	ActorSessionID     string
	WorkspaceType      string
	WorkspaceID        string
	FromDeviceID       string
	TargetDeviceID     string
	ExpectedRevision   int64
	OperationReference string
	KeyGeneration      uint64
	Proof              deviceauth.VerifiedRequest
	LedgerExpiresAt    time.Time
}

type UnbindDeviceInput struct {
	ExecutorID         string
	ActorID            string
	ActorSessionID     string
	WorkspaceType      string
	WorkspaceID        string
	DeviceID           string
	ExpectedRevision   int64
	OperationReference string
	Force              bool
	RequestHash        string
	KeyGeneration      uint64
	Proof              deviceauth.VerifiedRequest
	LedgerExpiresAt    time.Time
}

type storedDeviceBinding struct {
	ExecutorID string
	DeviceID   string
	Status     string
	Revision   int64
}

type storedDeviceBindingAudit struct {
	OperationReference string
	ExecutorID         string
	BindingRevision    int64
	EventType          string
	ActorID            string
	ActorSessionID     string
	WorkspaceType      string
	WorkspaceID        string
	ExpectedRevision   int64
	FromDeviceID       string
	TargetDeviceID     string
	ProofDeviceID      string
	ProofKeyGeneration uint64
	ProofSequence      uint64
	RequestHash        string
	ConfirmationID     sql.NullString
	Force              bool
	OccurredAt         time.Time
}

type deviceBindingMutationFacts struct {
	EventType          string
	ExecutorID         string
	ActorID            string
	ActorSessionID     string
	WorkspaceType      string
	WorkspaceID        string
	ExpectedRevision   int64
	FromDeviceID       string
	TargetDeviceID     string
	OperationReference string
	Force              bool
	RequestHash        string
	KeyGeneration      uint64
	Proof              *deviceauth.VerifiedRequest
	LedgerExpiresAt    time.Time
}

// BindDevice performs an initial bind, or reactivates a previously revoked
// binding, using the target device's persistent proof ledger as the idempotency
// source of truth. A never-bound executor requires expectedRevision=0; a
// revoked binding requires its current revision and advances it by one.
func (s *ControlStore) BindDevice(ctx context.Context, input BindDeviceInput) (DeviceBindingResult, error) {
	facts, err := bindDeviceFacts(input)
	if err != nil {
		return DeviceBindingResult{}, err
	}
	request, err := bindingLedgerRequest(facts)
	if err != nil {
		return DeviceBindingResult{}, err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return DeviceBindingResult{}, err
	}
	defer tx.Rollback()
	if result, handled, err := replayDeviceBindingProofInTx(ctx, tx, facts, request); handled || err != nil {
		return commitDeviceBindingReplay(tx, result, err)
	}
	if err := lockBindableExecutor(ctx, tx, facts.ExecutorID); err != nil {
		return DeviceBindingResult{}, err
	}
	binding, bindingExists, err := loadDeviceBindingForUpdate(ctx, tx, facts.ExecutorID)
	if err != nil {
		return DeviceBindingResult{}, err
	}
	device, deviceExists, err := loadDeviceForUpdate(ctx, tx, facts.TargetDeviceID)
	if err != nil {
		return DeviceBindingResult{}, err
	}
	if result, handled, err := replayDeviceBindingProofInTx(ctx, tx, facts, request); handled || err != nil {
		return commitDeviceBindingReplay(tx, result, err)
	}
	now, err := transactionNow(ctx, tx)
	if err != nil {
		return DeviceBindingResult{}, err
	}
	if err := validateNewBindingProof(facts, device, deviceExists, now); err != nil {
		return DeviceBindingResult{}, err
	}
	newRevision := int64(1)
	if bindingExists {
		if binding.Status == "active" {
			return DeviceBindingResult{}, ErrDeviceBindingAlreadyActive
		}
		if binding.Status != "revoked" {
			return DeviceBindingResult{}, ErrDeviceBindingNotActive
		}
		if binding.Revision != facts.ExpectedRevision {
			return DeviceBindingResult{}, ErrRevisionConflict
		}
		newRevision = binding.Revision + 1
	} else if facts.ExpectedRevision != 0 {
		return DeviceBindingResult{}, ErrRevisionConflict
	}
	if err := acceptNewDeviceProof(ctx, tx, facts, request, device, now); err != nil {
		return DeviceBindingResult{}, err
	}
	if bindingExists {
		result, err := tx.ExecContext(ctx, `
			UPDATE ky_ai_executor_device_binding
			SET device_id=$2,revision=$3,status='active',bound_by=$4,bound_at=$5,
			    revoked_at=NULL,updated_at=$5
			WHERE executor_id=$1 AND revision=$6 AND status='revoked'
		`, facts.ExecutorID, facts.TargetDeviceID, newRevision, facts.ActorID, now, facts.ExpectedRevision)
		if err != nil {
			return DeviceBindingResult{}, classifyControlWrite(err)
		}
		if affected, _ := result.RowsAffected(); affected != 1 {
			return DeviceBindingResult{}, ErrRevisionConflict
		}
	} else {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO ky_ai_executor_device_binding (
			 executor_id,device_id,revision,status,bound_by,bound_at,updated_at
			) VALUES ($1,$2,$3,'active',$4,$5,$5)
		`, facts.ExecutorID, facts.TargetDeviceID, newRevision, facts.ActorID, now); err != nil {
			if errors.Is(classifyControlWrite(err), ErrConflict) {
				return DeviceBindingResult{}, ErrRevisionConflict
			}
			return DeviceBindingResult{}, err
		}
	}
	result := resultFromBindingFacts(facts, newRevision, now, false)
	if err := persistDeviceBindingMutation(ctx, tx, facts, nil, result, now); err != nil {
		return DeviceBindingResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return DeviceBindingResult{}, classifyControlWrite(err)
	}
	return result, nil
}

// ReplayRebindDevice checks only the immutable device ledger and safe binding
// audit. It performs no clock, device-state, confirmation, or business write.
// HTTP orchestration calls this before Consume and again after a concurrent
// Consume reports an already-consumed token.
func (s *ControlStore) ReplayRebindDevice(ctx context.Context, input RebindDeviceInput) (DeviceBindingResult, bool, error) {
	facts, err := rebindDeviceFacts(input)
	if err != nil {
		return DeviceBindingResult{}, false, err
	}
	return s.replayDeviceBindingProof(ctx, facts)
}

func (s *ControlStore) ReplayUnbindDevice(ctx context.Context, input UnbindDeviceInput) (DeviceBindingResult, bool, error) {
	facts, err := unbindDeviceFacts(input)
	if err != nil || facts.Force {
		if err == nil {
			err = ErrDeviceBindingInputInvalid
		}
		return DeviceBindingResult{}, false, err
	}
	return s.replayDeviceBindingProof(ctx, facts)
}

// ReplayForceUnbindDevice is used only after operationconfirmation.Manager has
// cryptographically verified the token and returned token-consumed. The
// operation reference must be deterministic for that token, and the persisted
// confirmation consumption is rechecked before returning the prior result.
func (s *ControlStore) ReplayForceUnbindDevice(ctx context.Context, input UnbindDeviceInput) (DeviceBindingResult, bool, error) {
	facts, err := unbindDeviceFacts(input)
	if err != nil || !facts.Force {
		if err == nil {
			err = ErrDeviceBindingInputInvalid
		}
		return DeviceBindingResult{}, false, err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted, ReadOnly: true})
	if err != nil {
		return DeviceBindingResult{}, false, err
	}
	defer tx.Rollback()
	audit, found, err := loadDeviceBindingAuditByOperation(ctx, tx, facts.OperationReference)
	if err != nil || !found {
		return DeviceBindingResult{}, false, err
	}
	if err := matchDeviceBindingAudit(audit, facts); err != nil {
		return DeviceBindingResult{}, true, err
	}
	if !audit.ConfirmationID.Valid {
		return DeviceBindingResult{}, true, ErrDeviceBindingReplayMismatch
	}
	var consumed bool
	if err := tx.QueryRowContext(ctx, `
		SELECT status='consumed' AND consumption_reference=$2
		FROM ky_ai_executor_operation_confirmation WHERE id=$1
	`, audit.ConfirmationID.String, facts.OperationReference).Scan(&consumed); errors.Is(err, sql.ErrNoRows) {
		return DeviceBindingResult{}, true, ErrDeviceBindingReplayMismatch
	} else if err != nil {
		return DeviceBindingResult{}, true, err
	}
	if !consumed {
		return DeviceBindingResult{}, true, ErrDeviceBindingReplayMismatch
	}
	if err := tx.Commit(); err != nil {
		return DeviceBindingResult{}, true, classifyControlWrite(err)
	}
	result := resultFromBindingAudit(audit)
	result.Replayed = true
	return result, true, nil
}

// RebindDeviceMutation returns the atomic business callback for
// operationconfirmation.Manager.Consume. The target device proof ledger,
// binding CAS, binding audit/outbox, and confirmation burn all share the
// manager-owned SQL transaction.
func (s *ControlStore) RebindDeviceMutation(input RebindDeviceInput, capture *DeviceBindingResult) OperationConfirmationMutation {
	return func(ctx context.Context, tx *sql.Tx, confirmation OperationConfirmationProjection) error {
		if capture == nil {
			return ErrDeviceBindingInputInvalid
		}
		facts, err := rebindDeviceFacts(input)
		if err != nil {
			return err
		}
		result, err := applyConfirmedDeviceBinding(ctx, tx, confirmation, facts)
		if err != nil {
			return err
		}
		*capture = result
		return nil
	}
}

func (s *ControlStore) UnbindDeviceMutation(input UnbindDeviceInput, capture *DeviceBindingResult) OperationConfirmationMutation {
	return func(ctx context.Context, tx *sql.Tx, confirmation OperationConfirmationProjection) error {
		if capture == nil {
			return ErrDeviceBindingInputInvalid
		}
		facts, err := unbindDeviceFacts(input)
		if err != nil {
			return err
		}
		result, err := applyConfirmedDeviceBinding(ctx, tx, confirmation, facts)
		if err != nil {
			return err
		}
		*capture = result
		return nil
	}
}

func (s *ControlStore) replayDeviceBindingProof(ctx context.Context, facts deviceBindingMutationFacts) (DeviceBindingResult, bool, error) {
	request, err := bindingLedgerRequest(facts)
	if err != nil {
		return DeviceBindingResult{}, false, err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted, ReadOnly: true})
	if err != nil {
		return DeviceBindingResult{}, false, err
	}
	defer tx.Rollback()
	result, handled, err := replayDeviceBindingProofInTx(ctx, tx, facts, request)
	if err != nil || !handled {
		return DeviceBindingResult{}, handled, err
	}
	if err := tx.Commit(); err != nil {
		return DeviceBindingResult{}, true, classifyControlWrite(err)
	}
	return result, true, nil
}

func applyConfirmedDeviceBinding(
	ctx context.Context,
	tx *sql.Tx,
	confirmation OperationConfirmationProjection,
	facts deviceBindingMutationFacts,
) (DeviceBindingResult, error) {
	if err := matchDeviceBindingConfirmation(confirmation, facts); err != nil {
		return DeviceBindingResult{}, err
	}
	var request deviceauth.LedgerRequest
	var err error
	if !facts.Force {
		request, err = bindingLedgerRequest(facts)
		if err != nil {
			return DeviceBindingResult{}, err
		}
		if result, handled, err := replayDeviceBindingProofInTx(ctx, tx, facts, request); handled || err != nil {
			if err != nil {
				return DeviceBindingResult{}, err
			}
			return result, nil
		}
	}
	if err := lockBindableExecutor(ctx, tx, facts.ExecutorID); err != nil {
		return DeviceBindingResult{}, err
	}
	binding, exists, err := loadDeviceBindingForUpdate(ctx, tx, facts.ExecutorID)
	if err != nil {
		return DeviceBindingResult{}, err
	}
	if !exists || binding.Status != "active" {
		return DeviceBindingResult{}, ErrDeviceBindingNotActive
	}
	if binding.Revision != facts.ExpectedRevision {
		return DeviceBindingResult{}, ErrRevisionConflict
	}
	if binding.DeviceID != facts.FromDeviceID {
		return DeviceBindingResult{}, ErrDeviceBindingTargetMismatch
	}
	var device storedDevice
	if !facts.Force {
		device, exists, err = loadDeviceForUpdate(ctx, tx, facts.Proof.DeviceID)
		if err != nil {
			return DeviceBindingResult{}, err
		}
		if result, handled, err := replayDeviceBindingProofInTx(ctx, tx, facts, request); handled || err != nil {
			if err != nil {
				return DeviceBindingResult{}, err
			}
			return result, nil
		}
	}
	now, err := transactionNow(ctx, tx)
	if err != nil {
		return DeviceBindingResult{}, err
	}
	if !facts.Force {
		if err := validateNewBindingProof(facts, device, exists, now); err != nil {
			return DeviceBindingResult{}, err
		}
		if err := acceptNewDeviceProof(ctx, tx, facts, request, device, now); err != nil {
			return DeviceBindingResult{}, err
		}
	}
	newRevision := binding.Revision + 1
	newStatus := "active"
	newDeviceID := facts.TargetDeviceID
	if facts.EventType == deviceBindingEventUnbound || facts.EventType == deviceBindingEventForceUnbind {
		newStatus = "revoked"
		newDeviceID = facts.FromDeviceID
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE ky_ai_executor_device_binding
		SET device_id=$2,revision=$3,status=$4,bound_by=$5,
		    bound_at=CASE WHEN $4='active' THEN $6 ELSE bound_at END,
		    revoked_at=CASE WHEN $4='revoked' THEN $6 ELSE NULL END,
		    updated_at=$6
		WHERE executor_id=$1 AND revision=$7 AND status='active' AND device_id=$8
	`, facts.ExecutorID, newDeviceID, newRevision, newStatus, facts.ActorID, now,
		facts.ExpectedRevision, facts.FromDeviceID)
	if err != nil {
		return DeviceBindingResult{}, classifyControlWrite(err)
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return DeviceBindingResult{}, ErrRevisionConflict
	}
	bindingResult := resultFromBindingFacts(facts, newRevision, now, false)
	if err := persistDeviceBindingMutation(ctx, tx, facts, &confirmation, bindingResult, now); err != nil {
		return DeviceBindingResult{}, err
	}
	return bindingResult, nil
}

func bindDeviceFacts(input BindDeviceInput) (deviceBindingMutationFacts, error) {
	facts := deviceBindingMutationFacts{
		EventType: deviceBindingEventBound, ExecutorID: input.ExecutorID,
		ActorID: input.ActorID, ActorSessionID: input.ActorSessionID,
		WorkspaceType: input.WorkspaceType, WorkspaceID: input.WorkspaceID,
		ExpectedRevision: input.ExpectedRevision, TargetDeviceID: input.TargetDeviceID,
		OperationReference: input.OperationReference, KeyGeneration: input.KeyGeneration,
		Proof: &input.Proof, RequestHash: input.Proof.RequestHash, LedgerExpiresAt: input.LedgerExpiresAt,
	}
	if input.ExpectedRevision < 0 || input.ExpectedRevision >= math.MaxInt64 || !validBindingBase(facts) ||
		deviceauth.ValidateDeviceID(input.TargetDeviceID) != nil ||
		validateBindingProof(input.Proof, input.TargetDeviceID, "POST", bindDevicePath(input.ExecutorID), input.KeyGeneration) != nil {
		return deviceBindingMutationFacts{}, ErrDeviceBindingInputInvalid
	}
	return facts, nil
}

func rebindDeviceFacts(input RebindDeviceInput) (deviceBindingMutationFacts, error) {
	facts := deviceBindingMutationFacts{
		EventType: deviceBindingEventRebound, ExecutorID: input.ExecutorID,
		ActorID: input.ActorID, ActorSessionID: input.ActorSessionID,
		WorkspaceType: input.WorkspaceType, WorkspaceID: input.WorkspaceID,
		ExpectedRevision: input.ExpectedRevision, FromDeviceID: input.FromDeviceID,
		TargetDeviceID: input.TargetDeviceID, OperationReference: input.OperationReference,
		KeyGeneration: input.KeyGeneration, Proof: &input.Proof,
		RequestHash: input.Proof.RequestHash, LedgerExpiresAt: input.LedgerExpiresAt,
	}
	if input.ExpectedRevision <= 0 || input.ExpectedRevision >= math.MaxInt64 || !validBindingBase(facts) || input.FromDeviceID == input.TargetDeviceID ||
		deviceauth.ValidateDeviceID(input.FromDeviceID) != nil || deviceauth.ValidateDeviceID(input.TargetDeviceID) != nil ||
		validateBindingProof(input.Proof, input.TargetDeviceID, "POST", rebindDevicePath(input.ExecutorID), input.KeyGeneration) != nil {
		return deviceBindingMutationFacts{}, ErrDeviceBindingInputInvalid
	}
	return facts, nil
}

func unbindDeviceFacts(input UnbindDeviceInput) (deviceBindingMutationFacts, error) {
	eventType := deviceBindingEventUnbound
	requestHash := input.Proof.RequestHash
	var proof *deviceauth.VerifiedRequest
	if input.Force {
		eventType = deviceBindingEventForceUnbind
		requestHash = input.RequestHash
	} else {
		proof = &input.Proof
	}
	facts := deviceBindingMutationFacts{
		EventType: eventType, ExecutorID: input.ExecutorID,
		ActorID: input.ActorID, ActorSessionID: input.ActorSessionID,
		WorkspaceType: input.WorkspaceType, WorkspaceID: input.WorkspaceID,
		ExpectedRevision: input.ExpectedRevision, FromDeviceID: input.DeviceID,
		OperationReference: input.OperationReference, Force: input.Force,
		RequestHash: requestHash, KeyGeneration: input.KeyGeneration,
		Proof: proof, LedgerExpiresAt: input.LedgerExpiresAt,
	}
	if input.ExpectedRevision <= 0 || input.ExpectedRevision >= math.MaxInt64 || !validBindingBase(facts) || deviceauth.ValidateDeviceID(input.DeviceID) != nil {
		return deviceBindingMutationFacts{}, ErrDeviceBindingInputInvalid
	}
	if input.Force {
		if input.KeyGeneration != 0 || !isZeroVerifiedRequest(input.Proof) || validateStoreDigest(input.RequestHash, false) != nil {
			return deviceBindingMutationFacts{}, ErrDeviceBindingInputInvalid
		}
		return facts, nil
	}
	if input.RequestHash != "" || validateBindingProof(input.Proof, input.DeviceID, "DELETE", unbindDevicePath(input.ExecutorID), input.KeyGeneration) != nil {
		return deviceBindingMutationFacts{}, ErrDeviceBindingInputInvalid
	}
	return facts, nil
}

func validBindingBase(facts deviceBindingMutationFacts) bool {
	return validOpaqueValue(facts.ExecutorID) && validOpaqueValue(facts.ActorID) &&
		validOpaqueValue(facts.ActorSessionID) && facts.WorkspaceType == "platform" &&
		facts.WorkspaceID == "platform_root" && validOpaqueValue(facts.OperationReference) &&
		validateStoreDigest(facts.RequestHash, false) == nil
}

func validateBindingProof(
	proof deviceauth.VerifiedRequest,
	deviceID string,
	method string,
	path string,
	keyGeneration uint64,
) error {
	if proof.DeviceID != deviceID || keyGeneration == 0 || keyGeneration > math.MaxInt64 ||
		proof.TimestampMilli <= 0 || proof.Sequence == 0 || proof.Sequence > math.MaxInt64 ||
		validateStoreDigest(proof.BodySHA256, false) != nil ||
		validateStoreDigest(proof.AuthorizationTokenHash, false) != nil {
		return ErrDeviceBindingInputInvalid
	}
	canonicalMethod, err := deviceauth.CanonicalMethod(proof.CanonicalMethod)
	if err != nil || canonicalMethod != method {
		return ErrDeviceBindingInputInvalid
	}
	canonicalPath, err := deviceauth.CanonicalPath(proof.CanonicalPath)
	if err != nil || canonicalPath != path {
		return ErrDeviceBindingTargetMismatch
	}
	_, err = ledgerRequestFromProof(proof, keyGeneration)
	return err
}

func bindingLedgerRequest(facts deviceBindingMutationFacts) (deviceauth.LedgerRequest, error) {
	if facts.Proof == nil {
		return deviceauth.LedgerRequest{}, ErrDeviceBindingInputInvalid
	}
	return ledgerRequestFromProof(*facts.Proof, facts.KeyGeneration)
}

func validateNewBindingProof(
	facts deviceBindingMutationFacts,
	device storedDevice,
	exists bool,
	now time.Time,
) error {
	if !exists {
		return ErrNotFound
	}
	if device.Projection.Status != "active" {
		return ErrDeviceInactive
	}
	if device.Projection.WorkspaceType != "platform" || device.Projection.WorkspaceID != "platform_root" {
		return ErrDeviceBindingTargetMismatch
	}
	if device.Projection.KeyGeneration != facts.KeyGeneration {
		return ErrDeviceKeyGenerationMismatch
	}
	if facts.Proof == nil || device.Projection.ID != facts.Proof.DeviceID {
		return ErrDeviceMismatch
	}
	if err := deviceauth.ValidateTimestamp(facts.Proof.TimestampMilli, now); err != nil {
		return err
	}
	return validateLedgerExpiry(facts.LedgerExpiresAt, now)
}

func acceptNewDeviceProof(
	ctx context.Context,
	tx *sql.Tx,
	facts deviceBindingMutationFacts,
	request deviceauth.LedgerRequest,
	device storedDevice,
	now time.Time,
) error {
	decision, _, err := decideStoredLedger(ctx, tx, request, device.Projection.LastAcceptedSequence)
	if err != nil {
		return err
	}
	if decision.Action == deviceauth.LedgerReturnRecorded {
		// Exact replay must have been reconstructed from the immutable binding
		// audit before any business mutation. Reaching this branch means the
		// replay state changed underneath the transaction or is incomplete; do
		// not let a recorded proof authorize a second binding mutation.
		return ErrDeviceBindingReplayMismatch
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
	return insertDeviceLedger(ctx, tx, request, facts.OperationReference, now, facts.LedgerExpiresAt)
}

func replayDeviceBindingProofInTx(
	ctx context.Context,
	tx *sql.Tx,
	facts deviceBindingMutationFacts,
	request deviceauth.LedgerRequest,
) (DeviceBindingResult, bool, error) {
	existing, err := loadExactDeviceLedger(ctx, tx, request)
	if err != nil || existing == nil {
		return DeviceBindingResult{}, false, err
	}
	decision, err := decideExactDeviceLedger(request, existing)
	if err != nil {
		return DeviceBindingResult{}, true, err
	}
	if decision.Action != deviceauth.LedgerReturnRecorded {
		return DeviceBindingResult{}, true, ErrDeviceProofReplayed
	}
	audit, found, err := loadDeviceBindingAuditByOperation(ctx, tx, decision.ResponseReference)
	if err != nil {
		return DeviceBindingResult{}, true, err
	}
	if !found {
		return DeviceBindingResult{}, true, deviceauth.ErrInvalidLedgerState
	}
	if err := matchDeviceBindingAudit(audit, facts); err != nil {
		return DeviceBindingResult{}, true, err
	}
	result := resultFromBindingAudit(audit)
	result.Replayed = true
	return result, true, nil
}

func matchDeviceBindingConfirmation(item OperationConfirmationProjection, facts deviceBindingMutationFacts) error {
	action := OperationConfirmationUnbindDevice
	if facts.EventType == deviceBindingEventRebound {
		action = OperationConfirmationRebindDevice
	}
	if !item.SecurityFactsVerified || item.Action != action || item.ExecutorID != facts.ExecutorID ||
		item.ActorID != facts.ActorID || item.ActorSessionID != facts.ActorSessionID ||
		item.ExpectedRevision != facts.ExpectedRevision || item.FromDeviceID != facts.FromDeviceID ||
		item.TargetDeviceID != facts.TargetDeviceID {
		return ErrDeviceBindingConfirmationMismatch
	}
	return nil
}

func matchDeviceBindingAudit(audit storedDeviceBindingAudit, facts deviceBindingMutationFacts) error {
	proofDeviceID := ""
	var proofSequence uint64
	if facts.Proof != nil {
		proofDeviceID = facts.Proof.DeviceID
		proofSequence = facts.Proof.Sequence
	}
	if audit.OperationReference != facts.OperationReference || audit.ExecutorID != facts.ExecutorID ||
		audit.BindingRevision != facts.ExpectedRevision+1 ||
		audit.EventType != facts.EventType || audit.ActorID != facts.ActorID ||
		audit.ActorSessionID != facts.ActorSessionID || audit.WorkspaceType != facts.WorkspaceType ||
		audit.WorkspaceID != facts.WorkspaceID || audit.ExpectedRevision != facts.ExpectedRevision ||
		audit.FromDeviceID != facts.FromDeviceID || audit.TargetDeviceID != facts.TargetDeviceID ||
		audit.ProofDeviceID != proofDeviceID || audit.ProofKeyGeneration != facts.KeyGeneration ||
		audit.ProofSequence != proofSequence || audit.RequestHash != facts.RequestHash || audit.Force != facts.Force {
		return ErrDeviceBindingReplayMismatch
	}
	return nil
}

func persistDeviceBindingMutation(
	ctx context.Context,
	tx *sql.Tx,
	facts deviceBindingMutationFacts,
	confirmation *OperationConfirmationProjection,
	result DeviceBindingResult,
	now time.Time,
) error {
	var confirmationID any
	if confirmation != nil {
		confirmationID = confirmation.ID
	}
	proofDeviceID := ""
	var proofSequence uint64
	if facts.Proof != nil {
		proofDeviceID = facts.Proof.DeviceID
		proofSequence = facts.Proof.Sequence
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO ky_ai_executor_device_binding_audit (
		 operation_reference,executor_id,binding_revision,event_type,actor_id,actor_session_id,
		 workspace_type,workspace_id,expected_revision,from_device_id,target_device_id,
		 proof_device_id,proof_key_generation,proof_sequence,request_hash,confirmation_id,force,occurred_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
	`, facts.OperationReference, facts.ExecutorID, result.Binding.Revision, facts.EventType,
		facts.ActorID, facts.ActorSessionID, facts.WorkspaceType, facts.WorkspaceID,
		facts.ExpectedRevision, facts.FromDeviceID, facts.TargetDeviceID, proofDeviceID,
		int64(facts.KeyGeneration), int64(proofSequence), facts.RequestHash, confirmationID, facts.Force, now); err != nil {
		return classifyControlWrite(err)
	}
	eventType := "device_binding." + facts.EventType
	return insertControlOutbox(ctx, tx, "device_binding", facts.ExecutorID, result.Binding.Revision,
		eventType, map[string]any{
			"executorId": facts.ExecutorID, "deviceId": result.Binding.DeviceID,
			"status": result.Binding.Status, "force": facts.Force,
		})
}

func lockBindableExecutor(ctx context.Context, tx *sql.Tx, executorID string) error {
	var runtimeType, status string
	if err := tx.QueryRowContext(ctx, `
		SELECT runtime_type,status FROM ky_ai_executor_config
		WHERE id=$1 AND scope_type='platform' AND scope_id='platform_root' AND executor_type='codex'
		FOR UPDATE
	`, executorID).Scan(&runtimeType, &status); errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if runtimeType != "desktop" {
		return ErrExecutorRuntimeUnsupported
	}
	if status != "enabled" {
		return ErrExecutorDisabled
	}
	return nil
}

func loadDeviceBindingForUpdate(ctx context.Context, tx *sql.Tx, executorID string) (storedDeviceBinding, bool, error) {
	var binding storedDeviceBinding
	err := tx.QueryRowContext(ctx, `
		SELECT executor_id,device_id,status,revision
		FROM ky_ai_executor_device_binding WHERE executor_id=$1 FOR UPDATE
	`, executorID).Scan(&binding.ExecutorID, &binding.DeviceID, &binding.Status, &binding.Revision)
	if errors.Is(err, sql.ErrNoRows) {
		return storedDeviceBinding{}, false, nil
	}
	return binding, err == nil, err
}

func loadDeviceBindingAuditByOperation(
	ctx context.Context,
	tx *sql.Tx,
	operationReference string,
) (storedDeviceBindingAudit, bool, error) {
	var item storedDeviceBindingAudit
	var keyGeneration, sequence int64
	err := tx.QueryRowContext(ctx, `
		SELECT operation_reference,executor_id,binding_revision,event_type,actor_id,actor_session_id,
		       workspace_type,workspace_id,expected_revision,from_device_id,target_device_id,
		       proof_device_id,proof_key_generation,proof_sequence,request_hash,confirmation_id,force,occurred_at
		FROM ky_ai_executor_device_binding_audit WHERE operation_reference=$1
	`, operationReference).Scan(
		&item.OperationReference, &item.ExecutorID, &item.BindingRevision, &item.EventType,
		&item.ActorID, &item.ActorSessionID, &item.WorkspaceType, &item.WorkspaceID,
		&item.ExpectedRevision, &item.FromDeviceID, &item.TargetDeviceID, &item.ProofDeviceID,
		&keyGeneration, &sequence, &item.RequestHash, &item.ConfirmationID, &item.Force, &item.OccurredAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return storedDeviceBindingAudit{}, false, nil
	}
	if err != nil {
		return storedDeviceBindingAudit{}, false, err
	}
	if keyGeneration < 0 || sequence < 0 {
		return storedDeviceBindingAudit{}, false, deviceauth.ErrInvalidLedgerState
	}
	item.ProofKeyGeneration, item.ProofSequence = uint64(keyGeneration), uint64(sequence)
	return item, true, nil
}

func resultFromBindingFacts(facts deviceBindingMutationFacts, revision int64, now time.Time, replayed bool) DeviceBindingResult {
	deviceID, status := facts.TargetDeviceID, "active"
	if facts.EventType == deviceBindingEventUnbound || facts.EventType == deviceBindingEventForceUnbind {
		deviceID, status = facts.FromDeviceID, "revoked"
	}
	return DeviceBindingResult{
		Binding: DeviceBindingProjection{
			ExecutorID: facts.ExecutorID, DeviceID: deviceID, Status: status,
			Revision: revision, Force: facts.Force, UpdatedAt: now.UTC().Format(time.RFC3339Nano),
		},
		ResponseReference: facts.OperationReference, Replayed: replayed,
	}
}

func resultFromBindingAudit(audit storedDeviceBindingAudit) DeviceBindingResult {
	facts := deviceBindingMutationFacts{
		EventType: audit.EventType, ExecutorID: audit.ExecutorID, FromDeviceID: audit.FromDeviceID,
		TargetDeviceID: audit.TargetDeviceID, OperationReference: audit.OperationReference, Force: audit.Force,
	}
	return resultFromBindingFacts(facts, audit.BindingRevision, audit.OccurredAt, true)
}

func commitDeviceBindingReplay(tx *sql.Tx, result DeviceBindingResult, replayErr error) (DeviceBindingResult, error) {
	if replayErr != nil {
		return DeviceBindingResult{}, replayErr
	}
	if err := tx.Commit(); err != nil {
		return DeviceBindingResult{}, classifyControlWrite(err)
	}
	return result, nil
}

func bindDevicePath(executorID string) string {
	return "/api/v1/ai-executors/" + executorID + "/device-bindings"
}

func rebindDevicePath(executorID string) string {
	return "/api/v1/ai-executors/" + executorID + "/device-binding/rebind"
}

func unbindDevicePath(executorID string) string {
	return "/api/v1/ai-executors/" + executorID + "/device-binding"
}

func isZeroVerifiedRequest(proof deviceauth.VerifiedRequest) bool {
	return proof == (deviceauth.VerifiedRequest{})
}
