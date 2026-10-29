package appearance

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestContract(t *testing.T) {
	for _, theme := range []string{"classic-gold", "business-blue", "jade-green"} {
		for _, mode := range []string{"light", "dark", "system"} {
			v := Default()
			v.ThemeID = theme
			v.Mode = mode
			if !v.Valid(false) {
				t.Fatalf("rejected preset %s/%s", theme, mode)
			}
			v.Source = "personal"
			if !v.Valid(true) {
				t.Fatal("rejected personal")
			}
		}
	}
	follow := Value{SchemaVersion: 1, Source: "platform"}
	if !follow.Valid(true) {
		t.Fatal("follow platform rejected")
	}
	for _, v := range []Value{{SchemaVersion: 1, Source: "platform", ThemeID: "custom", Mode: "light"}, {SchemaVersion: 2, Source: "platform", ThemeID: "classic-gold", Mode: "light"}, {SchemaVersion: 1, Source: "platform", ThemeID: "classic-gold", Mode: "invalid"}, {SchemaVersion: 1, Source: "personal", ThemeID: "classic-gold", Mode: "light", Revision: -1}} {
		if v.Valid(false) || v.Valid(true) {
			t.Fatalf("accepted invalid value %+v", v)
		}
	}
	if Default().Valid(true) {
		t.Fatal("platform payload must not be interpreted as personal inheritance")
	}
}

func TestBoundedStrictJSON(t *testing.T) {
	good := `{"schemaVersion":1,"source":"personal","themeId":"business-blue","mode":"dark","revision":0}`
	for _, body := range []string{good + ` {}`, `{"userId":"another"}`, good + strings.Repeat(" ", 5000), `null`} {
		var v Value
		decoded := Decode(httptest.NewRecorder(), httptest.NewRequest("PUT", "/", strings.NewReader(body)), &v)
		if decoded && v.Valid(true) {
			t.Fatalf("accepted invalid body: %.80s", body)
		}
	}
	var v Value
	if !Decode(httptest.NewRecorder(), httptest.NewRequest("PUT", "/", strings.NewReader(good)), &v) || !v.Valid(true) {
		t.Fatal("valid body rejected")
	}
}
