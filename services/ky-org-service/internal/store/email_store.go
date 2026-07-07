package store

import (
	"context"
	"database/sql"
	"time"
)

type EmailAccount struct {
	ID              string `json:"id"`
	AccountName     string `json:"accountName"`
	ProviderKey     string `json:"providerKey"`
	Host            string `json:"host"`
	Port            int    `json:"port"`
	Encryption      string `json:"encryption"`
	Username        string `json:"username"`
	HasPassword     bool   `json:"hasPassword"`
	FromEmail       string `json:"fromEmail"`
	FromName        string `json:"fromName"`
	ReplyToEmail    string `json:"replyToEmail"`
	Status          string `json:"status"`
	Remark          string `json:"remark"`
	LastTestStatus  string `json:"lastTestStatus"`
	LastTestMessage string `json:"lastTestMessage,omitempty"`
	UpdatedAt       string `json:"updatedAt,omitempty"`

	PasswordEncrypted string `json:"-"`
}

type EmailIdentity struct {
	ID           string `json:"id"`
	AccountID    string `json:"accountId"`
	IdentityName string `json:"identityName"`
	FromEmail    string `json:"fromEmail"`
	FromName     string `json:"fromName"`
	ReplyToEmail string `json:"replyToEmail"`
	Status       string `json:"status"`
	Remark       string `json:"remark"`
}

type EmailTemplate struct {
	ID              string `json:"id"`
	AccountID       string `json:"accountId"`
	IdentityID      string `json:"identityId"`
	Scene           string `json:"scene"`
	Subject         string `json:"subject"`
	Body            string `json:"body"`
	CodeVariable    string `json:"codeVariable"`
	CodeTTLSeconds  int    `json:"codeTtlSeconds"`
	DailyLimit      int    `json:"dailyLimit"`
	IntervalSeconds int    `json:"intervalSeconds"`
	Status          string `json:"status"`
	Remark          string `json:"remark"`
	LastTestStatus  string `json:"lastTestStatus"`
	LastTestMessage string `json:"lastTestMessage,omitempty"`
}

// --- accounts ---

func (s *Store) ListEmailAccounts(ctx context.Context) ([]EmailAccount, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, account_name, provider_key, host, port, encryption, username, password_encrypted,
		       from_email, from_name, reply_to_email, status, remark, last_test_status, last_test_message, updated_at
		FROM ky_email_account ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []EmailAccount{}
	for rows.Next() {
		a, err := scanEmailAccount(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, a)
	}
	return items, rows.Err()
}

func (s *Store) GetEmailAccount(ctx context.Context, id string) (EmailAccount, error) {
	a, err := scanEmailAccount(s.db.QueryRowContext(ctx, `
		SELECT id, account_name, provider_key, host, port, encryption, username, password_encrypted,
		       from_email, from_name, reply_to_email, status, remark, last_test_status, last_test_message, updated_at
		FROM ky_email_account WHERE id=$1`, id))
	if err == sql.ErrNoRows {
		return EmailAccount{}, ErrNotFound
	}
	return a, err
}

func scanEmailAccount(row interface{ Scan(...any) error }) (EmailAccount, error) {
	var a EmailAccount
	var updatedAt sql.NullTime
	err := row.Scan(&a.ID, &a.AccountName, &a.ProviderKey, &a.Host, &a.Port, &a.Encryption, &a.Username, &a.PasswordEncrypted,
		&a.FromEmail, &a.FromName, &a.ReplyToEmail, &a.Status, &a.Remark, &a.LastTestStatus, &a.LastTestMessage, &updatedAt)
	if err != nil {
		return EmailAccount{}, err
	}
	a.HasPassword = a.PasswordEncrypted != ""
	if updatedAt.Valid {
		a.UpdatedAt = updatedAt.Time.Format(time.RFC3339)
	}
	return a, nil
}

func (s *Store) CreateEmailAccount(ctx context.Context, a EmailAccount, pwdEnc, createdBy string) (string, error) {
	id := "emailacc_" + randomSuffix()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_email_account (id, account_name, provider_key, host, port, encryption, username, password_encrypted,
			from_email, from_name, reply_to_email, status, remark, updated_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
		id, a.AccountName, a.ProviderKey, a.Host, a.Port, a.Encryption, a.Username, pwdEnc,
		a.FromEmail, a.FromName, a.ReplyToEmail, a.Status, a.Remark, nullStr(createdBy))
	if err != nil {
		return "", classifyWriteErr(err)
	}
	return id, nil
}

func (s *Store) UpdateEmailAccount(ctx context.Context, a EmailAccount, pwdEnc, updatedBy string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_email_account SET account_name=$2, provider_key=$3, host=$4, port=$5, encryption=$6, username=$7,
			password_encrypted=COALESCE(NULLIF($8,''), password_encrypted),
			from_email=$9, from_name=$10, reply_to_email=$11, status=$12, remark=$13, updated_by=$14, updated_at=now()
		WHERE id=$1`,
		a.ID, a.AccountName, a.ProviderKey, a.Host, a.Port, a.Encryption, a.Username, pwdEnc,
		a.FromEmail, a.FromName, a.ReplyToEmail, a.Status, a.Remark, nullStr(updatedBy))
	if err != nil {
		return classifyWriteErr(err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteEmailAccount(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM ky_email_account WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) RecordEmailAccountTest(ctx context.Context, id, status, message string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE ky_email_account SET last_test_at=now(), last_test_status=$2, last_test_message=$3 WHERE id=$1`, id, status, message)
	return err
}

// --- identities ---

func (s *Store) ListEmailIdentities(ctx context.Context) ([]EmailIdentity, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, account_id, identity_name, from_email, from_name, reply_to_email, status, remark FROM ky_email_identity ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []EmailIdentity{}
	for rows.Next() {
		var i EmailIdentity
		if err := rows.Scan(&i.ID, &i.AccountID, &i.IdentityName, &i.FromEmail, &i.FromName, &i.ReplyToEmail, &i.Status, &i.Remark); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

func (s *Store) CreateEmailIdentity(ctx context.Context, i EmailIdentity, createdBy string) (string, error) {
	id := "emailid_" + randomSuffix()
	_, err := s.db.ExecContext(ctx, `INSERT INTO ky_email_identity (id, account_id, identity_name, from_email, from_name, reply_to_email, status, remark, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		id, i.AccountID, i.IdentityName, i.FromEmail, i.FromName, i.ReplyToEmail, i.Status, i.Remark, nullStr(createdBy))
	if err != nil {
		return "", classifyWriteErr(err)
	}
	return id, nil
}

func (s *Store) UpdateEmailIdentity(ctx context.Context, i EmailIdentity, updatedBy string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE ky_email_identity SET identity_name=$2, from_email=$3, from_name=$4, reply_to_email=$5, status=$6, remark=$7, updated_by=$8, updated_at=now() WHERE id=$1`,
		i.ID, i.IdentityName, i.FromEmail, i.FromName, i.ReplyToEmail, i.Status, i.Remark, nullStr(updatedBy))
	if err != nil {
		return classifyWriteErr(err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteEmailIdentity(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM ky_email_identity WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// --- templates ---

func (s *Store) ListEmailTemplates(ctx context.Context) ([]EmailTemplate, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, account_id, COALESCE(identity_id,''), scene, subject, body, code_variable, code_ttl_seconds,
		       daily_limit, interval_seconds, status, remark, last_test_status, last_test_message
		FROM ky_email_template ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []EmailTemplate{}
	for rows.Next() {
		t, err := scanEmailTemplate(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, t)
	}
	return items, rows.Err()
}

func (s *Store) GetEmailTemplate(ctx context.Context, id string) (EmailTemplate, error) {
	t, err := scanEmailTemplate(s.db.QueryRowContext(ctx, `
		SELECT id, account_id, COALESCE(identity_id,''), scene, subject, body, code_variable, code_ttl_seconds,
		       daily_limit, interval_seconds, status, remark, last_test_status, last_test_message
		FROM ky_email_template WHERE id=$1`, id))
	if err == sql.ErrNoRows {
		return EmailTemplate{}, ErrNotFound
	}
	return t, err
}

func scanEmailTemplate(row interface{ Scan(...any) error }) (EmailTemplate, error) {
	var t EmailTemplate
	err := row.Scan(&t.ID, &t.AccountID, &t.IdentityID, &t.Scene, &t.Subject, &t.Body, &t.CodeVariable,
		&t.CodeTTLSeconds, &t.DailyLimit, &t.IntervalSeconds, &t.Status, &t.Remark, &t.LastTestStatus, &t.LastTestMessage)
	return t, err
}

func (s *Store) CreateEmailTemplate(ctx context.Context, t EmailTemplate, createdBy string) (string, error) {
	id := "emailtpl_" + randomSuffix()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_email_template (id, account_id, identity_id, scene, subject, body, code_variable, code_ttl_seconds, daily_limit, interval_seconds, status, remark, updated_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
		id, t.AccountID, nullStr(t.IdentityID), t.Scene, t.Subject, t.Body, t.CodeVariable, t.CodeTTLSeconds, t.DailyLimit, t.IntervalSeconds, t.Status, t.Remark, nullStr(createdBy))
	if err != nil {
		return "", classifyWriteErr(err)
	}
	return id, nil
}

func (s *Store) UpdateEmailTemplate(ctx context.Context, t EmailTemplate, updatedBy string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_email_template SET identity_id=$2, scene=$3, subject=$4, body=$5, code_variable=$6, code_ttl_seconds=$7,
			daily_limit=$8, interval_seconds=$9, status=$10, remark=$11, updated_by=$12, updated_at=now()
		WHERE id=$1`,
		t.ID, nullStr(t.IdentityID), t.Scene, t.Subject, t.Body, t.CodeVariable, t.CodeTTLSeconds, t.DailyLimit, t.IntervalSeconds, t.Status, t.Remark, nullStr(updatedBy))
	if err != nil {
		return classifyWriteErr(err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteEmailTemplate(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM ky_email_template WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) RecordEmailTemplateTest(ctx context.Context, id, status, message string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE ky_email_template SET last_test_at=now(), last_test_status=$2, last_test_message=$3 WHERE id=$1`, id, status, message)
	return err
}
