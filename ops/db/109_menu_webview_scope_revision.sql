-- Keep a monotonic scope revision even when an override is removed.
CREATE TABLE IF NOT EXISTS ky_menu_webview_scope_revision (
 directory_type text NOT NULL,
 menu_key text NOT NULL,
 config_scope text NOT NULL CHECK(config_scope IN ('common','workspace')),
 workspace_type text NOT NULL CHECK(workspace_type IN ('platform','agency','enterprise')),
 workspace_id text NOT NULL,
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 PRIMARY KEY(directory_type,menu_key,config_scope,workspace_type,workspace_id),
 FOREIGN KEY(directory_type,menu_key) REFERENCES ky_menu_directory(directory_type,menu_key) ON DELETE CASCADE,
 CHECK((config_scope='common' AND workspace_type='platform' AND workspace_id='*') OR config_scope='workspace')
);
INSERT INTO ky_menu_webview_scope_revision SELECT directory_type,menu_key,config_scope,workspace_type,workspace_id,revision FROM ky_menu_webview_config ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ky_menu_webview_scope_event (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 directory_type text NOT NULL, menu_key text NOT NULL, config_scope text NOT NULL,
 workspace_type text NOT NULL, workspace_id text NOT NULL, revision bigint NOT NULL,
 actor_id text NOT NULL, action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
