package store

import (
	"context"
	"database/sql"
	"time"
)

type SMSAccount struct {
	ID                 string `json:"id"`
	AccountName        string `json:"accountName"`
	ProviderKey        string `json:"providerKey"`
	Region             string `json:"region"`
	AccessKeyID        string `json:"accessKeyId"`
	HasSecret          bool   `json:"hasSecret"`
	DefaultSignatureID string `json:"defaultSignatureId"`
	Status             string `json:"status"`
	Remark             string `json:"remark"`
	LastTestAt         string `json:"lastTestAt,omitempty"`
	LastTestStatus     string `json:"lastTestStatus"`
	LastTestMessage    string `json:"lastTestMessage,omitempty"`
	UpdatedAt          string `json:"updatedAt,omitempty"`

	SecretEncrypted string `json:"-"`
}

type SMSSignature struct {
	ID            string `json:"id"`
	AccountID     string `json:"accountId"`
	SignatureName string `json:"signatureName"`
	Status        string `json:"status"`
	Remark        string `json:"remark"`
	UpdatedAt     string `json:"updatedAt,omitempty"`
}

type SMSTemplate struct {
	ID              string `json:"id"`
	AccountID       string `json:"accountId"`
	Scene           string `json:"scene"`
	TemplateCode    string `json:"templateCode"`
	CodeVariable    string `json:"codeVariable"`
	CodeTTLSeconds  int    `json:"codeTtlSeconds"`
	DailyLimit      int    `json:"dailyLimit"`
	IntervalSeconds int    `json:"intervalSeconds"`
	Status          string `json:"status"`
	Remark          string `json:"remark"`
	LastTestStatus  string `json:"lastTestStatus"`
	LastTestMessage string `json:"lastTestMessage,omitempty"`
	UpdatedAt       string `json:"updatedAt,omitempty"`
}

// --- accounts ---

func (s *Store) ListSMSAccounts(ctx context.Context) ([]SMSAccount, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, account_name, provider_key, region, access_key_id, access_key_secret_encrypted,
		       COALESCE(default_signature_id,''), status, remark, last_test_status, last_test_message, last_test_at, updated_at
		FROM ky_sms_account ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []SMSAccount{}
	for rows.Next() {
		var a SMSAccount
		var lastTestAt, updatedAt sql.NullTime
		if err := rows.Scan(&a.ID, &a.AccountName, &a.ProviderKey, &a.Region, &a.AccessKeyID, &a.SecretEncrypted,
			&a.DefaultSignatureID, &a.Status, &a.Remark, &a.LastTestStatus, &a.LastTestMessage, &lastTestAt, &updatedAt); err != nil {
			return nil, err
		}
		a.HasSecret = a.SecretEncrypted != ""
		if lastTestAt.Valid {
			a.LastTestAt = lastTestAt.Time.Format(time.RFC3339)
		}
		if updatedAt.Valid {
			a.UpdatedAt = updatedAt.Time.Format(time.RFC3339)
		}
		items = append(items, a)
	}
	return items, rows.Err()
}

func (s *Store) GetSMSAccount(ctx context.Context, id string) (SMSAccount, error) {
	var a SMSAccount
	var lastTestAt, updatedAt sql.NullTime
	err := s.db.QueryRowContext(ctx, `
		SELECT id, account_name, provider_key, region, access_key_id, access_key_secret_encrypted,
		       COALESCE(default_signature_id,''), status, remark, last_test_status, last_test_message, last_test_at, updated_at
		FROM ky_sms_account WHERE id=$1`, id).Scan(
		&a.ID, &a.AccountName, &a.ProviderKey, &a.Region, &a.AccessKeyID, &a.SecretEncrypted,
		&a.DefaultSignatureID, &a.Status, &a.Remark, &a.LastTestStatus, &a.LastTestMessage, &lastTestAt, &updatedAt)
	if err == sql.ErrNoRows {
		return SMSAccount{}, ErrNotFound
	}
	if err != nil {
		return SMSAccount{}, err
	}
	a.HasSecret = a.SecretEncrypted != ""
	if lastTestAt.Valid {
		a.LastTestAt = lastTestAt.Time.Format(time.RFC3339)
	}
	if updatedAt.Valid {
		a.UpdatedAt = updatedAt.Time.Format(time.RFC3339)
	}
	return a, nil
}

func (s *Store) CreateSMSAccount(ctx context.Context, a SMSAccount, secretEnc, createdBy string) (string, error) {
	id := "smsacc_" + randomSuffix()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_sms_account (id, account_name, provider_key, region, access_key_id, access_key_secret_encrypted, default_signature_id, status, remark, updated_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		id, a.AccountName, a.ProviderKey, a.Region, a.AccessKeyID, secretEnc, nullStr(a.DefaultSignatureID), a.Status, a.Remark, nullStr(createdBy))
	if err != nil {
		return "", classifyWriteErr(err)
	}
	return id, nil
}

func (s *Store) UpdateSMSAccount(ctx context.Context, a SMSAccount, secretEnc, updatedBy string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_sms_account SET account_name=$2, provider_key=$3, region=$4, access_key_id=$5,
			access_key_secret_encrypted=COALESCE(NULLIF($6,''), access_key_secret_encrypted),
			default_signature_id=$7, status=$8, remark=$9, updated_by=$10, updated_at=now()
		WHERE id=$1`,
		a.ID, a.AccountName, a.ProviderKey, a.Region, a.AccessKeyID, secretEnc, nullStr(a.DefaultSignatureID), a.Status, a.Remark, nullStr(updatedBy))
	if err != nil {
		return classifyWriteErr(err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteSMSAccount(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM ky_sms_account WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) RecordSMSAccountTest(ctx context.Context, id, status, message string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE ky_sms_account SET last_test_at=now(), last_test_status=$2, last_test_message=$3 WHERE id=$1`, id, status, message)
	return err
}

// --- signatures ---

func (s *Store) ListSMSSignatures(ctx context.Context) ([]SMSSignature, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, account_id, signature_name, status, remark, updated_at FROM ky_sms_signature ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []SMSSignature{}
	for rows.Next() {
		var sig SMSSignature
		var updatedAt sql.NullTime
		if err := rows.Scan(&sig.ID, &sig.AccountID, &sig.SignatureName, &sig.Status, &sig.Remark, &updatedAt); err != nil {
			return nil, err
		}
		if updatedAt.Valid {
			sig.UpdatedAt = updatedAt.Time.Format(time.RFC3339)
		}
		items = append(items, sig)
	}
	return items, rows.Err()
}

func (s *Store) CreateSMSSignature(ctx context.Context, sig SMSSignature, createdBy string) (string, error) {
	id := "smssig_" + randomSuffix()
	_, err := s.db.ExecContext(ctx, `INSERT INTO ky_sms_signature (id, account_id, signature_name, status, remark, updated_by) VALUES ($1,$2,$3,$4,$5,$6)`,
		id, sig.AccountID, sig.SignatureName, sig.Status, sig.Remark, nullStr(createdBy))
	if err != nil {
		return "", classifyWriteErr(err)
	}
	return id, nil
}

func (s *Store) UpdateSMSSignature(ctx context.Context, sig SMSSignature, updatedBy string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE ky_sms_signature SET signature_name=$2, status=$3, remark=$4, updated_by=$5, updated_at=now() WHERE id=$1`,
		sig.ID, sig.SignatureName, sig.Status, sig.Remark, nullStr(updatedBy))
	if err != nil {
		return classifyWriteErr(err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteSMSSignature(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM ky_sms_signature WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// --- scene templates ---

func (s *Store) ListSMSTemplates(ctx context.Context) ([]SMSTemplate, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, account_id, scene, template_code, code_variable, code_ttl_seconds, daily_limit, interval_seconds,
		       status, remark, last_test_status, last_test_message FROM ky_sms_template ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []SMSTemplate{}
	for rows.Next() {
		var t SMSTemplate
		if err := rows.Scan(&t.ID, &t.AccountID, &t.Scene, &t.TemplateCode, &t.CodeVariable, &t.CodeTTLSeconds,
			&t.DailyLimit, &t.IntervalSeconds, &t.Status, &t.Remark, &t.LastTestStatus, &t.LastTestMessage); err != nil {
			return nil, err
		}
		items = append(items, t)
	}
	return items, rows.Err()
}

func (s *Store) GetSMSTemplate(ctx context.Context, id string) (SMSTemplate, error) {
	var t SMSTemplate
	err := s.db.QueryRowContext(ctx, `
		SELECT id, account_id, scene, template_code, code_variable, code_ttl_seconds, daily_limit, interval_seconds,
		       status, remark, last_test_status, last_test_message FROM ky_sms_template WHERE id=$1`, id).Scan(
		&t.ID, &t.AccountID, &t.Scene, &t.TemplateCode, &t.CodeVariable, &t.CodeTTLSeconds,
		&t.DailyLimit, &t.IntervalSeconds, &t.Status, &t.Remark, &t.LastTestStatus, &t.LastTestMessage)
	if err == sql.ErrNoRows {
		return SMSTemplate{}, ErrNotFound
	}
	return t, err
}

func (s *Store) CreateSMSTemplate(ctx context.Context, t SMSTemplate, createdBy string) (string, error) {
	id := "smstpl_" + randomSuffix()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_sms_template (id, account_id, scene, template_code, code_variable, code_ttl_seconds, daily_limit, interval_seconds, status, remark, updated_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		id, t.AccountID, t.Scene, t.TemplateCode, t.CodeVariable, t.CodeTTLSeconds, t.DailyLimit, t.IntervalSeconds, t.Status, t.Remark, nullStr(createdBy))
	if err != nil {
		return "", classifyWriteErr(err)
	}
	return id, nil
}

func (s *Store) UpdateSMSTemplate(ctx context.Context, t SMSTemplate, updatedBy string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_sms_template SET scene=$2, template_code=$3, code_variable=$4, code_ttl_seconds=$5,
			daily_limit=$6, interval_seconds=$7, status=$8, remark=$9, updated_by=$10, updated_at=now()
		WHERE id=$1`,
		t.ID, t.Scene, t.TemplateCode, t.CodeVariable, t.CodeTTLSeconds, t.DailyLimit, t.IntervalSeconds, t.Status, t.Remark, nullStr(updatedBy))
	if err != nil {
		return classifyWriteErr(err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteSMSTemplate(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM ky_sms_template WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) RecordSMSTemplateTest(ctx context.Context, id, status, message string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE ky_sms_template SET last_test_at=now(), last_test_status=$2, last_test_message=$3 WHERE id=$1`, id, status, message)
	return err
}
