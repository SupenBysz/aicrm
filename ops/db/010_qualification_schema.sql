-- 010 qualification review (资质审核)
-- Platform-side review queue for organization (agency/enterprise) qualification
-- submissions. Approve/reject changes the record status (no provisioning side
-- effect). Organization self-submission is a future extension.

CREATE TABLE IF NOT EXISTS ky_qualification (
  id                 text PRIMARY KEY,
  target_type        text NOT NULL CHECK (target_type IN ('agency', 'enterprise')),
  target_id          text NOT NULL,
  qualification_type text NOT NULL,
  materials          jsonb NOT NULL DEFAULT '[]'::jsonb,
  status             text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected')),
  review_user_id     text REFERENCES ky_user(id),
  reviewed_at        timestamptz,
  review_remark      text NOT NULL DEFAULT '',
  created_by         text REFERENCES ky_user(id),
  updated_by         text REFERENCES ky_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ky_qualification_status_idx ON ky_qualification(status);
CREATE INDEX IF NOT EXISTS ky_qualification_target_idx ON ky_qualification(target_type, target_id);
