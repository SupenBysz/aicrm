package store

import (
	"context"
	"database/sql"
	"time"
)

// PlatformProfile is the platform-level basic info (singleton).
type PlatformProfile struct {
	CompanyName        string `json:"companyName"`
	BrandLogoTextLong  string `json:"brandLogoTextLong"`
	BrandLogoTextShort string `json:"brandLogoTextShort"`
	ICPRecord          string `json:"icpRecord"`
	UpdatedAt          string `json:"updatedAt,omitempty"`
}

func (s *Store) GetPlatformProfile(ctx context.Context) (PlatformProfile, error) {
	var p PlatformProfile
	var updatedAt sql.NullTime
	err := s.db.QueryRowContext(ctx,
		`SELECT company_name, brand_logo_text_long, brand_logo_text_short, icp_record, updated_at FROM ky_platform_profile WHERE id='default'`,
	).Scan(&p.CompanyName, &p.BrandLogoTextLong, &p.BrandLogoTextShort, &p.ICPRecord, &updatedAt)
	if err == sql.ErrNoRows {
		return PlatformProfile{}, nil
	}
	if err != nil {
		return PlatformProfile{}, err
	}
	if updatedAt.Valid {
		p.UpdatedAt = updatedAt.Time.Format(time.RFC3339)
	}
	return p, nil
}

func (s *Store) UpsertPlatformProfile(ctx context.Context, companyName, brandLogoTextLong, brandLogoTextShort, icpRecord, updatedBy string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ky_platform_profile (id, company_name, brand_logo_text_long, brand_logo_text_short, icp_record, updated_by, updated_at)
		VALUES ('default', $1, $2, $3, $4, $5, now())
		ON CONFLICT (id) DO UPDATE SET
			company_name=$1,
			brand_logo_text_long=$2,
			brand_logo_text_short=$3,
			icp_record=$4,
			updated_by=$5,
			updated_at=now()
	`, companyName, brandLogoTextLong, brandLogoTextShort, icpRecord, nullStr(updatedBy))
	return err
}
