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

func TestLoginAttemptHappyPathRequiresVerifiedSnapshot(t *testing.T) {
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

	_, err := transitionLoginAttemptStep(current, MatrixAccountLoginStepResultInput{
		MethodKey: loginStepSnapshotSeal,
		Status:    "success",
		ResultSummary: map[string]any{
			"snapshotId":      "snapshot-1",
			"fingerprintHash": "fingerprint",
			"contentHash":     "content",
			"verified":        false,
		},
	})
	if err != ErrValidation {
		t.Fatalf("unverified snapshot error = %v", err)
	}

	current = applyTestStep(t, current, MatrixAccountLoginStepResultInput{
		MethodKey: loginStepSnapshotSeal,
		Status:    "success",
		ResultSummary: map[string]any{
			"snapshotId":      "snapshot-1",
			"fingerprintHash": "fingerprint",
			"contentHash":     "content",
			"verified":        true,
		},
	})
	if current.Phase != "committing" || current.SnapshotID != "snapshot-1" || current.CurrentStep != loginStepComplete {
		t.Fatalf("snapshot transition = %#v", current)
	}

	_, err = transitionLoginAttemptStep(current, MatrixAccountLoginStepResultInput{
		MethodKey:     loginStepComplete,
		Status:        "success",
		ResultSummary: map[string]any{"accountId": "ma_1", "snapshotVerified": true},
	})
	if err != ErrValidation {
		t.Fatalf("empty verification receipt error = %v", err)
	}
	completed := applyTestStep(t, current, MatrixAccountLoginStepResultInput{
		MethodKey:           loginStepComplete,
		Status:              "success",
		VerificationReceipt: "native-receipt",
		ResultSummary:       map[string]any{"accountId": "ma_1", "snapshotVerified": true},
	})
	if completed.Status != "completed" || completed.Phase != "ready" || completed.AccountID != "ma_1" {
		t.Fatalf("complete transition = %#v", completed)
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
