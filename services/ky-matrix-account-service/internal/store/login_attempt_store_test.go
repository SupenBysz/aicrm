package store

import (
	"strings"
	"testing"
)

func TestLoginAttemptUpdateKeepsEmptySnapshotNullable(t *testing.T) {
	if !strings.Contains(updateLoginAttemptSQL, "snapshot_id=NULLIF($9, '')") {
		t.Fatal("login attempt updates must persist an empty snapshot id as SQL NULL before the snapshot FK exists")
	}
}

func TestLoginAttemptHappyPathStopsAtTrustedSnapshotBoundary(t *testing.T) {
	current := MatrixAccountLoginAttempt{
		Status:           "active",
		Phase:            "created",
		Activity:         "executing",
		CurrentStep:      loginStepOpen,
		AccountCandidate: map[string]any{},
	}

	current = applyTestStep(t, current, MatrixAccountLoginStepResultInput{MethodKey: loginStepOpen, Status: "success"})
	if current.CurrentStep != loginStepQRGet || current.Phase != "qr_preparing" {
		t.Fatalf("open transition = %#v", current)
	}
	current = applyTestStep(t, current, MatrixAccountLoginStepResultInput{MethodKey: loginStepQRGet, Status: "success"})
	if current.QRRevision != 1 || current.CurrentStep != loginStepStatusProbe {
		t.Fatalf("qr transition = %#v", current)
	}
	current = applyTestStep(t, current, MatrixAccountLoginStepResultInput{MethodKey: loginStepStatusProbe, Status: "success", ObservedPhase: "authenticated"})
	current = applyTestStep(t, current, MatrixAccountLoginStepResultInput{
		MethodKey: loginStepAccountIdentity,
		Status:    "success",
		ResultSummary: map[string]any{
			"identityKey": "douyin-user-1",
		},
	})
	current = applyTestStep(t, current, MatrixAccountLoginStepResultInput{
		MethodKey: loginStepAccountProfile,
		Status:    "success",
		ResultSummary: map[string]any{
			"nickname": "Account One",
		},
	})
	current = applyTestStep(t, current, MatrixAccountLoginStepResultInput{MethodKey: loginStepBindingConfirm, Status: "success"})
	if current.CurrentStep != loginStepSnapshotSeal || current.Phase != "snapshot_sealing" {
		t.Fatalf("binding transition = %#v", current)
	}

	_, err := transitionLoginAttemptStep(current, MatrixAccountLoginStepResultInput{
		MethodKey: loginStepSnapshotSeal,
		Status:    "success",
		ResultSummary: map[string]any{
			"snapshotId":      "snapshot-1",
			"fingerprintHash": strings.Repeat("a", 64),
			"contentHash":     strings.Repeat("b", 64),
			"verified":        true,
		},
	})
	if err != ErrValidation {
		t.Fatalf("ordinary snapshot success must be rejected, got %v", err)
	}

	failed := applyTestStep(t, current, MatrixAccountLoginStepResultInput{
		MethodKey: loginStepSnapshotSeal,
		Status:    "failed",
		ErrorCode: "TRUSTED_RUNTIME_PROOF_UNAVAILABLE",
	})
	if failed.BlockedMethod != loginStepSnapshotSeal || failed.LastErrorCode != "TRUSTED_RUNTIME_PROOF_UNAVAILABLE" {
		t.Fatalf("snapshot failure transition = %#v", failed)
	}
	if failed.SnapshotVerified || failed.SnapshotID != "" {
		t.Fatalf("untrusted snapshot state was persisted in transition: %#v", failed)
	}
}

func TestTrustedRuntimeOnlySuccessCannotAdvanceStoreTransition(t *testing.T) {
	tests := []struct {
		name    string
		current MatrixAccountLoginAttempt
		input   MatrixAccountLoginStepResultInput
	}{
		{
			name: "snapshot seal",
			current: MatrixAccountLoginAttempt{
				Status: "active", Phase: "snapshot_sealing", CurrentStep: loginStepSnapshotSeal,
			},
			input: MatrixAccountLoginStepResultInput{MethodKey: loginStepSnapshotSeal, Status: "success"},
		},
		{
			name: "onboarding complete",
			current: MatrixAccountLoginAttempt{
				Status: "active", Phase: "committing", CurrentStep: loginStepComplete,
			},
			input: MatrixAccountLoginStepResultInput{MethodKey: loginStepComplete, Status: "success"},
		},
		{
			name: "web space cleanup",
			current: MatrixAccountLoginAttempt{
				Status: "active", Phase: "cleanup_pending", CurrentStep: loginStepWebSpaceCleanup,
			},
			input: MatrixAccountLoginStepResultInput{MethodKey: loginStepWebSpaceCleanup, Status: "success"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := transitionLoginAttemptStep(tt.current, tt.input); err != ErrValidation {
				t.Fatalf("trusted-only success error = %v", err)
			}
			failure := tt.input
			failure.Status = "failed"
			failure.ErrorCode = "TRUSTED_RUNTIME_PROOF_UNAVAILABLE"
			transition, err := transitionLoginAttemptStep(tt.current, failure)
			if err != nil {
				t.Fatalf("failure result should remain recordable: %v", err)
			}
			if transition.BlockedMethod != tt.input.MethodKey || transition.LastErrorCode == "" {
				t.Fatalf("failure transition = %#v", transition)
			}
		})
	}
}

func TestLoginAttemptFailureAndRetry(t *testing.T) {
	current := MatrixAccountLoginAttempt{
		Status:           "active",
		Phase:            "qr_preparing",
		Activity:         "executing",
		CurrentStep:      loginStepQRGet,
		AccountCandidate: map[string]any{},
	}
	failed := applyTestStep(t, current, MatrixAccountLoginStepResultInput{
		MethodKey: loginStepQRGet,
		Status:    "failed",
		ErrorCode: "PAGE_CHANGED",
	})
	if failed.Activity != "repairing_adapter" || failed.BlockedMethod != loginStepQRGet {
		t.Fatalf("failed transition = %#v", failed)
	}
	expectedSequence := failed.Sequence
	retry, err := transitionLoginAttemptCommand(failed, "retry", nil, &expectedSequence)
	if err != nil {
		t.Fatal(err)
	}
	if retry.Activity != "retrying" || retry.LastErrorCode != "" || retry.CurrentStep != loginStepQRGet {
		t.Fatalf("retry transition = %#v", retry)
	}
}

func TestRefreshQRRequiresMatchingRevision(t *testing.T) {
	current := MatrixAccountLoginAttempt{Status: "active", Phase: "qr_ready", QRRevision: 3}
	stale := 2
	if _, err := transitionLoginAttemptCommand(current, "refresh_qr", &stale, nil); err != ErrConflict {
		t.Fatalf("stale refresh error = %v", err)
	}
	matching := 3
	transition, err := transitionLoginAttemptCommand(current, "refresh_qr", &matching, nil)
	if err != nil {
		t.Fatal(err)
	}
	if transition.CurrentStep != loginStepQRRefresh || transition.Phase != "qr_preparing" {
		t.Fatalf("refresh transition = %#v", transition)
	}
}

func applyTestStep(t *testing.T, current MatrixAccountLoginAttempt, input MatrixAccountLoginStepResultInput) MatrixAccountLoginAttempt {
	t.Helper()
	transition, err := transitionLoginAttemptStep(current, input)
	if err != nil {
		t.Fatal(err)
	}
	return MatrixAccountLoginAttempt{
		Status:                  transition.Status,
		Phase:                   transition.Phase,
		Activity:                transition.Activity,
		CurrentStep:             transition.CurrentStep,
		BlockedMethod:           transition.BlockedMethod,
		QRRevision:              transition.QRRevision,
		AccountID:               transition.AccountID,
		SnapshotID:              transition.SnapshotID,
		AccountCandidate:        transition.AccountCandidate,
		BindingInput:            transition.BindingInput,
		SnapshotFingerprintHash: transition.SnapshotFingerprintHash,
		SnapshotContentHash:     transition.SnapshotContentHash,
		SnapshotVerified:        transition.SnapshotVerified,
		LastErrorCode:           transition.LastErrorCode,
		LastErrorMessage:        transition.LastErrorMessage,
	}
}
