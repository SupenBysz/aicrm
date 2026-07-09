-- Normalize login script lifecycle status after introducing grouped script management.
-- Scripts without an active version are not executable defaults. Keep successful
-- active scripts enabled, keep candidates learning, and mark failed candidates failed.

UPDATE ky_matrix_account_login_script s
SET status='failed',
    active_version_id=NULL,
    last_failure_reason=COALESCE(NULLIF(s.last_failure_reason, ''), 'no_active_version'),
    updated_at=now()
WHERE s.deleted_at IS NULL
  AND s.status='enabled'
  AND s.purpose='account_detect'
  AND NOT EXISTS (
    SELECT 1
    FROM ky_matrix_account_login_script_version v
    WHERE v.script_id=s.id AND v.status='active'
  )
  AND (
    s.failure_count > 0
    OR s.consecutive_failure_count > 0
    OR s.last_failed_at IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM ky_matrix_account_login_script_version v
      WHERE v.script_id=s.id AND v.status='failed'
    )
  );

UPDATE ky_matrix_account_login_script s
SET status='learning',
    active_version_id=NULL,
    updated_at=now()
WHERE s.deleted_at IS NULL
  AND s.status='enabled'
  AND NOT EXISTS (
    SELECT 1
    FROM ky_matrix_account_login_script_version v
    WHERE v.script_id=s.id AND v.status='active'
  )
  AND NOT (
    s.purpose='account_detect'
    AND (
      s.failure_count > 0
      OR s.consecutive_failure_count > 0
      OR s.last_failed_at IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM ky_matrix_account_login_script_version v
        WHERE v.script_id=s.id AND v.status='failed'
      )
    )
  );
