-- Appearance has separate ownership: Auth owns user preference; Org owns platform default.
CREATE TABLE IF NOT EXISTS ky_user_appearance (
 user_id text PRIMARY KEY REFERENCES ky_user(id),
 schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version=1),
 source text NOT NULL CHECK(source IN ('personal','platform')),
 theme_id text NOT NULL DEFAULT '', mode text NOT NULL DEFAULT '',
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((source='platform' AND theme_id='' AND mode='') OR
 (source='personal' AND theme_id IN ('classic-gold','business-blue','jade-green') AND mode IN ('light','dark','system')))
);
CREATE TABLE IF NOT EXISTS ky_platform_appearance (
 id text PRIMARY KEY CHECK(id='default'),
 schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version=1),
 source text NOT NULL DEFAULT 'platform' CHECK(source='platform'),
 theme_id text NOT NULL DEFAULT 'classic-gold' CHECK(theme_id IN ('classic-gold','business-blue','jade-green')),
 mode text NOT NULL DEFAULT 'system' CHECK(mode IN ('light','dark','system')),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ky_platform_appearance(id) VALUES('default') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ky_platform_appearance_change (
 id bigserial PRIMARY KEY, revision bigint NOT NULL UNIQUE,
 actor_id text NOT NULL, request_id text NOT NULL,
 before_value jsonb NOT NULL, after_value jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ky_permission(id,code,name,category,resource,action,workspace_types,description,status) VALUES
 ('perm_platform_appearance_view','platform.appearance.view','外观主题查看','page','appearance','view','["platform"]'::jsonb,'查看平台默认外观主题','normal'),
 ('perm_platform_appearance_update','platform.appearance.update','外观主题修改','action','appearance','update','["platform"]'::jsonb,'设置平台默认外观主题','normal')
ON CONFLICT(code) DO NOTHING;
INSERT INTO ky_role_permission(id,role_id,permission_id)
SELECT 'rp_'||r.id||'_'||p.id,r.id,p.id FROM ky_role r CROSS JOIN ky_permission p
WHERE r.id IN ('role_platform_owner','role_platform_admin') AND r.code IN ('platform_owner','platform_admin')
 AND r.workspace_type='platform' AND r.workspace_id='platform_root' AND r.is_system=true AND r.deleted_at IS NULL AND r.status='normal'
 AND p.code IN ('platform.appearance.view','platform.appearance.update')
ON CONFLICT(role_id,permission_id) DO NOTHING;
