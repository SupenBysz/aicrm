package deviceauth

import (
	"crypto/subtle"
	"errors"
	"fmt"
)

var (
	ErrInvalidLedgerInput = errors.New("invalid device request ledger input")
	ErrInvalidLedgerState = errors.New("invalid device request ledger state")
)

const DeviceProofReplayedCode = "device_proof_replayed"

type LedgerAction string

const (
	LedgerAcceptNew      LedgerAction = "accept_new"
	LedgerReturnRecorded LedgerAction = "return_recorded"
	LedgerRejectReplay   LedgerAction = "reject_replay"
)

type ReplayReason string

const (
	ReplayReasonNone                  ReplayReason = ""
	ReplayReasonSequenceConflict      ReplayReason = "sequence_conflict"
	ReplayReasonNonceConflict         ReplayReason = "nonce_conflict"
	ReplayReasonSequenceNotIncreasing ReplayReason = "sequence_not_increasing"
)

type LedgerRequest struct {
	DeviceID               string
	KeyGeneration          uint64
	Sequence               uint64
	Nonce                  string
	RequestHash            string
	AuthorizationTokenHash string
}

type LedgerRecord struct {
	LedgerRequest
	ResponseReference string
}

// LedgerState must be loaded while holding the same database transaction that
// will insert the request ledger row, advance the device high-water mark, and
// commit the business mutation. This pure decision is not a replacement for
// the required unique constraints and CAS.
type LedgerState struct {
	Existing             *LedgerRecord
	NonceAlreadyUsed     bool
	LastAcceptedSequence uint64
}

type LedgerDecision struct {
	Action            LedgerAction
	FailureCode       string
	Reason            ReplayReason
	ResponseReference string
}

func DecideLedgerRequest(request LedgerRequest, state LedgerState) (LedgerDecision, error) {
	if err := validateLedgerRequest(request); err != nil {
		return LedgerDecision{}, err
	}
	if state.Existing != nil {
		if err := validateLedgerRecord(*state.Existing); err != nil {
			return LedgerDecision{}, err
		}
		if state.Existing.DeviceID != request.DeviceID ||
			state.Existing.KeyGeneration != request.KeyGeneration ||
			state.Existing.Sequence != request.Sequence {
			return LedgerDecision{}, ErrInvalidLedgerState
		}
		if constantStringEqual(state.Existing.RequestHash, request.RequestHash) &&
			constantStringEqual(state.Existing.Nonce, request.Nonce) &&
			constantStringEqual(state.Existing.AuthorizationTokenHash, request.AuthorizationTokenHash) {
			return LedgerDecision{
				Action:            LedgerReturnRecorded,
				ResponseReference: state.Existing.ResponseReference,
			}, nil
		}
		return replayRejected(ReplayReasonSequenceConflict), nil
	}
	if state.NonceAlreadyUsed {
		return replayRejected(ReplayReasonNonceConflict), nil
	}
	if request.Sequence <= state.LastAcceptedSequence {
		return replayRejected(ReplayReasonSequenceNotIncreasing), nil
	}
	return LedgerDecision{Action: LedgerAcceptNew}, nil
}

func replayRejected(reason ReplayReason) LedgerDecision {
	return LedgerDecision{
		Action:      LedgerRejectReplay,
		FailureCode: DeviceProofReplayedCode,
		Reason:      reason,
	}
}

func validateLedgerRequest(request LedgerRequest) error {
	if ValidateDeviceID(request.DeviceID) != nil || request.KeyGeneration == 0 || request.Sequence == 0 ||
		ValidateNonce(request.Nonce) != nil || validateDigest(request.RequestHash, false) != nil ||
		validateDigest(request.AuthorizationTokenHash, true) != nil {
		return ErrInvalidLedgerInput
	}
	return nil
}

func validateLedgerRecord(record LedgerRecord) error {
	if err := validateLedgerRequest(record.LedgerRequest); err != nil {
		return fmt.Errorf("%w: record", ErrInvalidLedgerState)
	}
	if record.ResponseReference == "" || len(record.ResponseReference) > 512 {
		return ErrInvalidLedgerState
	}
	for index := 0; index < len(record.ResponseReference); index++ {
		if record.ResponseReference[index] < 0x21 || record.ResponseReference[index] > 0x7e {
			return ErrInvalidLedgerState
		}
	}
	return nil
}

func constantStringEqual(left, right string) bool {
	return len(left) == len(right) && subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}
