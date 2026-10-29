-- Org owns platform presentation settings and its conditional-write history.
ALTER TABLE ky_platform_profile ADD COLUMN copyright_style text NOT NULL DEFAULT 'standard' CHECK(copyright_style IN ('standard','full','chinese'));
ALTER TABLE ky_platform_profile ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0);
CREATE TABLE ky_platform_profile_change (
 id text PRIMARY KEY, revision bigint NOT NULL UNIQUE, actor_id text NOT NULL,
 request_id text NOT NULL, changed_fields jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
