-- Add the six reviewed palettes while preserving every existing appearance value.
DO $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT conrelid::regclass AS table_name, conname
    FROM pg_constraint
    WHERE conrelid IN ('ky_user_appearance'::regclass, 'ky_platform_appearance'::regclass)
      AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%theme_id%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', item.table_name, item.conname);
  END LOOP;
END $$;

ALTER TABLE ky_user_appearance ADD CONSTRAINT ky_user_appearance_theme_mode_check CHECK (
  (source = 'platform' AND theme_id = '' AND mode = '') OR
  (source = 'personal' AND theme_id IN (
    'classic-gold','business-blue','jade-green','graphite-cyan',
    'violet-dusk','terracotta','sky-mist','pine-forest','camellia-red','slate-fog'
  ) AND mode IN ('light','dark','system'))
);
ALTER TABLE ky_platform_appearance ADD CONSTRAINT ky_platform_appearance_theme_id_check
  CHECK (theme_id IN (
    'classic-gold','business-blue','jade-green','graphite-cyan',
    'violet-dusk','terracotta','sky-mist','pine-forest','camellia-red','slate-fog'
  ));
