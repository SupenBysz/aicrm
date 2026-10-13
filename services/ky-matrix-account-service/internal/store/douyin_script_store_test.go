package store

import (
	"errors"
	"testing"
)

func TestDouyinScriptInputValidation(t *testing.T) {
	in, err := normalizeDouyinScriptInput(DouyinScriptInput{Identifier: "script-main", Name: "脚本", MatchType: "wildcard", MatchURL: "HTTPS://SHOP.EXAMPLE.COM:443/product/*"})
	if err != nil || in.MatchURL != "https://shop.example.com/product/*" {
		t.Fatalf("valid script rejected: %v", err)
	}
	literal, err := normalizeDouyinScriptInput(DouyinScriptInput{Identifier: "login", Name: "登录", MatchType: "wildcard", MatchURL: "https://fxg.jinritemai.com/login/common?channel=zhaoshang"})
	if err != nil || literal.MatchURL != "https://fxg.jinritemai.com/login/common?channel=zhaoshang" {
		t.Fatalf("valid wildcard literal rejected: %v", err)
	}
	for _, in := range []DouyinScriptInput{
		{Identifier: "empty-name", Name: "", MatchType: "exact", MatchURL: "https://example.com"},
		{Identifier: "x", Name: "x", MatchType: "regex", MatchURL: "https://example.com"},
		{Identifier: "x", Name: "x", MatchType: "exact", MatchURL: ""},
	} {
		if _, err := normalizeDouyinScriptInput(in); !errors.Is(err, ErrValidation) {
			t.Fatalf("invalid script accepted: %+v", in)
		}
	}
}

func TestDouyinScriptVersionValidationAndHash(t *testing.T) {
	in := DouyinScriptVersionInput{Version: "1.2.3", JSContent: "console.log('safe')"}
	if _, err := normalizeDouyinVersionInput(in); err != nil {
		t.Fatalf("valid version rejected: %v", err)
	}
	if len(scriptHash(in)) != 64 {
		t.Fatalf("unexpected content hash length")
	}
	for _, bad := range []DouyinScriptVersionInput{{Version: "1.2", JSContent: "x"}, {Version: "1.2.3", JSContent: ""}} {
		if _, err := normalizeDouyinVersionInput(bad); err != ErrValidation {
			t.Fatalf("invalid version accepted: %+v", bad)
		}
	}
}

func TestDouyinScriptIdentifierValidation(t *testing.T) {
	valid := []string{"main", "script_1", "v1.2-rc"}
	for _, identifier := range valid {
		if _, err := normalizeDouyinScriptInput(DouyinScriptInput{Identifier: identifier, Name: "脚本", MatchType: "exact", MatchURL: "https://example.com"}); err != nil {
			t.Fatalf("valid identifier %q rejected: %v", identifier, err)
		}
	}
	for _, identifier := range []string{"", "  ", "-starts", "has space", "中文"} {
		if _, err := normalizeDouyinScriptInput(DouyinScriptInput{Identifier: identifier, Name: "脚本", MatchType: "exact", MatchURL: "https://example.com"}); !errors.Is(err, ErrValidation) {
			t.Fatalf("invalid identifier %q accepted: %v", identifier, err)
		}
	}
}
