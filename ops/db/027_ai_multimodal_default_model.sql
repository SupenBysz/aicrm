-- AI model defaults: add default multimodal model for AI-assisted browser scripting.

ALTER TABLE ky_ai_model_setting
  DROP CONSTRAINT IF EXISTS ky_ai_model_setting_setting_key_check;

ALTER TABLE ky_ai_model_setting
  ADD CONSTRAINT ky_ai_model_setting_setting_key_check
  CHECK (setting_key IN (
    'default_chat_model',
    'default_summary_model',
    'default_embedding_model',
    'default_multimodal_model'
  ));
