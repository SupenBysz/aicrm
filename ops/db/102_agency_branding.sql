CREATE TABLE ky_agency_branding (
 agency_id text PRIMARY KEY, revision bigint NOT NULL DEFAULT 0, draft jsonb NOT NULL DEFAULT '{}',
 published_version bigint NOT NULL DEFAULT 0, updated_by text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ky_agency_branding_release (
 agency_id text NOT NULL, version bigint NOT NULL, config jsonb NOT NULL,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(agency_id,version)
);
CREATE TABLE ky_brand_asset (
 id text PRIMARY KEY, agency_id text NOT NULL, digest text NOT NULL, format text NOT NULL CHECK(format IN ('png')),
 content bytea NOT NULL CHECK(octet_length(content)<=4194304), created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz, UNIQUE(agency_id,digest,format)
);
CREATE TABLE ky_brand_change(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,agency_id text NOT NULL,actor_id text NOT NULL,action text NOT NULL,revision bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON ky_agency_branding,ky_agency_branding_release,ky_brand_asset,ky_brand_change FROM PUBLIC;
INSERT INTO ky_permission(id,code,name,category,resource,action,workspace_types) VALUES
 ('perm_agency_brand_view','platform.agency_branding.view','查看机构品牌','action','agency_branding','view','["platform"]'),
 ('perm_agency_brand_update','platform.agency_branding.update','编辑机构品牌','action','agency_branding','update','["platform"]'),
 ('perm_agency_brand_publish','platform.agency_branding.publish','发布机构品牌','action','agency_branding','publish','["platform"]');
-- Permission registration only. An authorized administrator explicitly assigns roles.
