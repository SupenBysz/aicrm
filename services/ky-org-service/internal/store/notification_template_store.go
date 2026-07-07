package store

import (
	"context"
	"database/sql"
	"time"
)

type NotificationTemplate struct {
	TemplateKey      string `json:"templateKey"`
	TemplateName     string `json:"templateName"`
	NotificationType string `json:"notificationType"`
	Title            string `json:"title"`
	Content          string `json:"content"`
	Description      string `json:"description"`
	Enabled          bool   `json:"enabled"`
	UpdatedAt        string `json:"updatedAt,omitempty"`
}

// notificationTemplateDefaults mirrors the built-in seed (016_*.sql) for reset.
var notificationTemplateDefaults = map[string]NotificationTemplate{
	"invitation":           {TemplateName: "成员邀请", NotificationType: "system", Title: "您收到一个加入邀请", Content: "{{inviter}} 邀请您加入 {{workspace}}，请点击链接完成加入。", Description: "向被邀请人发送的邀请通知"},
	"qualification_result": {TemplateName: "资质审核结果", NotificationType: "system", Title: "资质审核结果通知", Content: "您提交的资质「{{qualificationType}}」审核结果为：{{result}}。{{remark}}", Description: "资质审核通过/驳回时通知提交方"},
	"announcement":         {TemplateName: "平台公告", NotificationType: "system", Title: "{{title}}", Content: "{{content}}", Description: "公告发布后桥接为成员通知时套用"},
	"member_status":        {TemplateName: "成员状态变更", NotificationType: "system", Title: "账号状态变更通知", Content: "您在 {{workspace}} 的成员状态已变更为：{{status}}。", Description: "成员被停用/启用时通知本人"},
}

const ntColumns = `template_key, template_name, notification_type, title, content, description, enabled, updated_at`

func scanNotificationTemplate(row interface{ Scan(...any) error }) (NotificationTemplate, error) {
	var t NotificationTemplate
	var updatedAt sql.NullTime
	err := row.Scan(&t.TemplateKey, &t.TemplateName, &t.NotificationType, &t.Title, &t.Content, &t.Description, &t.Enabled, &updatedAt)
	if updatedAt.Valid {
		t.UpdatedAt = updatedAt.Time.Format(time.RFC3339)
	}
	return t, err
}

func (s *Store) ListNotificationTemplates(ctx context.Context) ([]NotificationTemplate, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+ntColumns+` FROM ky_notification_template ORDER BY template_key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []NotificationTemplate{}
	for rows.Next() {
		t, err := scanNotificationTemplate(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, t)
	}
	return items, rows.Err()
}

func (s *Store) GetNotificationTemplate(ctx context.Context, key string) (NotificationTemplate, error) {
	t, err := scanNotificationTemplate(s.db.QueryRowContext(ctx, `SELECT `+ntColumns+` FROM ky_notification_template WHERE template_key=$1`, key))
	if err == sql.ErrNoRows {
		return NotificationTemplate{}, ErrNotFound
	}
	return t, err
}

func (s *Store) UpdateNotificationTemplate(ctx context.Context, key, name, title, content, description, updatedBy string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_notification_template
		SET template_name=$2, title=$3, content=$4, description=$5, updated_by=$6, updated_at=now()
		WHERE template_key=$1
	`, key, name, title, content, description, nullStr(updatedBy))
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) UpdateNotificationTemplateStatus(ctx context.Context, key string, enabled bool, updatedBy string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE ky_notification_template SET enabled=$2, updated_by=$3, updated_at=now() WHERE template_key=$1`, key, enabled, nullStr(updatedBy))
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ResetNotificationTemplate restores a template to its built-in default content.
func (s *Store) ResetNotificationTemplate(ctx context.Context, key, updatedBy string) error {
	def, ok := notificationTemplateDefaults[key]
	if !ok {
		return ErrNotFound
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE ky_notification_template
		SET template_name=$2, title=$3, content=$4, description=$5, enabled=true, updated_by=$6, updated_at=now()
		WHERE template_key=$1
	`, key, def.TemplateName, def.Title, def.Content, def.Description, nullStr(updatedBy))
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
