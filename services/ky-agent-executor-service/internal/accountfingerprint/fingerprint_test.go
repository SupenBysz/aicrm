package accountfingerprint

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
)

type vectorFixture struct {
	SchemaVersion int    `json:"schemaVersion"`
	Algorithm     string `json:"algorithm"`
	Vectors       []struct {
		Name   string `json:"name"`
		Type   string `json:"type"`
		Email  string `json:"email"`
		Digest string `json:"digest"`
	} `json:"vectors"`
}

func TestLockedCrossRuntimeVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/testdata/aicrm_account_fingerprint_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture vectorFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.SchemaVersion != 1 || fixture.Algorithm != "sha256(trim(type)+LF+lowercase(trim(email)))" {
		t.Fatal("account fingerprint fixture contract changed")
	}
	for _, vector := range fixture.Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			value, err := Calculate(vector.Type, vector.Email)
			if err != nil || value != vector.Digest {
				t.Fatalf("digest=%s err=%v", value, err)
			}
		})
	}
}

func TestInvalidOrAmbiguousIdentityFailsClosed(t *testing.T) {
	for _, input := range [][2]string{
		{"", "user@example.com"},
		{"chatgpt", ""},
		{"chatgpt\nother", "user@example.com"},
		{"chatgpt", "user@example.com\nother"},
	} {
		if _, err := Calculate(input[0], input[1]); !errors.Is(err, ErrInvalidAccountIdentity) {
			t.Fatalf("input=%q err=%v", input, err)
		}
	}
}
