package store

import "context"

const (
	platformScopeType = "platform"
	platformScopeID   = "platform_root"
)

// SettingsKeys maps API field names to setting_key values.
var SettingsKeys = map[string]string{
	"defaultChatModelId":      "default_chat_model",
	"defaultSummaryModelId":   "default_summary_model",
	"defaultEmbeddingModelId": "default_embedding_model",
}

// GetDefaultModels returns the three default-model settings (empty if unset).
func (s *Store) GetDefaultModels(ctx context.Context) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT setting_key, COALESCE(model_id,'') FROM ky_ai_model_setting
		WHERE scope_type=$1 AND scope_id=$2
	`, platformScopeType, platformScopeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

// SetDefaultModel upserts a single default-model setting. modelID empty clears it.
func (s *Store) SetDefaultModel(ctx context.Context, settingKey, modelID, updatedBy string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_ai_model_setting (id, scope_type, scope_id, setting_key, model_id, updated_by)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (scope_type, scope_id, setting_key)
		DO UPDATE SET model_id=EXCLUDED.model_id, updated_by=EXCLUDED.updated_by, updated_at=now()
	`, "ams_"+settingKey, platformScopeType, platformScopeID, settingKey, nullStr(modelID), updatedBy)
	return classifyWriteErr(err)
}
