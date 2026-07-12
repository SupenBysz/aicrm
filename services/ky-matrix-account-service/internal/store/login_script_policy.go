package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
)

const (
	legacyDouyinAccountDetectVersionID = "malsv_643d906e3d4d52c6f30e31258e29a062"
	legacyDouyinAccountDetectDSLHash   = "808c429273b69c2b4362516b62ca93556a0829154deb51c5b39d67239b819867"
	legacyDouyinAccountDetectExpires   = "2026-07-31T23:59:59+08:00"
)

type executableLoginScriptDSL struct {
	Version int                         `json:"version"`
	Purpose string                      `json:"purpose"`
	Steps   []executableLoginScriptStep `json:"steps"`
}

type executableLoginScriptStep struct {
	Action string `json:"action"`
}

func validateExecutableLoginScriptDSL(raw json.RawMessage, expectedPurpose string) error {
	var dsl executableLoginScriptDSL
	if err := json.Unmarshal(raw, &dsl); err != nil {
		return ErrValidation
	}
	if dsl.Version != 1 || dsl.Purpose != expectedPurpose || len(dsl.Steps) == 0 || len(dsl.Steps) > 40 {
		return ErrValidation
	}
	for _, step := range dsl.Steps {
		if !validExecutableLoginScriptAction(step.Action) {
			return ErrValidation
		}
	}
	return nil
}

func validExecutableLoginScriptAction(action string) bool {
	switch action {
	case "clickText", "clickSelector", "wait", "waitForElement", "captureElement", "readText", "navigateAllowedUrl":
		return true
	default:
		return false
	}
}

func validateLoginScriptRunPromotion(
	ctx context.Context,
	tx *sql.Tx,
	workspaceType, workspaceID, scriptID, requestedVersionID, reportedPurpose string,
) error {
	var scriptPurpose, scriptStatus, activeVersionID, targetVersionID, targetVersionStatus string
	var dsl json.RawMessage
	err := tx.QueryRowContext(ctx, `
		SELECT s.purpose,
		       s.status,
		       COALESCE(s.active_version_id, ''),
		       COALESCE(v.id, ''),
		       COALESCE(v.status, ''),
		       COALESCE(v.dsl_json, '{}'::jsonb)
		FROM ky_matrix_account_login_script s
		LEFT JOIN ky_matrix_account_login_script_version v
		  ON v.script_id=s.id
		 AND v.id=COALESCE(NULLIF($4, ''), s.active_version_id)
		WHERE s.workspace_type=$1 AND s.workspace_id=$2 AND s.id=$3 AND s.deleted_at IS NULL
		FOR UPDATE OF s
	`, workspaceType, workspaceID, scriptID, requestedVersionID).Scan(
		&scriptPurpose,
		&scriptStatus,
		&activeVersionID,
		&targetVersionID,
		&targetVersionStatus,
		&dsl,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if scriptPurpose != reportedPurpose {
		return ErrValidation
	}
	if targetVersionID == "" {
		if requestedVersionID != "" {
			return ErrValidation
		}
		return nil
	}
	alreadyActive := scriptStatus == "enabled" && activeVersionID == targetVersionID && targetVersionStatus == "active"
	if alreadyActive && scriptPurpose == "account_detect" && isExactLegacyCredentialAdapter(targetVersionID, dsl, time.Now()) {
		return nil
	}
	return validateExecutableLoginScriptDSL(dsl, scriptPurpose)
}

// The legacy payload may remain executable only while it is already the
// active version. New writes and explicit activation always use the strict
// validator above. The Desktop substitutes this payload and never executes its
// original steps.
func isExactLegacyCredentialAdapter(versionID string, raw json.RawMessage, now time.Time) bool {
	if versionID != legacyDouyinAccountDetectVersionID {
		return false
	}
	expiresAt, err := time.Parse(time.RFC3339, legacyDouyinAccountDetectExpires)
	if err != nil || now.After(expiresAt) {
		return false
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return false
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		return false
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]) == legacyDouyinAccountDetectDSLHash
}
