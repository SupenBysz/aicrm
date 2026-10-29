CREATE TABLE ky_agency_domain (
 id text PRIMARY KEY, agency_id text NOT NULL, hostname text NOT NULL, mode text NOT NULL CHECK(mode IN ('managed')),
 state text NOT NULL CHECK(state IN ('awaiting_verification','awaiting_dns','provisioning','ready','active','degraded','suspended','cancelled','detaching','detached')),
 revision bigint NOT NULL DEFAULT 1, generation bigint NOT NULL DEFAULT 1, challenge text NOT NULL,
 challenge_expires_at timestamptz NOT NULL, provider_id text NOT NULL DEFAULT '', observation jsonb NOT NULL DEFAULT '{}',
 actor_id text NOT NULL, workspace_id text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agency_domain_hostname ON ky_agency_domain(hostname) WHERE state NOT IN ('detached','cancelled');
CREATE UNIQUE INDEX agency_domain_primary ON ky_agency_domain(agency_id) WHERE state IN ('active','degraded','suspended');
CREATE UNIQUE INDEX agency_domain_candidate ON ky_agency_domain(agency_id) WHERE state IN ('awaiting_verification','awaiting_dns','provisioning','ready');
CREATE TABLE ky_agency_domain_task (
 id text PRIMARY KEY,binding_id text NOT NULL REFERENCES ky_agency_domain(id),generation bigint NOT NULL,phase text NOT NULL DEFAULT 'verify',
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','done','cancelled')),
 lease_token text NOT NULL DEFAULT '',lease_until timestamptz,next_at timestamptz NOT NULL DEFAULT now(),attempts integer NOT NULL DEFAULT 0,
 message text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agency_domain_live_task ON ky_agency_domain_task(binding_id) WHERE state IN ('queued','running');
CREATE TABLE ky_agency_domain_command (
 actor_id text NOT NULL,workspace_id text NOT NULL,command_key text NOT NULL,request_hash text NOT NULL,result jsonb NOT NULL,
 PRIMARY KEY(actor_id,workspace_id,command_key)
);
CREATE TABLE ky_agency_domain_audit (
 id bigserial PRIMARY KEY,binding_id text NOT NULL,actor_id text NOT NULL,action text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON ky_agency_domain,ky_agency_domain_task,ky_agency_domain_command,ky_agency_domain_audit FROM PUBLIC;
INSERT INTO ky_permission(id,code,name,category,resource,action,workspace_types) VALUES
 ('perm_agency_domains_view','platform.agency_domains.view','查看机构域名','page','agency_domains','view','["platform"]'),
 ('perm_agency_domains_manage','platform.agency_domains.manage','配置机构域名','action','agency_domains','manage','["platform"]'),
 ('perm_agency_domains_activate','platform.agency_domains.activate','启停机构域名','action','agency_domains','activate','["platform"]') ON CONFLICT(code) DO NOTHING;

CREATE INDEX agency_domain_task_due ON ky_agency_domain_task(next_at,id) WHERE state IN ('queued','running');
CREATE INDEX agency_domain_task_history ON ky_agency_domain_task(binding_id,created_at DESC);
CREATE INDEX agency_domain_audit_history ON ky_agency_domain_audit(binding_id,created_at DESC);
CREATE INDEX agency_domain_agency_history ON ky_agency_domain(agency_id,created_at DESC);
