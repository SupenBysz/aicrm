package store

import (
	"context"
	"encoding/json"
	d "github.com/Kysion/KyaiCRM/shared/branding"
	"strings"
	"unicode"
	"unicode/utf8"
)

func validCopyrightStyle(s string, inherit bool) bool {
	return s == "standard" || s == "full" || s == "chinese" || inherit && s == ""
}
func validBrandText(s string, max int) bool {
	if !utf8.ValidString(s) || utf8.RuneCountInString(s) > max {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) || unicode.In(r, unicode.Cf) {
			return false
		}
	}
	return true
}

func validCopyrightHolder(s string) bool {
	text := strings.TrimSpace(s)
	return validBrandText(text, 120) && !strings.Contains(text, "©")
}

// EffectiveBrand never mutates the immutable published snapshot.
func (s *Store) EffectiveBrand(ctx context.Context, published *d.Brand) (*d.Brand, error) {
	profile, err := s.GetPlatformProfile(ctx)
	if err != nil {
		return nil, err
	}
	return resolveBrand(published, profile), nil
}
func resolveBrand(published *d.Brand, p PlatformProfile) *d.Brand {
	holder := strings.TrimSpace(p.CompanyName)
	if holder == "" {
		holder = strings.TrimSpace(p.BrandLogoTextLong)
		if holder == "" {
			holder = "KyCRM"
		}
	}
	style := p.CopyrightStyle
	if !validCopyrightStyle(style, false) {
		style = "standard"
	}
	name := strings.TrimSpace(p.Brand.Name)
	if name == "" {
		name = strings.TrimSpace(p.BrandLogoTextLong)
	}
	if name == "" {
		name = holder
	}
	out := d.Brand{Name: name, ApplicationName: p.Brand.ApplicationName, Source: "platform", IconText: p.Brand.IconText, ShowAIIcon: p.Brand.ShowAIIcon, WordmarkGenerated: p.Brand.WordmarkGenerated, IconGenerated: p.Brand.IconGenerated}
	if out.ApplicationName == "" {
		out.ApplicationName = name
	}
	if p.Brand.CopyrightHolder != "" {
		holder = p.Brand.CopyrightHolder
	}
	if p.Brand.WordmarkID != "" {
		out.Wordmark.URL = "/api/v1/public/platform-brand-assets/" + p.Brand.WordmarkID
	}
	if p.Brand.IconID != "" {
		out.Icon.URL = "/api/v1/public/platform-brand-assets/" + p.Brand.IconID
	}
	if published != nil {
		out = *published
		out.Source = "agency"
		if out.Name == "" {
			out.Name = name
		}
		if out.ApplicationName == "" {
			out.ApplicationName = out.Name
		}
	}
	if out.CopyrightHolder == "" {
		out.CopyrightHolder = holder
	}
	if out.CopyrightStyle == "" {
		out.CopyrightStyle = style
	}
	out.EffectiveFingerprint = ""
	raw, _ := json.Marshal(out)
	out.EffectiveFingerprint = d.Digest(raw)
	return &out
}
