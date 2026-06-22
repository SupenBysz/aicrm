-- KyaiCRM AI provider + model catalog seed.
-- Adapted from zhipinai_v2 zp-ai-model-service model_catalog_contract.go.
-- API keys are intentionally NOT copied (encrypted with a different key); api_key_encrypted stays empty.
-- All reference options are text-reasoning models -> mapped to model_type 'text_generation'.

BEGIN;

INSERT INTO ky_ai_provider (id, name, provider_type, base_url, api_key_encrypted, status, remark, created_by, updated_by)
VALUES ('prov_dashscope', '阿里云百炼（通义千问）', 'dashscope', 'https://dashscope.aliyuncs.com/compatible-mode/v1', '', 'enabled', '通义千问 Qwen 系列', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_01', 'prov_dashscope', 'Qwen3.6 Plus', 'qwen3.6-plus', 'text_generation', 1000000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_02', 'prov_dashscope', 'Qwen3.6 Plus 2026-04-02', 'qwen3.6-plus-2026-04-02', 'text_generation', 1000000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_03', 'prov_dashscope', 'Qwen3.6 Flash', 'qwen3.6-flash', 'text_generation', 1000000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_04', 'prov_dashscope', 'Qwen3.6 Flash 2026-04-16', 'qwen3.6-flash-2026-04-16', 'text_generation', 1000000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_05', 'prov_dashscope', 'Qwen3.6 Max Preview', 'qwen3.6-max-preview', 'text_generation', 256000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_06', 'prov_dashscope', 'Qwen3.6 35B A3B', 'qwen3.6-35b-a3b', 'text_generation', 256000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_07', 'prov_dashscope', 'Qwen3.6 27B', 'qwen3.6-27b', 'text_generation', 256000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_08', 'prov_dashscope', 'Qwen3.5 Plus', 'qwen3.5-plus', 'text_generation', 1000000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_09', 'prov_dashscope', 'Qwen3.5 Plus 2026-04-20', 'qwen3.5-plus-2026-04-20', 'text_generation', 1000000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_10', 'prov_dashscope', 'Qwen3.5 Plus 2026-02-15', 'qwen3.5-plus-2026-02-15', 'text_generation', 1000000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_11', 'prov_dashscope', 'Qwen3.5 Flash', 'qwen3.5-flash', 'text_generation', 1000000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_12', 'prov_dashscope', 'Qwen3.5 Flash 2026-02-23', 'qwen3.5-flash-2026-02-23', 'text_generation', 1000000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_13', 'prov_dashscope', 'Qwen3.5 397B A17B', 'qwen3.5-397b-a17b', 'text_generation', 256000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_14', 'prov_dashscope', 'Qwen3.5 122B A10B', 'qwen3.5-122b-a10b', 'text_generation', 256000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_15', 'prov_dashscope', 'Qwen3.5 27B', 'qwen3.5-27b', 'text_generation', 256000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_16', 'prov_dashscope', 'Qwen3.5 35B A3B', 'qwen3.5-35b-a3b', 'text_generation', 256000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_17', 'prov_dashscope', 'Qwen3 Coder Plus', 'qwen3-coder-plus', 'text_generation', 1000000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_18', 'prov_dashscope', 'Qwen3 Coder Plus 2025-09-23', 'qwen3-coder-plus-2025-09-23', 'text_generation', 1000000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_19', 'prov_dashscope', 'Qwen3 Coder Plus 2025-07-22', 'qwen3-coder-plus-2025-07-22', 'text_generation', 1000000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_20', 'prov_dashscope', 'Qwen3 Coder Flash', 'qwen3-coder-flash', 'text_generation', 1000000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_21', 'prov_dashscope', 'Qwen3 Coder Flash 2025-07-28', 'qwen3-coder-flash-2025-07-28', 'text_generation', 1000000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_dashscope_22', 'prov_dashscope', '通义千问 Plus', 'qwen-plus', 'text_generation', 1000000, '{"maxOutputTokens": 32000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_ai_provider (id, name, provider_type, base_url, api_key_encrypted, status, remark, created_by, updated_by)
VALUES ('prov_deepseek', 'DeepSeek', 'deepseek', 'https://api.deepseek.com', '', 'enabled', 'DeepSeek 官方', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_deepseek_01', 'prov_deepseek', 'DeepSeek V4 Flash', 'deepseek-v4-flash', 'text_generation', 1000000, '{"maxOutputTokens": 384000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_deepseek_02', 'prov_deepseek', 'DeepSeek V4 Pro', 'deepseek-v4-pro', 'text_generation', 1000000, '{"maxOutputTokens": 384000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_ai_provider (id, name, provider_type, base_url, api_key_encrypted, status, remark, created_by, updated_by)
VALUES ('prov_minimax', 'MiniMax', 'minimax', 'https://api.minimax.chat/v1', '', 'enabled', 'MiniMax 海螺', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_minimax_01', 'prov_minimax', 'MiniMax Text 01', 'MiniMax-Text-01', 'text_generation', 1000000, '{"maxOutputTokens": 64000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_minimax_02', 'prov_minimax', 'MiniMax M2.5', 'MiniMax-M2.5', 'text_generation', 196608, '{"maxOutputTokens": 32768}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_minimax_03', 'prov_minimax', 'MiniMax M2.7', 'MiniMax-M2.7', 'text_generation', 196608, '{"maxOutputTokens": 131072}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_ai_provider (id, name, provider_type, base_url, api_key_encrypted, status, remark, created_by, updated_by)
VALUES ('prov_moonshot_kimi', '月之暗面 Kimi', 'moonshot_kimi', 'https://api.moonshot.cn/v1', '', 'enabled', 'Moonshot Kimi', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_moonshot_kimi_01', 'prov_moonshot_kimi', 'Moonshot v1 8K', 'moonshot-v1-8k', 'text_generation', 8192, '{"maxOutputTokens": 8192}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_moonshot_kimi_02', 'prov_moonshot_kimi', 'Kimi K2.5', 'kimi-k2.5', 'text_generation', 262144, '{"maxOutputTokens": 96000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_moonshot_kimi_03', 'prov_moonshot_kimi', 'Kimi K2 Thinking', 'kimi-k2-thinking', 'text_generation', 262144, '{"maxOutputTokens": 96000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_ai_provider (id, name, provider_type, base_url, api_key_encrypted, status, remark, created_by, updated_by)
VALUES ('prov_openai', 'OpenAI', 'openai', 'https://api.openai.com/v1', '', 'enabled', 'OpenAI 官方', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_openai_01', 'prov_openai', 'GPT-4.1 Mini', 'gpt-4.1-mini', 'text_generation', 1047576, '{"maxOutputTokens": 32768}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_ai_provider (id, name, provider_type, base_url, api_key_encrypted, status, remark, created_by, updated_by)
VALUES ('prov_openrouter', 'OpenRouter', 'openrouter', 'https://openrouter.ai/api/v1', '', 'enabled', 'OpenRouter 聚合', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_openrouter_01', 'prov_openrouter', 'Claude Opus 4.7 via OpenRouter', 'anthropic/claude-opus-4.7', 'text_generation', 1000000, '{"maxOutputTokens": 128000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_openrouter_02', 'prov_openrouter', 'Claude Sonnet 4.6 via OpenRouter', 'anthropic/claude-sonnet-4.6', 'text_generation', 1000000, '{"maxOutputTokens": 128000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_openrouter_03', 'prov_openrouter', 'GPT-5.5 via OpenRouter', 'openai/gpt-5.5', 'text_generation', 1050000, '{"maxOutputTokens": 128000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_openrouter_04', 'prov_openrouter', 'GPT-5.4 via OpenRouter', 'openai/gpt-5.4', 'text_generation', 1050000, '{"maxOutputTokens": 128000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_openrouter_05', 'prov_openrouter', 'GPT-5.4 Mini via OpenRouter', 'openai/gpt-5.4-mini', 'text_generation', 400000, '{"maxOutputTokens": 128000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_openrouter_06', 'prov_openrouter', 'GPT-4o Mini via OpenRouter', 'openai/gpt-4o-mini', 'text_generation', 128000, '{"maxOutputTokens": 16384}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_openrouter_07', 'prov_openrouter', 'Gemini 3.1 Pro Preview via OpenRouter', 'google/gemini-3.1-pro-preview', 'text_generation', 1048576, '{"maxOutputTokens": 65536}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_openrouter_08', 'prov_openrouter', 'Gemini 3.1 Flash Lite via OpenRouter', 'google/gemini-3.1-flash-lite', 'text_generation', 1048576, '{"maxOutputTokens": 65536}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_openrouter_09', 'prov_openrouter', 'GLM 5.1 via OpenRouter', 'z-ai/glm-5.1', 'text_generation', 202752, '{"maxOutputTokens": 16384}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_openrouter_10', 'prov_openrouter', 'Kimi K2.5 via OpenRouter', 'moonshotai/kimi-k2.5', 'text_generation', 262144, '{"maxOutputTokens": 262144}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_openrouter_11', 'prov_openrouter', 'MiniMax M2.5 via OpenRouter', 'minimax/minimax-m2.5', 'text_generation', 196608, '{"maxOutputTokens": 196608}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_openrouter_12', 'prov_openrouter', 'MiniMax M2.7 via OpenRouter', 'minimax/minimax-m2.7', 'text_generation', 196608, '{"maxOutputTokens": 131072}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_openrouter_13', 'prov_openrouter', 'Qwen3.6 Plus via OpenRouter', 'qwen/qwen3.6-plus', 'text_generation', 1000000, '{"maxOutputTokens": 65536}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_openrouter_14', 'prov_openrouter', 'Qwen3.6 Flash via OpenRouter', 'qwen/qwen3.6-flash', 'text_generation', 1000000, '{"maxOutputTokens": 65536}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;
INSERT INTO ky_ai_model (id, provider_id, name, model_key, model_type, context_length, default_parameters, status, remark, created_by, updated_by)
VALUES ('mdl_openrouter_15', 'prov_openrouter', 'OpenRouter Auto', 'openrouter/auto', 'text_generation', 1000000, '{"maxOutputTokens": 128000}'::jsonb, 'enabled', '', 'user_platform_owner', 'user_platform_owner')
ON CONFLICT (id) DO NOTHING;

COMMIT;
