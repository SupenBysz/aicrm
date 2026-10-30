package store

import (
	"context"
	"database/sql"
	"encoding/json"

	d "github.com/Kysion/KyaiCRM/shared/branding"
	"strings"
	"time"
)

type BrandDraft struct {
	WordmarkDarkID               string `json:"wordmarkDarkId"`
	WordmarkDarkGenerated        bool   `json:"wordmarkDarkGenerated,omitempty"`
	WordmarkDarkGeneratorVersion int    `json:"wordmarkDarkGeneratorVersion,omitempty"`
	darkSpecified                bool
	ShowAIIcon                   bool   `json:"showAiIcon"`
	IconGeneratorVersion         int    `json:"iconGeneratorVersion,omitempty"`
	WordmarkGeneratorVersion     int    `json:"wordmarkGeneratorVersion,omitempty"`
	IconText                     string `json:"iconText"`
	CopyrightHolder              string `json:"copyrightHolder"`
	CopyrightStyle               string `json:"copyrightStyle"`
	Name                         string `json:"name"`
	ApplicationName              string `json:"applicationName"`
	IconID                       string `json:"iconId"`
	WordmarkID                   string `json:"wordmarkId"`
	IconGenerated                bool   `json:"iconGenerated,omitempty"`
	WordmarkGenerated            bool   `json:"wordmarkGenerated,omitempty"`
}

func (b *BrandDraft) UnmarshalJSON(raw []byte) error {
	type plain BrandDraft
	var v plain
	if err := json.Unmarshal(raw, &v); err != nil {
		return err
	}
	*b = BrandDraft(v)
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	_, b.darkSpecified = fields["wordmarkDarkId"]
	return nil
}
func preserveDarkBrand(in *BrandDraft, before BrandDraft) {
	if !in.darkSpecified && in.WordmarkDarkID == "" {
		in.WordmarkDarkID = before.WordmarkDarkID
		in.WordmarkDarkGenerated = before.WordmarkDarkGenerated
		in.WordmarkDarkGeneratorVersion = before.WordmarkDarkGeneratorVersion
	}
}

type AgencyBranding struct {
	AgencyID         string     `json:"agencyId"`
	Revision         int64      `json:"revision"`
	PublishedVersion int64      `json:"publishedVersion"`
	Draft            BrandDraft `json:"draft"`
	Published        *d.Brand   `json:"published,omitempty"`
}
type BrandAsset struct {
	ID       string `json:"id"`
	AgencyID string `json:"agencyId"`
	Digest   string `json:"sha256"`
	Format   string `json:"format"`
	Content  []byte `json:"-"`
	Size     int    `json:"size"`
}

func validBrandDraft(b BrandDraft) bool {
	return len(b.WordmarkDarkID) < 128 && b.WordmarkDarkGeneratorVersion >= 0 && b.WordmarkDarkGeneratorVersion <= 1 && b.IconGeneratorVersion >= 0 && b.IconGeneratorVersion <= 1 && b.WordmarkGeneratorVersion >= 0 && b.WordmarkGeneratorVersion <= 1 && validBrandText(b.IconText, 8) && validCopyrightHolder(b.CopyrightHolder) && validCopyrightStyle(b.CopyrightStyle, true) && (b.Name == "" || d.ValidName(b.Name, 40)) && (b.ApplicationName == "" || d.ValidName(b.ApplicationName, 80)) && len(b.IconID) < 128 && len(b.WordmarkID) < 128
}
func (s *Store) AgencyBranding(ctx context.Context, id string) (AgencyBranding, error) {
	out := AgencyBranding{AgencyID: id}
	var exists bool
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM ky_agency WHERE id=$1 AND deleted_at IS NULL)`, id).Scan(&exists); err != nil {
		return out, err
	}
	if !exists {
		return out, ErrNotFound
	}
	var raw []byte
	err := s.db.QueryRowContext(ctx, `SELECT revision,published_version,draft FROM ky_agency_branding WHERE agency_id=$1`, id).Scan(&out.Revision, &out.PublishedVersion, &raw)
	if err == sql.ErrNoRows {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	if err = json.Unmarshal(raw, &out.Draft); err != nil {
		return out, err
	}
	if out.PublishedVersion > 0 {
		var b []byte
		if err = s.db.QueryRowContext(ctx, `SELECT config FROM ky_agency_branding_release WHERE agency_id=$1 AND version=$2`, id, out.PublishedVersion).Scan(&b); err != nil {
			return out, err
		}
		out.Published = &d.Brand{}
		err = json.Unmarshal(b, out.Published)
	}
	return out, err
}
func (s *Store) SaveBrandDraft(ctx context.Context, agency, actor string, expected int64, in BrandDraft) error {
	in.IconText = strings.TrimSpace(in.IconText)
	in.CopyrightHolder = strings.TrimSpace(in.CopyrightHolder)
	if !validBrandDraft(in) {
		return ErrValidation
	}
	raw, _ := json.Marshal(in)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var active bool
	if err = tx.QueryRowContext(ctx, `SELECT status='normal' FROM ky_agency WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, agency).Scan(&active); err == sql.ErrNoRows {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if !active {
		return ErrValidation
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO ky_agency_branding(agency_id) VALUES($1) ON CONFLICT DO NOTHING`, agency); err != nil {
		return err
	}
	var beforeRaw []byte
	if err = tx.QueryRowContext(ctx, `SELECT draft FROM ky_agency_branding WHERE agency_id=$1 FOR UPDATE`, agency).Scan(&beforeRaw); err != nil {
		return err
	}
	var before BrandDraft
	if err = json.Unmarshal(beforeRaw, &before); err != nil {
		return err
	}
	preserveDarkBrand(&in, before)
	raw, _ = json.Marshal(in)
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM ky_brand_asset WHERE agency_id=$1 AND (id=$2 OR id=$3 OR id=$4)`, agency, in.IconID, in.WordmarkID, in.WordmarkDarkID).Scan(&count); err != nil {
		return err
	}
	expectedAssets := map[string]bool{}
	for _, id := range []string{in.IconID, in.WordmarkID, in.WordmarkDarkID} {
		if id != "" {
			expectedAssets[id] = true
		}
	}
	if count != len(expectedAssets) {
		return ErrValidation
	}
	res, err := tx.ExecContext(ctx, `UPDATE ky_agency_branding SET draft=$2,revision=revision+1,updated_by=$3,updated_at=now() WHERE agency_id=$1 AND revision=$4`, agency, string(raw), actor, expected)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		return ErrConflict
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO ky_brand_change(agency_id,actor_id,action,revision) VALUES($1,$2,'draft',$3)`, agency, actor, expected+1); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) SaveBrandAsset(ctx context.Context, agency, format string, content []byte) (BrandAsset, error) {
	sum := d.Digest(content)
	out := BrandAsset{ID: "ba_" + sum[:32], AgencyID: agency, Digest: sum, Format: format, Content: content, Size: len(content)}
	err := s.db.QueryRowContext(ctx, `INSERT INTO ky_brand_asset(id,agency_id,digest,format,content) SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM ky_agency WHERE id=$2 AND status='normal' AND deleted_at IS NULL) ON CONFLICT(agency_id,digest,format) DO NOTHING RETURNING id`, "ba_"+d.Digest([]byte(agency + format + sum))[:32], agency, sum, format, content).Scan(&out.ID)
	if err == sql.ErrNoRows {
		err = s.db.QueryRowContext(ctx, `SELECT b.id FROM ky_brand_asset b JOIN ky_agency a ON a.id=b.agency_id AND a.status='normal' AND a.deleted_at IS NULL WHERE b.agency_id=$1 AND b.digest=$2 AND b.format=$3`, agency, sum, format).Scan(&out.ID)
	}
	if err == sql.ErrNoRows {
		err = ErrNotFound
	}
	return out, err
}
func (s *Store) BrandAsset(ctx context.Context, id string) (BrandAsset, error) {
	var a BrandAsset
	err := s.db.QueryRowContext(ctx, `SELECT id,agency_id,digest,format,content FROM ky_brand_asset WHERE id=$1`, id).Scan(&a.ID, &a.AgencyID, &a.Digest, &a.Format, &a.Content)
	a.Size = len(a.Content)
	if err == sql.ErrNoRows {
		err = ErrNotFound
	}
	return a, err
}
func assetDescriptor(a BrandAsset, base string) d.BrandAsset {
	if a.ID == "" {
		return d.BrandAsset{}
	}
	return d.BrandAsset{URL: base + "/api/v1/public/brand-assets/" + a.ID, SHA256: a.Digest, Size: a.Size, Format: a.Format}
}
func (s *Store) PublishBrand(ctx context.Context, agency, actor, base string, expected int64, rollbackVersion int64) (AgencyBranding, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AgencyBranding{}, err
	}
	defer tx.Rollback()
	var active bool
	if err = tx.QueryRowContext(ctx, `SELECT status='normal' FROM ky_agency WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, agency).Scan(&active); err != nil {
		return AgencyBranding{}, err
	}
	if !active {
		return AgencyBranding{}, ErrNotFound
	}

	var revision, latest int64
	var raw []byte
	if err = tx.QueryRowContext(ctx, `SELECT revision,draft,(SELECT COALESCE(max(version),0) FROM ky_agency_branding_release WHERE agency_id=$1) FROM ky_agency_branding WHERE agency_id=$1 FOR UPDATE`, agency).Scan(&revision, &raw, &latest); err != nil {
		return AgencyBranding{}, err
	}
	if revision != expected {
		return AgencyBranding{}, ErrConflict
	}
	var brand d.Brand
	if rollbackVersion > 0 {
		if err = tx.QueryRowContext(ctx, `SELECT config FROM ky_agency_branding_release WHERE agency_id=$1 AND version=$2`, agency, rollbackVersion).Scan(&raw); err != nil {
			return AgencyBranding{}, err
		}
		if err = json.Unmarshal(raw, &brand); err != nil {
			return AgencyBranding{}, err
		}
	} else {
		var draft BrandDraft
		if json.Unmarshal(raw, &draft) != nil || !validBrandDraft(draft) {
			return AgencyBranding{}, ErrValidation
		}
		read := func(id string) (BrandAsset, error) {
			var a BrandAsset
			if id == "" {
				return a, nil
			}
			e := tx.QueryRowContext(ctx, `SELECT id,agency_id,digest,format,content FROM ky_brand_asset WHERE id=$1 AND agency_id=$2`, id, agency).Scan(&a.ID, &a.AgencyID, &a.Digest, &a.Format, &a.Content)
			a.Size = len(a.Content)
			return a, e
		}
		icon, e := read(draft.IconID)
		if e != nil {
			return AgencyBranding{}, e
		}
		wordmark, e := read(draft.WordmarkID)
		if e != nil {
			return AgencyBranding{}, e
		}
		if wordmark.ID != "" && wordmark.Format != "png" {
			return AgencyBranding{}, ErrValidation
		}
		dark, e := read(draft.WordmarkDarkID)
		if e != nil {
			return AgencyBranding{}, e
		}
		if dark.ID != "" && dark.Format != "png" {
			return AgencyBranding{}, ErrValidation
		}
		brand = d.Brand{WordmarkDark: assetDescriptor(dark, base), WordmarkDarkGenerated: draft.WordmarkDarkGenerated, ShowAIIcon: draft.ShowAIIcon, WordmarkGenerated: draft.WordmarkGenerated, IconGenerated: draft.IconGenerated, IconText: draft.IconText, CopyrightHolder: draft.CopyrightHolder, CopyrightStyle: draft.CopyrightStyle, AgencyID: agency, Name: draft.Name, ApplicationName: draft.ApplicationName, Icon: assetDescriptor(icon, base), Wordmark: assetDescriptor(wordmark, base)}
	}
	brand.Version = latest + 1
	brand.AgencyID = agency
	raw, _ = json.Marshal(brand)
	if _, err = tx.ExecContext(ctx, `INSERT INTO ky_agency_branding_release(agency_id,version,config,created_by) VALUES($1,$2,$3,$4)`, agency, brand.Version, string(raw), actor); err != nil {
		return AgencyBranding{}, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE ky_agency_branding SET published_version=$2,revision=revision+1,updated_by=$3,updated_at=$4 WHERE agency_id=$1`, agency, brand.Version, actor, time.Now()); err != nil {
		return AgencyBranding{}, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE ky_brand_asset SET published_at=COALESCE(published_at,now()) WHERE agency_id=$1 AND id IN ($2,$3,$4)`, agency, strings.TrimPrefix(brand.Icon.URL, base+"/api/v1/public/brand-assets/"), strings.TrimPrefix(brand.Wordmark.URL, base+"/api/v1/public/brand-assets/"), strings.TrimPrefix(brand.WordmarkDark.URL, base+"/api/v1/public/brand-assets/")); err != nil {
		return AgencyBranding{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO ky_brand_change(agency_id,actor_id,action,revision) VALUES($1,$2,'publish',$3)`, agency, actor, expected+1); err != nil {
		return AgencyBranding{}, err
	}
	if err = tx.Commit(); err != nil {
		return AgencyBranding{}, err
	}
	return s.AgencyBranding(ctx, agency)
}
func (s *Store) EnterpriseBrand(ctx context.Context, enterprise string) (string, *d.Brand, error) {
	var agency string
	err := s.db.QueryRowContext(ctx, `SELECT COALESCE(e.agency_id,'') FROM ky_enterprise e WHERE e.id=$1 AND e.status='normal' AND e.deleted_at IS NULL AND (e.agency_id IS NULL OR EXISTS(SELECT 1 FROM ky_agency a WHERE a.id=e.agency_id AND a.status='normal' AND a.deleted_at IS NULL))`, enterprise).Scan(&agency)
	if err != nil {
		return "", nil, err
	}
	if agency == "" {
		return agency, nil, nil
	}
	b, err := s.AgencyBranding(ctx, agency)
	return agency, b.Published, err
}

func (s *Store) PublicBrandAsset(ctx context.Context, id string) (BrandAsset, error) {
	var allowed bool
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM ky_brand_asset b JOIN ky_agency a ON a.id=b.agency_id WHERE b.id=$1 AND b.published_at IS NOT NULL AND a.status='normal' AND a.deleted_at IS NULL)`, id).Scan(&allowed); err != nil {
		return BrandAsset{}, err
	}
	if !allowed {
		return BrandAsset{}, ErrNotFound
	}
	return s.BrandAsset(ctx, id)
}
func (s *Store) BrandHistory(ctx context.Context, id string) ([]int64, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT version FROM ky_agency_branding_release WHERE agency_id=$1 ORDER BY version DESC LIMIT 100`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []int64{}
	for rows.Next() {
		var version int64
		if err = rows.Scan(&version); err != nil {
			return nil, err
		}
		out = append(out, version)
	}
	return out, rows.Err()
}
