package store

import (
	"context"
	"database/sql"
	"time"
)

// PlatformProfile is the platform-level basic info (singleton).
type PlatformProfile struct {
	CompanyName         string `json:"companyName"`
	BrandLogoTextLong   string `json:"brandLogoTextLong"`
	BrandLogoTextShort  string `json:"brandLogoTextShort"`
	LongLogoFontSize    int    `json:"longLogoFontSize"`
	LongLogoFontFamily  string `json:"longLogoFontFamily"`
	LongLogoFontWeight  int    `json:"longLogoFontWeight"`
	ShortLogoFontSize   int    `json:"shortLogoFontSize"`
	ShortLogoFontFamily string `json:"shortLogoFontFamily"`
	ShortLogoFontWeight int    `json:"shortLogoFontWeight"`
	ICPRecord           string `json:"icpRecord"`
	UpdatedAt           string `json:"updatedAt,omitempty"`
}

func normalizePlatformProfile(p *PlatformProfile) {
	if p.LongLogoFontSize == 0 {
		p.LongLogoFontSize = 16
	}
	if p.LongLogoFontFamily == "" {
		p.LongLogoFontFamily = "system"
	}
	if p.LongLogoFontWeight == 0 {
		p.LongLogoFontWeight = 600
	}
	if p.ShortLogoFontSize == 0 {
		p.ShortLogoFontSize = 14
	}
	if p.ShortLogoFontFamily == "" {
		p.ShortLogoFontFamily = "system"
	}
	if p.ShortLogoFontWeight == 0 {
		p.ShortLogoFontWeight = 600
	}
}

func (s *Store) GetPlatformProfile(ctx context.Context) (PlatformProfile, error) {
	var p PlatformProfile
	var updatedAt sql.NullTime
	err := s.db.QueryRowContext(ctx,
		`SELECT company_name, brand_logo_text_long, brand_logo_text_short,
			long_logo_font_size, long_logo_font_family, long_logo_font_weight,
			short_logo_font_size, short_logo_font_family, short_logo_font_weight,
			icp_record, updated_at FROM ky_platform_profile WHERE id='default'`,
	).Scan(&p.CompanyName, &p.BrandLogoTextLong, &p.BrandLogoTextShort,
		&p.LongLogoFontSize, &p.LongLogoFontFamily, &p.LongLogoFontWeight,
		&p.ShortLogoFontSize, &p.ShortLogoFontFamily, &p.ShortLogoFontWeight,
		&p.ICPRecord, &updatedAt)
	if err == sql.ErrNoRows {
		p = PlatformProfile{}
		normalizePlatformProfile(&p)
		return p, nil
	}
	if err != nil {
		return PlatformProfile{}, err
	}
	if updatedAt.Valid {
		p.UpdatedAt = updatedAt.Time.Format(time.RFC3339)
	}
	normalizePlatformProfile(&p)
	return p, nil
}

func (s *Store) UpsertPlatformProfile(ctx context.Context, companyName, brandLogoTextLong, brandLogoTextShort string, longLogoFontSize int, longLogoFontFamily string, longLogoFontWeight int, shortLogoFontSize int, shortLogoFontFamily string, shortLogoFontWeight int, icpRecord, updatedBy string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_platform_profile (id, company_name, brand_logo_text_long, brand_logo_text_short,
			long_logo_font_size, long_logo_font_family, long_logo_font_weight,
			short_logo_font_size, short_logo_font_family, short_logo_font_weight,
			icp_record, updated_by, updated_at)
		VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
		ON CONFLICT (id) DO UPDATE SET
			company_name=$1,
			brand_logo_text_long=$2,
			brand_logo_text_short=$3,
			long_logo_font_size=$4,
			long_logo_font_family=$5,
			long_logo_font_weight=$6,
			short_logo_font_size=$7,
			short_logo_font_family=$8,
			short_logo_font_weight=$9,
			icp_record=$10,
			updated_by=$11,
			updated_at=now()
	`, companyName, brandLogoTextLong, brandLogoTextShort, longLogoFontSize, longLogoFontFamily, longLogoFontWeight, shortLogoFontSize, shortLogoFontFamily, shortLogoFontWeight, icpRecord, nullStr(updatedBy))
	return err
}
