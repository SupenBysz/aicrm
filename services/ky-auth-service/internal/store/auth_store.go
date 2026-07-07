package store

import (
	"context"
	"time"

	sessionpkg "github.com/Kysion/KyaiCRM/shared/session"
)

func (s *Store) CreateCredential(ctx context.Context, id string, userID string, identifier string, passwordHash string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_user_credential (id, user_id, credential_type, identifier, password_hash, status, verified_at)
		VALUES ($1, $2, 'password', $3, $4, 'normal', now())
	`, id, userID, identifier, passwordHash)
	return err
}

func (s *Store) FindPasswordCredential(ctx context.Context, account string) (Credential, error) {
	var credential Credential
	err := s.db.QueryRowContext(ctx, `
		SELECT c.id, c.user_id, c.password_hash, c.status,
		       u.id, COALESCE(u.username, ''), u.display_name, u.avatar_url, COALESCE(u.phone, ''), COALESCE(u.email, ''), u.status
		FROM ky_user_credential c
		JOIN ky_user u ON u.id = c.user_id
		WHERE c.credential_type = 'password'
		  AND c.identifier = $1
		  AND u.deleted_at IS NULL
	`, account).Scan(
		&credential.ID,
		&credential.UserID,
		&credential.PasswordHash,
		&credential.Status,
		&credential.User.ID,
		&credential.User.Username,
		&credential.User.DisplayName,
		&credential.User.AvatarURL,
		&credential.User.Phone,
		&credential.User.Email,
		&credential.User.Status,
	)
	return credential, err
}

func (s *Store) FindPasswordCredentialByUserID(ctx context.Context, userID string) (Credential, error) {
	var credential Credential
	err := s.db.QueryRowContext(ctx, `
		SELECT c.id, c.user_id, COALESCE(c.password_hash, ''), c.status,
		       u.id, COALESCE(u.username, ''), u.display_name, u.avatar_url, COALESCE(u.phone, ''), COALESCE(u.email, ''), u.status
		FROM ky_user_credential c
		JOIN ky_user u ON u.id = c.user_id
		WHERE c.credential_type = 'password'
		  AND c.user_id = $1
		  AND u.deleted_at IS NULL
		ORDER BY c.verified_at DESC NULLS LAST, c.created_at DESC
		LIMIT 1
	`, userID).Scan(
		&credential.ID,
		&credential.UserID,
		&credential.PasswordHash,
		&credential.Status,
		&credential.User.ID,
		&credential.User.Username,
		&credential.User.DisplayName,
		&credential.User.AvatarURL,
		&credential.User.Phone,
		&credential.User.Email,
		&credential.User.Status,
	)
	return credential, err
}

func (s *Store) CreateSession(ctx context.Context, session Session) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_user_session (id, user_id, token_id, user_agent, ip_address, status, expires_at)
		VALUES ($1, $2, $3, $4, $5, 'active', $6)
	`, session.ID, session.UserID, session.TokenID, session.UserAgent, session.IPAddress, session.ExpiresAt)
	return err
}

func (s *Store) RevokeSession(ctx context.Context, sessionID string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE ky_user_session SET status = 'revoked', updated_at = now() WHERE id = $1
	`, sessionID)
	return err
}

// IsSessionActive delegates to shared/session (single source of truth, Phase 1.17).
func (s *Store) IsSessionActive(ctx context.Context, sessionID string, now time.Time) (bool, error) {
	return sessionpkg.Active(ctx, s.db, sessionID, now)
}

func (s *Store) WriteLoginLog(ctx context.Context, id string, userID *string, account string, result string, failReason string, ip string, userAgent string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_login_log (id, user_id, login_account, result, fail_reason, ip_address, user_agent)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, id, userID, account, result, failReason, ip, userAgent)
	return err
}
