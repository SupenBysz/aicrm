package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
)

const (
	loginStepOpen            = "login.open.v1"
	loginStepQRGet           = "login.qr.get.v1"
	loginStepQRRefresh       = "login.qr.refresh.v1"
	loginStepStatusProbe     = "login.status.probe.v1"
	loginStepAccountIdentity = "account.identity.get.v1"
	loginStepAccountProfile  = "account.profile.get.v1"
	loginStepBindingConfirm  = "business.binding.confirm.v1"
	loginStepSnapshotSeal    = "session.snapshot.seal.v1"
	loginStepComplete        = "business.onboarding.complete.v1"
	loginStepWebSpaceCleanup = "web_space.cleanup.v1"
)

const updateLoginAttemptSQL = `
	UPDATE ky_matrix_account_login_attempt
	SET status=$2, phase=$3, activity=$4, current_step=$5, blocked_method=$6,
	    qr_revision=$7, account_id=NULLIF($8, ''), snapshot_id=NULLIF($9, ''), account_candidate=$10,
	    binding_input=$11, snapshot_fingerprint_hash=$12, snapshot_content_hash=$13,
	    snapshot_verified=$14, sequence=$15, last_error_code=$16, last_error_message=$17,
	    completed_at=CASE WHEN $2='completed' THEN now() ELSE completed_at END,
	    cancelled_at=CASE WHEN $2='cancelled' THEN now() ELSE cancelled_at END,
	    updated_by=$18, updated_at=now()
	WHERE id=$1 AND deleted_at IS NULL
`

type loginAttemptTransition struct {
	Status                  string
	Phase                   string
	Activity                string
	CurrentStep             string
	BlockedMethod           string
	QRRevision              int
	AccountID               string
	SnapshotID              string
	AccountCandidate        map[string]any
	BindingInput            map[string]any
	SnapshotFingerprintHash string
	SnapshotContentHash     string
	SnapshotVerified        bool
	LastErrorCode           string
	LastErrorMessage        string
	EventType               string
	Recoverable             bool
	NextActions             []string
	EventData               map[string]any
}

func (s *Store) CreateLoginAttempt(ctx context.Context, workspaceType, workspaceID, memberID, actorUserID string, in MatrixAccountLoginAttemptInput) (MatrixAccountLoginAttempt, error) {
	deviceID := strings.TrimSpace(in.DeviceID)
	if deviceID == "" {
		deviceID = "default"
	}
	if in.IdempotencyKey != "" {
		item, err := s.getLoginAttemptByIdempotencyKey(ctx, workspaceType, workspaceID, memberID, in.IdempotencyKey)
		if err == nil {
			if item.Platform != in.Platform || item.DeviceID != deviceID {
				return MatrixAccountLoginAttempt{}, ErrConflict
			}
			return item, nil
		}
		if !errors.Is(err, ErrNotFound) {
			return MatrixAccountLoginAttempt{}, err
		}
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MatrixAccountLoginAttempt{}, err
	}
	defer func() { _ = tx.Rollback() }()

	webSpaceID := newID("maws")
	partition := webSpacePartition(workspaceType, workspaceID, in.Platform, webSpaceID, deviceID)
	_, err = tx.ExecContext(ctx, `
		INSERT INTO ky_matrix_account_web_space (
		  id, workspace_type, workspace_id, platform, member_id, device_id, browser_partition,
		  status, created_by, updated_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,'opening',$8,$8)
	`, webSpaceID, workspaceType, workspaceID, in.Platform, memberID, deviceID, partition, actorUserID)
	if err := classifyWriteErr(err); err != nil {
		return MatrixAccountLoginAttempt{}, err
	}

	attemptID := newID("mala")
	_, err = tx.ExecContext(ctx, `
		INSERT INTO ky_matrix_account_login_attempt (
		  id, workspace_type, workspace_id, platform, member_id, device_id, web_space_id,
		  status, phase, activity, current_step, sequence, idempotency_key, created_by, updated_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,'active','created','executing',$8,1,$9,$10,$10)
	`, attemptID, workspaceType, workspaceID, in.Platform, memberID, deviceID, webSpaceID, loginStepOpen, in.IdempotencyKey, actorUserID)
	if err := classifyWriteErr(err); err != nil {
		if errors.Is(err, ErrConflict) && in.IdempotencyKey != "" {
			_ = tx.Rollback()
			item, getErr := s.getLoginAttemptByIdempotencyKey(ctx, workspaceType, workspaceID, memberID, in.IdempotencyKey)
			if getErr != nil {
				return MatrixAccountLoginAttempt{}, getErr
			}
			if item.Platform != in.Platform || item.DeviceID != deviceID {
				return MatrixAccountLoginAttempt{}, ErrConflict
			}
			return item, nil
		}
		return MatrixAccountLoginAttempt{}, err
	}
	if _, err := insertLoginAttemptEvent(ctx, tx, attemptID, 1, "onboarding.created", "created", false, []string{"open_controlled_window", "cancel"}, map[string]any{
		"platform": in.Platform,
	}, "user", actorUserID); err != nil {
		return MatrixAccountLoginAttempt{}, err
	}
	if err := tx.Commit(); err != nil {
		return MatrixAccountLoginAttempt{}, err
	}
	return s.GetLoginAttempt(ctx, workspaceType, workspaceID, memberID, attemptID)
}

func (s *Store) GetLoginAttempt(ctx context.Context, workspaceType, workspaceID, memberID, id string) (MatrixAccountLoginAttempt, error) {
	return s.queryLoginAttempt(ctx, loginAttemptSelectSQL()+`
		WHERE a.workspace_type=$1 AND a.workspace_id=$2 AND a.member_id=$3 AND a.id=$4
		  AND a.deleted_at IS NULL
	`, workspaceType, workspaceID, memberID, id)
}

func (s *Store) HasLoginAttemptForWebSpace(
	ctx context.Context,
	workspaceType, workspaceID, memberID, webSpaceID string,
) (bool, error) {
	var exists bool
	err := s.db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM ky_matrix_account_login_attempt
			WHERE workspace_type=$1 AND workspace_id=$2 AND member_id=$3
			  AND web_space_id=$4 AND deleted_at IS NULL
		)
	`, workspaceType, workspaceID, memberID, webSpaceID).Scan(&exists)
	return exists, err
}

func (s *Store) getLoginAttemptByIdempotencyKey(ctx context.Context, workspaceType, workspaceID, memberID, key string) (MatrixAccountLoginAttempt, error) {
	return s.queryLoginAttempt(ctx, loginAttemptSelectSQL()+`
		WHERE a.workspace_type=$1 AND a.workspace_id=$2 AND a.member_id=$3 AND a.idempotency_key=$4
		  AND a.deleted_at IS NULL
	`, workspaceType, workspaceID, memberID, key)
}

func (s *Store) ListLoginAttemptEvents(ctx context.Context, workspaceType, workspaceID, memberID, attemptID string, afterSequence int64, limit int) ([]MatrixAccountLoginAttemptEvent, error) {
	if _, err := s.GetLoginAttempt(ctx, workspaceType, workspaceID, memberID, attemptID); err != nil {
		return nil, err
	}
	if limit < 1 || limit > 200 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, attempt_id, sequence, event_type, phase, recoverable, next_actions, data_json,
		       actor_type, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')
		FROM ky_matrix_account_login_attempt_event
		WHERE attempt_id=$1 AND sequence>$2
		ORDER BY sequence ASC
		LIMIT $3
	`, attemptID, afterSequence, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]MatrixAccountLoginAttemptEvent, 0)
	for rows.Next() {
		item, err := scanLoginAttemptEvent(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) ApplyLoginAttemptCommand(
	ctx context.Context,
	workspaceType, workspaceID, memberID, actorUserID, attemptID, commandID, commandType string,
	expectedRevision *int,
	expectedSequence *int64,
	reason string,
) (MatrixAccountLoginCommandResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MatrixAccountLoginCommandResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	current, err := getLoginAttemptForUpdate(ctx, tx, workspaceType, workspaceID, memberID, attemptID)
	if err != nil {
		return MatrixAccountLoginCommandResult{}, err
	}
	if existing, err := getLoginAttemptCommand(ctx, tx, attemptID, commandID); err == nil {
		if existing.CommandType != commandType {
			return MatrixAccountLoginCommandResult{}, ErrConflict
		}
		if commandType == "refresh_qr" {
			existingRevision, ok := summaryInt(existing.Result, "expectedRevision")
			if expectedRevision == nil || !ok || existingRevision != *expectedRevision {
				return MatrixAccountLoginCommandResult{}, ErrConflict
			}
		}
		if commandType == "retry" {
			existingSequence, ok := summaryInt64(existing.Result, "expectedSequence")
			if expectedSequence == nil || !ok || existingSequence != *expectedSequence {
				return MatrixAccountLoginCommandResult{}, ErrConflict
			}
		}
		if existingReason := summaryString(existing.Result, "reason"); existingReason != reason {
			return MatrixAccountLoginCommandResult{}, ErrConflict
		}
		_ = tx.Rollback()
		attempt, getErr := s.GetLoginAttempt(ctx, workspaceType, workspaceID, memberID, attemptID)
		if getErr != nil {
			return MatrixAccountLoginCommandResult{}, getErr
		}
		return MatrixAccountLoginCommandResult{Attempt: attempt, Command: existing}, nil
	} else if !errors.Is(err, ErrNotFound) {
		return MatrixAccountLoginCommandResult{}, err
	}

	transition, err := transitionLoginAttemptCommand(current, commandType, expectedRevision, expectedSequence)
	if err != nil {
		return MatrixAccountLoginCommandResult{}, err
	}
	if reason != "" {
		transition.EventData["reason"] = reason
	}
	sequence := current.Sequence + 1
	if err := updateLoginAttempt(ctx, tx, current.ID, sequence, transition, actorUserID); err != nil {
		return MatrixAccountLoginCommandResult{}, err
	}
	event, err := insertLoginAttemptEvent(ctx, tx, current.ID, sequence, transition.EventType, transition.Phase, transition.Recoverable, transition.NextActions, transition.EventData, "user", actorUserID)
	if err != nil {
		return MatrixAccountLoginCommandResult{}, err
	}
	commandResult := map[string]any{"sequence": sequence}
	if expectedRevision != nil {
		commandResult["expectedRevision"] = *expectedRevision
	}
	if expectedSequence != nil {
		commandResult["expectedSequence"] = *expectedSequence
	}
	if reason != "" {
		commandResult["reason"] = reason
	}
	resultJSON, _ := json.Marshal(commandResult)
	command := MatrixAccountLoginCommand{
		ID:          newID("malc"),
		AttemptID:   attemptID,
		CommandID:   commandID,
		CommandType: commandType,
		Status:      "completed",
		Result:      commandResult,
	}
	var completedAt string
	err = tx.QueryRowContext(ctx, `
		INSERT INTO ky_matrix_account_login_attempt_command (
		  id, attempt_id, command_id, command_type, status, result_json, created_by, completed_at)
		VALUES ($1,$2,$3,$4,'completed',$5,$6,now())
		RETURNING to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		          to_char(completed_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')
	`, command.ID, attemptID, commandID, commandType, resultJSON, actorUserID).Scan(&command.CreatedAt, &completedAt)
	if err := classifyWriteErr(err); err != nil {
		return MatrixAccountLoginCommandResult{}, err
	}
	command.CompletedAt = &completedAt
	if err := tx.Commit(); err != nil {
		return MatrixAccountLoginCommandResult{}, err
	}
	attempt, err := s.GetLoginAttempt(ctx, workspaceType, workspaceID, memberID, attemptID)
	if err != nil {
		return MatrixAccountLoginCommandResult{}, err
	}
	return MatrixAccountLoginCommandResult{Attempt: attempt, Command: command, Event: &event}, nil
}

func (s *Store) SubmitLoginAttemptStepResult(ctx context.Context, workspaceType, workspaceID, memberID, actorUserID, attemptID string, in MatrixAccountLoginStepResultInput) (MatrixAccountLoginStepResult, error) {
	if in.AttemptNo < 1 {
		in.AttemptNo = 1
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MatrixAccountLoginStepResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	current, err := getLoginAttemptForUpdate(ctx, tx, workspaceType, workspaceID, memberID, attemptID)
	if err != nil {
		return MatrixAccountLoginStepResult{}, err
	}
	if existing, eventSequence, err := getLoginMethodRun(ctx, tx, attemptID, in.OperationID, in.AttemptNo); err == nil {
		if existing.MethodKey != in.MethodKey || existing.Status != in.Status ||
			existing.ScriptID != in.ScriptID || existing.ScriptVersionID != in.ScriptVersionID ||
			existing.ObservedPhase != in.ObservedPhase || existing.ErrorCode != in.ErrorCode ||
			!reflect.DeepEqual(existing.ResultSummary, nonNilMap(in.ResultSummary)) {
			return MatrixAccountLoginStepResult{}, ErrConflict
		}
		event, eventErr := getLoginAttemptEvent(ctx, tx, attemptID, eventSequence)
		if eventErr != nil {
			return MatrixAccountLoginStepResult{}, eventErr
		}
		_ = tx.Rollback()
		attempt, getErr := s.GetLoginAttempt(ctx, workspaceType, workspaceID, memberID, attemptID)
		if getErr != nil {
			return MatrixAccountLoginStepResult{}, getErr
		}
		return MatrixAccountLoginStepResult{Attempt: attempt, Run: existing, Event: event}, nil
	} else if !errors.Is(err, ErrNotFound) {
		return MatrixAccountLoginStepResult{}, err
	}

	transition, err := transitionLoginAttemptStep(current, in)
	if err != nil {
		return MatrixAccountLoginStepResult{}, err
	}
	if in.MethodKey == loginStepSnapshotSeal && in.Status == "success" {
		if err := persistVerifiedSessionSnapshot(ctx, tx, current, actorUserID, in.ResultSummary); err != nil {
			return MatrixAccountLoginStepResult{}, err
		}
	}
	if in.MethodKey == loginStepComplete && in.Status == "success" {
		accountID, err := finalizeLoginAttempt(ctx, tx, current, transition.AccountID, actorUserID)
		if err != nil {
			return MatrixAccountLoginStepResult{}, err
		}
		transition.AccountID = accountID
		transition.EventData["accountId"] = accountID
	}
	if in.Status == "success" && in.MethodKey != loginStepComplete {
		webSpaceStatus := ""
		switch in.MethodKey {
		case loginStepOpen, loginStepQRGet, loginStepQRRefresh, loginStepStatusProbe:
			webSpaceStatus = "waiting_login"
		case loginStepAccountIdentity, loginStepAccountProfile, loginStepBindingConfirm, loginStepSnapshotSeal:
			webSpaceStatus = "detected"
		case loginStepWebSpaceCleanup:
			webSpaceStatus = "cleared"
		}
		if webSpaceStatus != "" {
			_, err = tx.ExecContext(ctx, `
				UPDATE ky_matrix_account_web_space
				SET status=$2, updated_by=$3, updated_at=now()
				WHERE id=$1 AND status NOT IN ('bound','abandoned','cleared') AND deleted_at IS NULL
			`, current.WebSpaceID, webSpaceStatus, actorUserID)
			if err := classifyWriteErr(err); err != nil {
				return MatrixAccountLoginStepResult{}, err
			}
		}
	}

	sequence := current.Sequence + 1
	if err := updateLoginAttempt(ctx, tx, current.ID, sequence, transition, actorUserID); err != nil {
		return MatrixAccountLoginStepResult{}, err
	}
	event, err := insertLoginAttemptEvent(ctx, tx, current.ID, sequence, transition.EventType, transition.Phase, transition.Recoverable, transition.NextActions, transition.EventData, "desktop", actorUserID)
	if err != nil {
		return MatrixAccountLoginStepResult{}, err
	}
	run, err := insertLoginMethodRun(ctx, tx, current, sequence, actorUserID, in)
	if err != nil {
		return MatrixAccountLoginStepResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return MatrixAccountLoginStepResult{}, err
	}
	attempt, err := s.GetLoginAttempt(ctx, workspaceType, workspaceID, memberID, attemptID)
	if err != nil {
		return MatrixAccountLoginStepResult{}, err
	}
	return MatrixAccountLoginStepResult{Attempt: attempt, Run: run, Event: event}, nil
}

func transitionLoginAttemptCommand(current MatrixAccountLoginAttempt, commandType string, expectedRevision *int, expectedSequence *int64) (loginAttemptTransition, error) {
	transition := transitionFromAttempt(current)
	transition.EventData = map[string]any{"command": commandType}
	if current.Status != "active" {
		return loginAttemptTransition{}, ErrValidation
	}
	switch commandType {
	case "refresh_qr":
		if expectedRevision == nil || *expectedRevision != current.QRRevision {
			return loginAttemptTransition{}, ErrConflict
		}
		if current.Phase != "qr_ready" && current.Phase != "waiting_scan" && current.Phase != "qr_expired" {
			return loginAttemptTransition{}, ErrValidation
		}
		transition.Phase = "qr_preparing"
		transition.Activity = "executing"
		transition.CurrentStep = loginStepQRRefresh
		transition.EventType = "qr.refresh_requested"
		transition.NextActions = []string{"wait", "cancel"}
	case "retry":
		if expectedSequence == nil || *expectedSequence != current.Sequence {
			return loginAttemptTransition{}, ErrConflict
		}
		if current.LastErrorCode == "" || current.CurrentStep == "" {
			return loginAttemptTransition{}, ErrValidation
		}
		transition.Activity = "retrying"
		transition.BlockedMethod = ""
		transition.LastErrorCode = ""
		transition.LastErrorMessage = ""
		transition.EventType = "onboarding.retry_requested"
		transition.NextActions = []string{"wait", "cancel"}
	case "cancel":
		transition.Phase = "cancelling"
		transition.Activity = "executing"
		transition.CurrentStep = loginStepWebSpaceCleanup
		transition.BlockedMethod = ""
		transition.EventType = "onboarding.cancel_requested"
		transition.NextActions = []string{"wait"}
	default:
		return loginAttemptTransition{}, ErrValidation
	}
	return transition, nil
}

func transitionLoginAttemptStep(current MatrixAccountLoginAttempt, in MatrixAccountLoginStepResultInput) (loginAttemptTransition, error) {
	if current.Status != "active" || in.MethodKey == "" || in.MethodKey != current.CurrentStep {
		return loginAttemptTransition{}, ErrValidation
	}
	if isTrustedRuntimeOnlyStepSuccess(in.MethodKey, in.Status) {
		return loginAttemptTransition{}, ErrValidation
	}
	transition := transitionFromAttempt(current)
	transition.EventData = map[string]any{
		"operationId": in.OperationID,
		"methodKey":   in.MethodKey,
	}
	if in.Status != "success" {
		transition.Activity = "none"
		transition.BlockedMethod = in.MethodKey
		transition.LastErrorCode = firstNonEmpty(in.ErrorCode, "STEP_FAILED")
		transition.LastErrorMessage = in.ErrorMessage
		transition.EventType = "onboarding.step_failed"
		transition.Recoverable = true
		transition.NextActions = []string{"retry_step", "cancel"}
		if in.ErrorCode == "METHOD_MISSING" || in.ErrorCode == "PAGE_CHANGED" || in.ErrorCode == "CONTRACT_FAILED" {
			transition.Activity = "repairing_adapter"
			transition.EventType = "adapter.repairing"
		}
		if in.MethodKey == loginStepWebSpaceCleanup {
			transition.Phase = "cleanup_pending"
			transition.EventType = "onboarding.cleanup_pending"
			transition.NextActions = []string{"retry_step"}
		}
		return transition, nil
	}

	transition.BlockedMethod = ""
	transition.LastErrorCode = ""
	transition.LastErrorMessage = ""
	switch in.MethodKey {
	case loginStepOpen:
		transition.Phase = "qr_preparing"
		transition.Activity = "executing"
		transition.CurrentStep = loginStepQRGet
		transition.EventType = "web_space.ready"
		transition.NextActions = []string{"wait", "cancel"}
	case loginStepQRGet:
		transition.Phase = "qr_ready"
		transition.Activity = "waiting_user"
		transition.CurrentStep = loginStepStatusProbe
		transition.QRRevision++
		transition.EventType = "qr.ready"
		transition.EventData["qrRevision"] = transition.QRRevision
		transition.NextActions = []string{"wait", "refresh_qr", "open_controlled_window", "cancel"}
	case loginStepQRRefresh:
		transition.Phase = "qr_preparing"
		transition.Activity = "executing"
		transition.CurrentStep = loginStepQRGet
		transition.EventType = "qr.refreshed"
		transition.NextActions = []string{"wait", "cancel"}
	case loginStepStatusProbe:
		if err := applyObservedLoginPhase(&transition, in.ObservedPhase); err != nil {
			return loginAttemptTransition{}, err
		}
	case loginStepAccountIdentity:
		transition.Phase = "identifying"
		transition.Activity = "executing"
		transition.CurrentStep = loginStepAccountProfile
		transition.AccountCandidate = cloneSummary(in.ResultSummary)
		transition.EventType = "account.identity_detected"
		transition.NextActions = []string{"wait", "cancel"}
	case loginStepAccountProfile:
		transition.Phase = "awaiting_confirmation"
		transition.Activity = "waiting_user"
		transition.CurrentStep = loginStepBindingConfirm
		transition.AccountCandidate = mergeSummary(current.AccountCandidate, in.ResultSummary)
		transition.EventType = "account.identified"
		transition.NextActions = []string{"confirm_binding", "cancel"}
	case loginStepBindingConfirm:
		bindingInput, _ := in.ResultSummary["bindingInput"].(map[string]any)
		transition.BindingInput = cloneSummary(bindingInput)
		transition.Phase = "snapshot_sealing"
		transition.Activity = "executing"
		transition.CurrentStep = loginStepSnapshotSeal
		transition.EventType = "binding.confirmed"
		transition.NextActions = []string{"wait", "cancel"}
	case loginStepSnapshotSeal:
		snapshotID, _ := in.ResultSummary["snapshotId"].(string)
		fingerprintHash, _ := in.ResultSummary["fingerprintHash"].(string)
		contentHash, _ := in.ResultSummary["contentHash"].(string)
		if strings.TrimSpace(snapshotID) == "" || strings.TrimSpace(fingerprintHash) == "" || strings.TrimSpace(contentHash) == "" || !summaryBool(in.ResultSummary, "verified") {
			return loginAttemptTransition{}, ErrValidation
		}
		transition.SnapshotID = snapshotID
		transition.SnapshotFingerprintHash = fingerprintHash
		transition.SnapshotContentHash = contentHash
		transition.SnapshotVerified = true
		transition.Phase = "committing"
		transition.Activity = "executing"
		transition.CurrentStep = loginStepComplete
		transition.EventType = "snapshot.verified"
		transition.EventData["snapshotId"] = snapshotID
		transition.NextActions = []string{"wait", "cancel"}
	case loginStepComplete:
		accountID, _ := in.ResultSummary["accountId"].(string)
		if strings.TrimSpace(accountID) == "" {
			accountID = summaryString(current.BindingInput, "accountId")
		}
		if current.Phase != "committing" || current.SnapshotID == "" || !current.SnapshotVerified || current.SnapshotFingerprintHash == "" || current.SnapshotContentHash == "" || !summaryBool(in.ResultSummary, "snapshotVerified") {
			return loginAttemptTransition{}, ErrValidation
		}
		transition.AccountID = accountID
		transition.Status = "completed"
		transition.Phase = "ready"
		transition.Activity = "none"
		transition.CurrentStep = ""
		transition.EventType = "account.ready"
		transition.EventData["accountId"] = accountID
		transition.NextActions = []string{}
	case loginStepWebSpaceCleanup:
		if !summaryBool(in.ResultSummary, "cleared") {
			return loginAttemptTransition{}, ErrValidation
		}
		transition.Status = "cancelled"
		transition.Phase = "cancelled"
		transition.Activity = "none"
		transition.CurrentStep = ""
		transition.EventType = "onboarding.cancelled"
		transition.NextActions = []string{}
	default:
		return loginAttemptTransition{}, ErrValidation
	}
	return transition, nil
}

func isTrustedRuntimeOnlyStepSuccess(methodKey, status string) bool {
	if status != "success" {
		return false
	}
	switch methodKey {
	case loginStepSnapshotSeal, loginStepComplete, loginStepWebSpaceCleanup:
		return true
	default:
		return false
	}
}

func finalizeLoginAttempt(ctx context.Context, tx *sql.Tx, current MatrixAccountLoginAttempt, expectedAccountID, actorUserID string) (string, error) {
	identityKey := summaryString(current.AccountCandidate, "identityKey")
	if len(identityKey) < 6 {
		return "", ErrValidation
	}
	ownerMemberID := summaryString(current.BindingInput, "ownerMemberId")
	if ownerMemberID == "" {
		ownerMemberID = current.MemberID
	}
	var membershipExists int
	err := tx.QueryRowContext(ctx, `
		SELECT 1 FROM ky_membership
		WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3 AND status='active' AND deleted_at IS NULL
	`, ownerMemberID, current.WorkspaceType, current.WorkspaceID).Scan(&membershipExists)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrValidation
	}
	if err != nil {
		return "", err
	}
	departmentID := summaryString(current.BindingInput, "departmentId")
	teamID := summaryString(current.BindingInput, "teamId")
	if departmentID != "" {
		var exists int
		err = tx.QueryRowContext(ctx, `
			SELECT 1 FROM ky_department
			WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3
			  AND status='normal' AND deleted_at IS NULL
		`, departmentID, current.WorkspaceType, current.WorkspaceID).Scan(&exists)
		if errors.Is(err, sql.ErrNoRows) {
			return "", ErrValidation
		}
		if err != nil {
			return "", err
		}
	}
	if teamID != "" {
		var teamDepartmentID sql.NullString
		err = tx.QueryRowContext(ctx, `
			SELECT department_id FROM ky_team
			WHERE id=$1 AND workspace_type=$2 AND workspace_id=$3
			  AND status='normal' AND deleted_at IS NULL
		`, teamID, current.WorkspaceType, current.WorkspaceID).Scan(&teamDepartmentID)
		if errors.Is(err, sql.ErrNoRows) {
			return "", ErrValidation
		}
		if err != nil {
			return "", err
		}
		if departmentID != "" && (!teamDepartmentID.Valid || teamDepartmentID.String != departmentID) {
			return "", ErrValidation
		}
	}

	webSpace, err := getWebSpaceForUpdate(ctx, tx, current.WorkspaceType, current.WorkspaceID, current.MemberID, current.WebSpaceID)
	if err != nil {
		return "", err
	}
	if webSpace.Status == "abandoned" || webSpace.Status == "cleared" {
		return "", ErrValidation
	}
	var verifiedSnapshot int
	err = tx.QueryRowContext(ctx, `
		SELECT 1
		FROM ky_matrix_account_session_snapshot
		WHERE id=$1 AND attempt_id=$2 AND web_space_id=$3 AND member_id=$4 AND device_id=$5
		  AND workspace_type=$6 AND workspace_id=$7 AND platform=$8
		  AND fingerprint_hash=$9 AND content_hash=$10
		  AND status='verified' AND deleted_at IS NULL
		FOR UPDATE
	`, current.SnapshotID, current.ID, current.WebSpaceID, current.MemberID, current.DeviceID,
		current.WorkspaceType, current.WorkspaceID, current.Platform,
		current.SnapshotFingerprintHash, current.SnapshotContentHash).Scan(&verifiedSnapshot)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrValidation
	}
	if err != nil {
		return "", err
	}
	detected := MatrixAccountDetectResultInput{
		IdentityKey:      identityKey,
		PlatformUID:      summaryString(current.AccountCandidate, "platformUid"),
		DisplayName:      summaryString(current.AccountCandidate, "displayName"),
		Nickname:         summaryString(current.AccountCandidate, "nickname"),
		AvatarURL:        summaryString(current.AccountCandidate, "avatarUrl"),
		HomeURL:          summaryString(current.AccountCandidate, "homeUrl"),
		BrowserPartition: webSpace.BrowserPartition,
		DeviceID:         current.DeviceID,
		LoginStatus:      "online",
	}
	displayName := firstNonEmpty(detected.DisplayName, detected.Nickname, detected.PlatformUID, "未命名账号")
	accountID, created, err := upsertDetectedAccount(ctx, tx, current.WorkspaceType, current.WorkspaceID, actorUserID, current.Platform, detected, displayName, "online")
	if err != nil {
		return "", err
	}
	decision := summaryString(current.BindingInput, "decision")
	switch decision {
	case "create_new":
		if !created {
			return "", ErrConflict
		}
	case "attach_existing", "replace_device_session":
		if created {
			return "", ErrConflict
		}
	default:
		return "", ErrValidation
	}
	bindingAccountID := summaryString(current.BindingInput, "accountId")
	if bindingAccountID != "" && bindingAccountID != accountID {
		return "", ErrConflict
	}
	if expectedAccountID != "" && expectedAccountID != accountID {
		return "", ErrConflict
	}
	_, ownerProvided := current.BindingInput["ownerMemberId"]
	_, departmentProvided := current.BindingInput["departmentId"]
	_, teamProvided := current.BindingInput["teamId"]
	_, remarkProvided := current.BindingInput["remark"]
	applyOwner := decision == "create_new" || ownerProvided
	applyDepartment := decision == "create_new" || departmentProvided
	applyTeam := decision == "create_new" || teamProvided
	applyRemark := decision == "create_new" || remarkProvided
	_, err = tx.ExecContext(ctx, `
		UPDATE ky_matrix_account
		SET display_name=$5, platform_uid=$6, nickname=$7, avatar_url=$8, home_url=$9,
		    owner_member_id=CASE WHEN $15 THEN $10 ELSE owner_member_id END,
		    department_id=CASE WHEN $16 THEN NULLIF($11,'') ELSE department_id END,
		    team_id=CASE WHEN $17 THEN NULLIF($12,'') ELSE team_id END,
		    remark=CASE WHEN $18 THEN $13 ELSE remark END,
		    login_status='online', updated_by=$14, updated_at=now()
		WHERE workspace_type=$1 AND workspace_id=$2 AND platform=$3 AND id=$4 AND deleted_at IS NULL
	`, current.WorkspaceType, current.WorkspaceID, current.Platform, accountID, displayName,
		detected.PlatformUID, detected.Nickname, detected.AvatarURL, detected.HomeURL, ownerMemberID,
		departmentID, teamID,
		summaryString(current.BindingInput, "remark"), actorUserID,
		applyOwner, applyDepartment, applyTeam, applyRemark)
	if err := classifyWriteErr(err); err != nil {
		return "", err
	}
	if err := upsertClientSession(ctx, tx, accountID, current.WorkspaceType, current.WorkspaceID, current.MemberID, current.DeviceID, webSpace.BrowserPartition, "online"); err != nil {
		return "", err
	}
	_, err = tx.ExecContext(ctx, `
		UPDATE ky_matrix_account_client_session
		SET fingerprint_hash=$4, active_snapshot_id=$5, updated_at=now()
		WHERE account_id=$1 AND member_id=$2 AND device_id=$3 AND deleted_at IS NULL
	`, accountID, current.MemberID, current.DeviceID, current.SnapshotFingerprintHash, current.SnapshotID)
	if err := classifyWriteErr(err); err != nil {
		return "", err
	}
	_, err = tx.ExecContext(ctx, `
		UPDATE ky_matrix_account_web_space
		SET account_id=$2, status='bound', detected_identity_key=$3, detected_platform_uid=$4,
		    detected_nickname=$5, detected_avatar_url=$6, detected_home_url=$7,
		    detected_at=now(), updated_by=$8, updated_at=now()
		WHERE id=$1 AND deleted_at IS NULL
	`, current.WebSpaceID, accountID, detected.IdentityKey, detected.PlatformUID, detected.Nickname,
		detected.AvatarURL, detected.HomeURL, actorUserID)
	if err := classifyWriteErr(err); err != nil {
		return "", err
	}
	_, err = tx.ExecContext(ctx, `
		UPDATE ky_matrix_account_session_snapshot
		SET account_id=$2, status='active', updated_at=now()
		WHERE id=$1 AND status='verified' AND deleted_at IS NULL
	`, current.SnapshotID, accountID)
	if err := classifyWriteErr(err); err != nil {
		return "", err
	}
	return accountID, nil
}

func persistVerifiedSessionSnapshot(
	ctx context.Context,
	tx *sql.Tx,
	attempt MatrixAccountLoginAttempt,
	actorUserID string,
	summary map[string]any,
) error {
	snapshotID := summaryString(summary, "snapshotId")
	fingerprintHash := summaryString(summary, "fingerprintHash")
	contentHash := summaryString(summary, "contentHash")
	sizeBytes, _ := summaryInt64(summary, "size")
	sourceBytes, _ := summaryInt64(summary, "sourceBytes")
	fileCount, _ := summaryInt64(summary, "fileCount")
	schemaVersion, ok := summaryInt64(summary, "schemaVersion")
	if !ok {
		schemaVersion = 1
	}
	result, err := tx.ExecContext(ctx, `
		INSERT INTO ky_matrix_account_session_snapshot (
		  id, workspace_type, workspace_id, platform, attempt_id, web_space_id,
		  member_id, device_id, status, storage_provider, object_key, schema_version,
		  fingerprint_hash, content_hash, size_bytes, source_bytes, file_count,
		  created_by, verified_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'verified','local_encrypted',$1,$9,$10,$11,$12,$13,$14,$15,now())
		ON CONFLICT (id) DO NOTHING
	`, snapshotID, attempt.WorkspaceType, attempt.WorkspaceID, attempt.Platform, attempt.ID,
		attempt.WebSpaceID, attempt.MemberID, attempt.DeviceID, schemaVersion,
		fingerprintHash, contentHash, sizeBytes, sourceBytes, fileCount, actorUserID)
	if err := classifyWriteErr(err); err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected > 0 {
		return nil
	}
	var existingAttemptID, existingWebSpaceID, existingDeviceID, existingFingerprintHash, existingContentHash string
	err = tx.QueryRowContext(ctx, `
		SELECT attempt_id, web_space_id, device_id, fingerprint_hash, content_hash
		FROM ky_matrix_account_session_snapshot
		WHERE id=$1 AND deleted_at IS NULL
	`, snapshotID).Scan(&existingAttemptID, &existingWebSpaceID, &existingDeviceID, &existingFingerprintHash, &existingContentHash)
	if err != nil {
		return err
	}
	if existingAttemptID != attempt.ID || existingWebSpaceID != attempt.WebSpaceID ||
		existingDeviceID != attempt.DeviceID || existingFingerprintHash != fingerprintHash ||
		existingContentHash != contentHash {
		return ErrConflict
	}
	return nil
}

func applyObservedLoginPhase(transition *loginAttemptTransition, observed string) error {
	transition.EventType = "login.phase.changed"
	transition.CurrentStep = loginStepStatusProbe
	switch observed {
	case "login_page", "qr_ready":
		transition.Phase = "qr_ready"
		transition.Activity = "waiting_user"
		transition.NextActions = []string{"wait", "refresh_qr", "open_controlled_window", "cancel"}
	case "waiting_scan":
		transition.Phase = "waiting_scan"
		transition.Activity = "waiting_user"
		transition.NextActions = []string{"wait", "refresh_qr", "open_controlled_window", "cancel"}
	case "scanned", "confirming":
		transition.Phase = "authenticating"
		transition.Activity = "waiting_user"
		transition.NextActions = []string{"wait", "open_controlled_window", "cancel"}
	case "authenticated":
		transition.Phase = "authenticated"
		transition.Activity = "executing"
		transition.CurrentStep = loginStepAccountIdentity
		transition.EventType = "login.authenticated"
		transition.NextActions = []string{"wait", "cancel"}
	case "verification_required":
		transition.Phase = "verification_required"
		transition.Activity = "waiting_user"
		transition.NextActions = []string{"complete_platform_verification", "open_controlled_window", "cancel"}
	case "risk_controlled":
		transition.Phase = "risk_controlled"
		transition.Activity = "waiting_user"
		transition.NextActions = []string{"open_controlled_window", "cancel"}
	case "qr_expired":
		transition.Phase = "qr_expired"
		transition.Activity = "waiting_user"
		transition.EventType = "qr.expired"
		transition.NextActions = []string{"refresh_qr", "cancel"}
	case "unknown":
		transition.Activity = "waiting_user"
		transition.NextActions = []string{"wait", "open_controlled_window", "cancel"}
	default:
		return ErrValidation
	}
	transition.EventData["observedPhase"] = observed
	return nil
}

func transitionFromAttempt(current MatrixAccountLoginAttempt) loginAttemptTransition {
	return loginAttemptTransition{
		Status:                  current.Status,
		Phase:                   current.Phase,
		Activity:                current.Activity,
		CurrentStep:             current.CurrentStep,
		BlockedMethod:           current.BlockedMethod,
		QRRevision:              current.QRRevision,
		AccountID:               current.AccountID,
		SnapshotID:              current.SnapshotID,
		AccountCandidate:        current.AccountCandidate,
		BindingInput:            current.BindingInput,
		SnapshotFingerprintHash: current.SnapshotFingerprintHash,
		SnapshotContentHash:     current.SnapshotContentHash,
		SnapshotVerified:        current.SnapshotVerified,
		LastErrorCode:           current.LastErrorCode,
		LastErrorMessage:        current.LastErrorMessage,
		EventData:               map[string]any{},
		NextActions:             []string{},
	}
}

func updateLoginAttempt(ctx context.Context, tx *sql.Tx, id string, sequence int64, transition loginAttemptTransition, actorUserID string) error {
	candidate, _ := json.Marshal(nonNilMap(transition.AccountCandidate))
	binding, _ := json.Marshal(nonNilMap(transition.BindingInput))
	res, err := tx.ExecContext(ctx, updateLoginAttemptSQL, id, transition.Status, transition.Phase, transition.Activity, transition.CurrentStep,
		transition.BlockedMethod, transition.QRRevision, transition.AccountID, transition.SnapshotID,
		candidate, binding, transition.SnapshotFingerprintHash, transition.SnapshotContentHash,
		transition.SnapshotVerified, sequence, transition.LastErrorCode, transition.LastErrorMessage, actorUserID)
	if err := classifyWriteErr(err); err != nil {
		return err
	}
	return affectedOrNotFound(res)
}

func insertLoginAttemptEvent(ctx context.Context, tx *sql.Tx, attemptID string, sequence int64, eventType, phase string, recoverable bool, nextActions []string, data map[string]any, actorType, actorID string) (MatrixAccountLoginAttemptEvent, error) {
	nextJSON, _ := json.Marshal(nonNilStrings(nextActions))
	dataJSON, _ := json.Marshal(nonNilMap(data))
	item := MatrixAccountLoginAttemptEvent{
		ID: newID("malae"), AttemptID: attemptID, Sequence: sequence, Type: eventType,
		Phase: phase, Recoverable: recoverable, NextActions: nonNilStrings(nextActions),
		Data: nonNilMap(data), ActorType: actorType,
	}
	err := tx.QueryRowContext(ctx, `
		INSERT INTO ky_matrix_account_login_attempt_event (
		  id, attempt_id, sequence, event_type, phase, recoverable, next_actions, data_json, actor_type, actor_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		RETURNING to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')
	`, item.ID, attemptID, sequence, eventType, phase, recoverable, nextJSON, dataJSON, actorType, actorID).Scan(&item.CreatedAt)
	return item, classifyWriteErr(err)
}

func insertLoginMethodRun(ctx context.Context, tx *sql.Tx, attempt MatrixAccountLoginAttempt, eventSequence int64, actorUserID string, in MatrixAccountLoginStepResultInput) (MatrixAccountLoginMethodRun, error) {
	resultJSON, _ := json.Marshal(nonNilMap(in.ResultSummary))
	item := MatrixAccountLoginMethodRun{
		ID: newID("malmr"), AttemptID: attempt.ID, OperationID: in.OperationID, AttemptNo: in.AttemptNo,
		MethodKey: in.MethodKey, ScriptID: in.ScriptID, ScriptVersionID: in.ScriptVersionID,
		Status: in.Status, ObservedPhase: in.ObservedPhase, ErrorCode: in.ErrorCode,
		ErrorMessage: in.ErrorMessage, DurationMs: in.DurationMs, ResultSummary: nonNilMap(in.ResultSummary),
	}
	err := tx.QueryRowContext(ctx, `
		INSERT INTO ky_matrix_account_login_method_run (
		  id, attempt_id, web_space_id, operation_id, attempt_no, method_key, script_id, script_version_id,
		  status, observed_phase, error_code, error_message, duration_ms, result_summary,
		  event_sequence, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''),NULLIF($8,''),$9,$10,$11,$12,$13,$14,$15,$16)
		RETURNING to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')
	`, item.ID, attempt.ID, attempt.WebSpaceID, in.OperationID, in.AttemptNo, in.MethodKey, in.ScriptID, in.ScriptVersionID,
		in.Status, in.ObservedPhase, in.ErrorCode, in.ErrorMessage, in.DurationMs, resultJSON, eventSequence, actorUserID).Scan(&item.CreatedAt)
	return item, classifyWriteErr(err)
}

func loginAttemptSelectSQL() string {
	return `
		SELECT a.id, a.workspace_type, a.workspace_id, a.platform, a.member_id, a.device_id,
		       a.web_space_id, a.status, a.phase, a.activity, a.current_step, a.blocked_method,
		       a.qr_revision, COALESCE(a.account_id, ''), COALESCE(a.snapshot_id, ''), a.repair_task_id,
		       a.account_candidate, a.binding_input, a.snapshot_fingerprint_hash,
		       a.snapshot_content_hash, a.snapshot_verified, a.sequence,
		       a.last_error_code, a.last_error_message,
		       to_char(a.expires_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(a.completed_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(a.cancelled_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(a.created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(a.updated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')
		FROM ky_matrix_account_login_attempt a
	`
}

func (s *Store) queryLoginAttempt(ctx context.Context, query string, args ...any) (MatrixAccountLoginAttempt, error) {
	return scanLoginAttempt(s.db.QueryRowContext(ctx, query, args...))
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanLoginAttempt(row rowScanner) (MatrixAccountLoginAttempt, error) {
	var item MatrixAccountLoginAttempt
	var candidate, binding []byte
	var completedAt, cancelledAt sql.NullString
	err := row.Scan(
		&item.ID, &item.WorkspaceType, &item.WorkspaceID, &item.Platform, &item.MemberID, &item.DeviceID,
		&item.WebSpaceID, &item.Status, &item.Phase, &item.Activity, &item.CurrentStep, &item.BlockedMethod,
		&item.QRRevision, &item.AccountID, &item.SnapshotID, &item.RepairTaskID, &candidate, &binding,
		&item.SnapshotFingerprintHash, &item.SnapshotContentHash, &item.SnapshotVerified, &item.Sequence,
		&item.LastErrorCode, &item.LastErrorMessage, &item.ExpiresAt, &completedAt, &cancelledAt,
		&item.CreatedAt, &item.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return MatrixAccountLoginAttempt{}, ErrNotFound
	}
	if err != nil {
		return MatrixAccountLoginAttempt{}, err
	}
	item.AccountCandidate = map[string]any{}
	_ = json.Unmarshal(candidate, &item.AccountCandidate)
	item.BindingInput = map[string]any{}
	_ = json.Unmarshal(binding, &item.BindingInput)
	if completedAt.Valid {
		item.CompletedAt = &completedAt.String
	}
	if cancelledAt.Valid {
		item.CancelledAt = &cancelledAt.String
	}
	return item, nil
}

func getLoginAttemptForUpdate(ctx context.Context, tx *sql.Tx, workspaceType, workspaceID, memberID, id string) (MatrixAccountLoginAttempt, error) {
	return scanLoginAttempt(tx.QueryRowContext(ctx, loginAttemptSelectSQL()+`
		WHERE a.workspace_type=$1 AND a.workspace_id=$2 AND a.member_id=$3 AND a.id=$4
		  AND a.deleted_at IS NULL
		FOR UPDATE
	`, workspaceType, workspaceID, memberID, id))
}

func getLoginAttemptCommand(ctx context.Context, tx *sql.Tx, attemptID, commandID string) (MatrixAccountLoginCommand, error) {
	var item MatrixAccountLoginCommand
	var resultJSON []byte
	var completedAt sql.NullString
	err := tx.QueryRowContext(ctx, `
		SELECT id, attempt_id, command_id, command_type, status, result_json,
		       to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(completed_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')
		FROM ky_matrix_account_login_attempt_command
		WHERE attempt_id=$1 AND command_id=$2
	`, attemptID, commandID).Scan(&item.ID, &item.AttemptID, &item.CommandID, &item.CommandType,
		&item.Status, &resultJSON, &item.CreatedAt, &completedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return MatrixAccountLoginCommand{}, ErrNotFound
	}
	if err != nil {
		return MatrixAccountLoginCommand{}, err
	}
	item.Result = map[string]any{}
	_ = json.Unmarshal(resultJSON, &item.Result)
	if completedAt.Valid {
		item.CompletedAt = &completedAt.String
	}
	return item, nil
}

func getLoginMethodRun(ctx context.Context, tx *sql.Tx, attemptID, operationID string, attemptNo int) (MatrixAccountLoginMethodRun, int64, error) {
	var item MatrixAccountLoginMethodRun
	var resultJSON []byte
	var eventSequence int64
	err := tx.QueryRowContext(ctx, `
		SELECT id, attempt_id, operation_id, attempt_no, method_key, COALESCE(script_id,''),
		       COALESCE(script_version_id,''), status, observed_phase, error_code, error_message,
		       duration_ms, result_summary, event_sequence,
		       to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')
		FROM ky_matrix_account_login_method_run
		WHERE attempt_id=$1 AND operation_id=$2 AND attempt_no=$3
	`, attemptID, operationID, attemptNo).Scan(&item.ID, &item.AttemptID, &item.OperationID, &item.AttemptNo, &item.MethodKey,
		&item.ScriptID, &item.ScriptVersionID, &item.Status, &item.ObservedPhase, &item.ErrorCode,
		&item.ErrorMessage, &item.DurationMs, &resultJSON, &eventSequence, &item.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return MatrixAccountLoginMethodRun{}, 0, ErrNotFound
	}
	if err != nil {
		return MatrixAccountLoginMethodRun{}, 0, err
	}
	item.ResultSummary = map[string]any{}
	_ = json.Unmarshal(resultJSON, &item.ResultSummary)
	return item, eventSequence, nil
}

func getLoginAttemptEvent(ctx context.Context, tx *sql.Tx, attemptID string, sequence int64) (MatrixAccountLoginAttemptEvent, error) {
	row := tx.QueryRowContext(ctx, `
		SELECT id, attempt_id, sequence, event_type, phase, recoverable, next_actions, data_json,
		       actor_type, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF')
		FROM ky_matrix_account_login_attempt_event
		WHERE attempt_id=$1 AND sequence=$2
	`, attemptID, sequence)
	return scanLoginAttemptEvent(row)
}

func scanLoginAttemptEvent(row rowScanner) (MatrixAccountLoginAttemptEvent, error) {
	var item MatrixAccountLoginAttemptEvent
	var nextJSON, dataJSON []byte
	err := row.Scan(&item.ID, &item.AttemptID, &item.Sequence, &item.Type, &item.Phase,
		&item.Recoverable, &nextJSON, &dataJSON, &item.ActorType, &item.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return MatrixAccountLoginAttemptEvent{}, ErrNotFound
	}
	if err != nil {
		return MatrixAccountLoginAttemptEvent{}, err
	}
	item.NextActions = []string{}
	item.Data = map[string]any{}
	_ = json.Unmarshal(nextJSON, &item.NextActions)
	_ = json.Unmarshal(dataJSON, &item.Data)
	return item, nil
}

func summaryBool(summary map[string]any, key string) bool {
	value, ok := summary[key].(bool)
	return ok && value
}

func summaryInt(summary map[string]any, key string) (int, bool) {
	value, ok := summary[key]
	if !ok {
		return 0, false
	}
	switch typed := value.(type) {
	case float64:
		return int(typed), typed == float64(int(typed))
	case int:
		return typed, true
	default:
		return 0, false
	}
}

func summaryInt64(summary map[string]any, key string) (int64, bool) {
	value, ok := summary[key]
	if !ok {
		return 0, false
	}
	switch typed := value.(type) {
	case float64:
		return int64(typed), typed == float64(int64(typed))
	case int64:
		return typed, true
	case int:
		return int64(typed), true
	default:
		return 0, false
	}
}

func summaryString(summary map[string]any, key string) string {
	value, _ := summary[key].(string)
	return strings.TrimSpace(value)
}

func cloneSummary(summary map[string]any) map[string]any {
	return mergeSummary(nil, summary)
}

func mergeSummary(base, extra map[string]any) map[string]any {
	result := make(map[string]any, len(base)+len(extra))
	for key, value := range base {
		result[key] = value
	}
	for key, value := range extra {
		result[key] = value
	}
	return result
}

func nonNilMap(value map[string]any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	return value
}

func nonNilStrings(value []string) []string {
	if value == nil {
		return []string{}
	}
	return value
}
