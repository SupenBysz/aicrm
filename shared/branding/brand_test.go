package branding

import (
	"bytes"
	"image"
	"image/png"
	"testing"
)

func TestPNGNormalizationAndLimits(t *testing.T) {
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewNRGBA(image.Rect(0, 0, 16, 8))); err != nil {
		t.Fatal(err)
	}
	raw, err := NormalizePNG(b.Bytes(), true)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width != 256 || cfg.Height != 256 {
		t.Fatal(cfg, err)
	}
	for _, invalid := range [][]byte{[]byte("not png"), make([]byte, (4<<20)+1)} {
		if _, err = NormalizePNG(invalid, false); err == nil {
			t.Fatal("invalid upload accepted")
		}
	}
}
