package branding

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/png"
	"strings"
	"unicode/utf8"
)

type BrandAsset struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int    `json:"size"`
	Format string `json:"format"`
}
type Brand struct {
	WordmarkDark          BrandAsset `json:"wordmarkDark"`
	WordmarkDarkGenerated bool       `json:"wordmarkDarkGenerated,omitempty"`
	ShowAIIcon            bool       `json:"showAiIcon"`
	WordmarkGenerated     bool       `json:"wordmarkGenerated,omitempty"`
	IconGenerated         bool       `json:"iconGenerated,omitempty"`
	IconText              string     `json:"iconText,omitempty"`
	CopyrightHolder       string     `json:"copyrightHolder,omitempty"`
	CopyrightStyle        string     `json:"copyrightStyle,omitempty"`
	Source                string     `json:"source,omitempty"`
	EffectiveFingerprint  string     `json:"effectiveFingerprint,omitempty"`
	AgencyID              string     `json:"agencyId"`
	Version               int64      `json:"version"`
	Name                  string     `json:"name"`
	ApplicationName       string     `json:"applicationName"`
	Icon                  BrandAsset `json:"icon"`
	Wordmark              BrandAsset `json:"wordmark"`
}

func ValidName(s string, max int) bool {
	if strings.HasSuffix(s, ".") || strings.HasSuffix(s, " ") || strings.TrimSpace(s) == "" || !utf8.ValidString(s) || utf8.RuneCountInString(s) > max {
		return false
	}
	for _, r := range s {
		if r < 32 || r == '/' || r == '\\' || strings.ContainsRune(`<>:"|?*`, r) {
			return false
		}
	}
	return true
}
func NormalizePNG(raw []byte, icon bool) ([]byte, error) {
	if len(raw) > 4<<20 {
		return nil, errors.New("image too large")
	}
	c, err := png.DecodeConfig(bytes.NewReader(raw))
	if err != nil || c.Width < 1 || c.Height < 1 || c.Width > 4096 || c.Height > 4096 || c.Width*c.Height > 4<<20 {
		return nil, errors.New("invalid image")
	}
	im, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, errors.New("invalid PNG")
	}
	if icon {
		out := image.NewNRGBA(image.Rect(0, 0, 256, 256))
		for y := 0; y < 256; y++ {
			for x := 0; x < 256; x++ {
				out.Set(x, y, im.At(x*c.Width/256, y*c.Height/256))
			}
		}
		im = out
	}
	var b bytes.Buffer
	if err = png.Encode(&b, im); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}
func Digest(raw []byte) string { s := sha256.Sum256(raw); return hex.EncodeToString(s[:]) }
