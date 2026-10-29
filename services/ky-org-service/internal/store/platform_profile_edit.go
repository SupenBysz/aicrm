package store

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

var ErrValidation = errors.New("validation error")

func MergePlatformProfile(current PlatformProfile, fields map[string]json.RawMessage) (PlatformProfile, []string, error) {
	changed := []string{}
	for key, raw := range fields {
		if string(raw) == "null" {
			return current, nil, ErrValidation
		}
		text := func(target *string, max int) error {
			var value string
			if json.Unmarshal(raw, &value) != nil {
				return ErrValidation
			}
			value = strings.TrimSpace(value)
			if !utf8.ValidString(value) || utf8.RuneCountInString(value) > max {
				return ErrValidation
			}
			for _, c := range value {
				if unicode.IsControl(c) || unicode.In(c, unicode.Cf) {
					return ErrValidation
				}
			}
			if key == "companyName" && strings.Contains(value, "©") {
				return ErrValidation
			}
			*target = value
			return nil
		}
		number := func(target *int) error {
			var value int
			if json.Unmarshal(raw, &value) != nil {
				return ErrValidation
			}
			*target = value
			return nil
		}
		var err error
		switch key {
		case "brand":
			current.Brand = BrandDraft{}
			err = json.Unmarshal(raw, &current.Brand)
			if err == nil && !validBrandDraft(current.Brand) {
				err = ErrValidation
			}
		case "companyName":
			err = text(&current.CompanyName, 120)
		case "brandLogoTextLong":
			err = text(&current.BrandLogoTextLong, 120)
		case "brandLogoTextShort":
			err = text(&current.BrandLogoTextShort, 40)
		case "icpRecord":
			err = text(&current.ICPRecord, 120)
		case "copyrightStyle":
			err = text(&current.CopyrightStyle, 20)
		case "longLogoFontSize":
			err = number(&current.LongLogoFontSize)
		case "shortLogoFontSize":
			err = number(&current.ShortLogoFontSize)
		case "longLogoFontWeight":
			err = number(&current.LongLogoFontWeight)
		case "shortLogoFontWeight":
			err = number(&current.ShortLogoFontWeight)
		case "longLogoFontFamily":
			err = text(&current.LongLogoFontFamily, 20)
		case "shortLogoFontFamily":
			err = text(&current.ShortLogoFontFamily, 20)
		default:
			return current, nil, ErrValidation
		}
		if err != nil {
			return current, nil, err
		}
		changed = append(changed, key)
	}
	validStyle := func(size, weight int, family string) bool {
		return size >= 8 && size <= 72 && (weight == 400 || weight == 500 || weight == 600 || weight == 700) && (family == "system" || family == "sans" || family == "serif" || family == "mono")
	}
	if !validStyle(current.LongLogoFontSize, current.LongLogoFontWeight, current.LongLogoFontFamily) || !validStyle(current.ShortLogoFontSize, current.ShortLogoFontWeight, current.ShortLogoFontFamily) || (current.CopyrightStyle != "standard" && current.CopyrightStyle != "full" && current.CopyrightStyle != "chinese") {
		return current, nil, ErrValidation
	}
	return current, changed, nil
}

// EditPlatformProfile is the versioned edit path. Legacy PATCH retains its existing contract
// and increments revision, so it invalidates a versioned editor's prior revision.
func (s *Store) EditPlatformProfile(ctx context.Context, expected, actor, request string, fields map[string]json.RawMessage) (PlatformProfile, error) {
	var out PlatformProfile
	revision, err := strconv.ParseInt(expected, 10, 64)
	if err != nil || revision < 0 || actor == "" || request == "" || len(fields) == 0 {
		return out, ErrValidation
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext('platform-profile-edit'))`); err != nil {
		return out, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO ky_platform_profile(id) VALUES('default') ON CONFLICT DO NOTHING`); err != nil {
		return out, err
	}
	current, err := readPlatformProfile(tx.QueryRowContext(ctx, platformProfileSelect+" FOR UPDATE"))
	if err != nil {
		return out, err
	}
	if current.Revision != strconv.FormatInt(revision, 10) {
		return out, ErrConflict
	}
	out, changed, err := MergePlatformProfile(current, fields)
	if err != nil {
		return out, err
	}
	for _, id := range []string{out.Brand.IconID, out.Brand.WordmarkID} {
		if id == "" {
			continue
		}
		var exists bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM ky_platform_brand_asset WHERE id=$1)`, id).Scan(&exists); err != nil {
			return out, err
		}
		if !exists {
			return out, ErrValidation
		}
	}
	brandRaw, _ := json.Marshal(out.Brand)
	result, err := tx.ExecContext(ctx, `UPDATE ky_platform_profile SET company_name=$1,brand_logo_text_long=$2,brand_logo_text_short=$3,long_logo_font_size=$4,long_logo_font_family=$5,long_logo_font_weight=$6,short_logo_font_size=$7,short_logo_font_family=$8,short_logo_font_weight=$9,icp_record=$10,copyright_style=$11,brand_config=$14,revision=revision+1,updated_by=$12,updated_at=now() WHERE id='default' AND revision=$13`, out.CompanyName, out.BrandLogoTextLong, out.BrandLogoTextShort, out.LongLogoFontSize, out.LongLogoFontFamily, out.LongLogoFontWeight, out.ShortLogoFontSize, out.ShortLogoFontFamily, out.ShortLogoFontWeight, out.ICPRecord, out.CopyrightStyle, actor, revision, string(brandRaw))
	if err != nil {
		return out, err
	}
	count, _ := result.RowsAffected()
	if count != 1 {
		return out, ErrConflict
	}
	detail, _ := json.Marshal(changed)
	if _, err = tx.ExecContext(ctx, `INSERT INTO ky_platform_profile_change(id,revision,actor_id,request_id,changed_fields) VALUES($1,$2,$3,$4,$5)`, "profile_"+randomSuffix(), revision+1, actor, request, detail); err != nil {
		return out, err
	}
	out, err = readPlatformProfile(tx.QueryRowContext(ctx, platformProfileSelect))
	if err != nil {
		return out, err
	}
	if err = tx.Commit(); err != nil {
		return out, err
	}
	out.Revision = strconv.FormatInt(revision+1, 10)
	return out, nil
}
