\set ON_ERROR_STOP on
-- Deployment-specific, explicitly authorized bootstrap for the protected owner role.
-- Contributions only register permissions; no other role receives these grants.
BEGIN;
DO $$ BEGIN
  IF (SELECT count(*) FROM ky_role WHERE id='role_platform_owner' AND code='platform_owner'
      AND workspace_type='platform' AND workspace_id='platform_root' AND is_system=true
      AND status='normal' AND deleted_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'Expected protected platform owner role is missing';
  END IF;
  IF (SELECT count(*) FROM ky_permission WHERE code IN
      ('platform.agency_branding.view','platform.agency_branding.update','platform.agency_branding.publish')
      AND workspace_types @> '["platform"]'::jsonb) <> 3 THEN
    RAISE EXCEPTION 'Brand permission registration is incomplete';
  END IF;
END $$;
INSERT INTO ky_role_permission(id,role_id,permission_id)
SELECT 'rp_release_20261029_'||p.id,'role_platform_owner',p.id FROM ky_permission p
WHERE p.code IN ('platform.agency_branding.view','platform.agency_branding.update','platform.agency_branding.publish')
ON CONFLICT(role_id,permission_id) DO NOTHING;
INSERT INTO ky_audit_log(id,workspace_type,workspace_id,action,resource_type,resource_id,result,request_id,source,remark,detail)
VALUES('aud_release_20261029_brand_owner','platform','platform_root','deployment.permissions_granted','role','role_platform_owner',
       'success','req_release_20261029_brand_owner','deployment',
       'User-authorized release: add only brand permissions to the existing protected platform owner role.',
       '{"permissions":["platform.agency_branding.view","platform.agency_branding.update","platform.agency_branding.publish"],"domainPermissionsGranted":false}'::jsonb)
ON CONFLICT(id) DO NOTHING;
COMMIT;
