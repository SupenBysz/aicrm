-- 平台品牌长短文字 Logo 的安全字体配置。仅允许受控枚举和范围值，兼容既有 profile 行。
ALTER TABLE ky_platform_profile
  ADD COLUMN IF NOT EXISTS long_logo_font_size integer NOT NULL DEFAULT 16,
  ADD COLUMN IF NOT EXISTS long_logo_font_family text NOT NULL DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS long_logo_font_weight integer NOT NULL DEFAULT 600,
  ADD COLUMN IF NOT EXISTS short_logo_font_size integer NOT NULL DEFAULT 14,
  ADD COLUMN IF NOT EXISTS short_logo_font_family text NOT NULL DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS short_logo_font_weight integer NOT NULL DEFAULT 600;

UPDATE ky_platform_profile
SET long_logo_font_size = COALESCE(NULLIF(long_logo_font_size, 0), 16),
    long_logo_font_family = CASE WHEN long_logo_font_family IN ('system', 'sans', 'serif', 'mono') THEN long_logo_font_family ELSE 'system' END,
    long_logo_font_weight = CASE WHEN long_logo_font_weight IN (400, 500, 600, 700) THEN long_logo_font_weight ELSE 600 END,
    short_logo_font_size = COALESCE(NULLIF(short_logo_font_size, 0), 14),
    short_logo_font_family = CASE WHEN short_logo_font_family IN ('system', 'sans', 'serif', 'mono') THEN short_logo_font_family ELSE 'system' END,
    short_logo_font_weight = CASE WHEN short_logo_font_weight IN (400, 500, 600, 700) THEN short_logo_font_weight ELSE 600 END;

ALTER TABLE ky_platform_profile
  ADD CONSTRAINT ky_platform_profile_long_logo_font_size_ck CHECK (long_logo_font_size BETWEEN 8 AND 72),
  ADD CONSTRAINT ky_platform_profile_short_logo_font_size_ck CHECK (short_logo_font_size BETWEEN 8 AND 72),
  ADD CONSTRAINT ky_platform_profile_long_logo_font_family_ck CHECK (long_logo_font_family IN ('system', 'sans', 'serif', 'mono')),
  ADD CONSTRAINT ky_platform_profile_short_logo_font_family_ck CHECK (short_logo_font_family IN ('system', 'sans', 'serif', 'mono')),
  ADD CONSTRAINT ky_platform_profile_long_logo_font_weight_ck CHECK (long_logo_font_weight IN (400, 500, 600, 700)),
  ADD CONSTRAINT ky_platform_profile_short_logo_font_weight_ck CHECK (short_logo_font_weight IN (400, 500, 600, 700));
