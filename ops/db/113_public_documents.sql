-- Platform documents belong exclusively to Org. Additive, no sample legal text.
CREATE TABLE ky_document (
 id text PRIMARY KEY, slug text NOT NULL UNIQUE CHECK(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
 category text NOT NULL CHECK(category IN ('agreement','privacy','notice','other')),
 status text NOT NULL DEFAULT 'unpublished' CHECK(status IN ('unpublished','published','offline')),
 current_version integer NOT NULL DEFAULT 0, revision bigint NOT NULL DEFAULT 1,
 updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ky_document_draft (
 document_id text PRIMARY KEY REFERENCES ky_document(id) ON DELETE CASCADE,
 title text NOT NULL, markdown text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '',
 dirty boolean NOT NULL DEFAULT true, CHECK(octet_length(markdown)<=1048576)
);
CREATE TABLE ky_document_version (
 document_id text NOT NULL REFERENCES ky_document(id), version integer NOT NULL,
 title text NOT NULL, markdown text NOT NULL, note text NOT NULL, digest text NOT NULL,
 actor_id text NOT NULL, published_at timestamptz NOT NULL DEFAULT now(),
 publish_key text NOT NULL, source_revision bigint NOT NULL, PRIMARY KEY(document_id,version), UNIQUE(document_id,publish_key)
);
CREATE TABLE ky_document_link_binding (
 purpose text PRIMARY KEY CHECK(purpose IN ('privacy_policy','terms_of_service')),
 document_id text REFERENCES ky_document(id), revision bigint NOT NULL DEFAULT 0,
 updated_by text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ky_document_link_binding(purpose) VALUES ('privacy_policy'),('terms_of_service');
INSERT INTO ky_permission(id,code,name,category,resource,action,workspace_types,description,status)
SELECT 'perm_platform_documents_'||x.action,'platform.documents.'||x.action,x.name,
 CASE WHEN x.action='view' THEN 'page' ELSE 'action' END,'documents',x.action,'["platform"]'::jsonb,x.name,'normal'
FROM (VALUES ('view','协议文档查看'),('create','协议文档创建'),('update','协议文档编辑'),('publish','协议文档发布'),('unpublish','协议文档下线'),('delete','协议草稿删除'),('bind','协议入口绑定')) x(action,name)
ON CONFLICT(code) DO NOTHING;
INSERT INTO ky_role_permission(id,role_id,permission_id)
SELECT 'rp_'||r.id||'_'||p.id,r.id,p.id FROM ky_role r CROSS JOIN ky_permission p
WHERE r.id='role_platform_owner' AND r.code='platform_owner' AND r.workspace_type='platform' AND r.workspace_id='platform_root'
AND r.is_system=true AND r.deleted_at IS NULL AND r.status='normal' AND p.code LIKE 'platform.documents.%'
ON CONFLICT(role_id,permission_id) DO NOTHING;
-- Preserve existing operator-defined menu metadata and append only this capability.
UPDATE ky_menu_directory SET permission_bindings=jsonb_set(permission_bindings,'{platform}',
 COALESCE(permission_bindings->'platform','[]'::jsonb)||'["platform.documents.view"]'::jsonb)
WHERE directory_type='management' AND menu_key='ky-system-settings.hub'
AND NOT COALESCE(permission_bindings->'platform','[]'::jsonb) ? 'platform.documents.view';
