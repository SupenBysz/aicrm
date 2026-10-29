// Package appearance defines the versioned, allowlisted appearance contract.
package appearance

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

var ErrValidation = errors.New("invalid appearance")

var ErrConflict = errors.New("appearance revision conflict")

type Value struct {
	SchemaVersion int    `json:"schemaVersion"`
	Source        string `json:"source"`
	ThemeID       string `json:"themeId"`
	Mode          string `json:"mode"`
	Revision      int64  `json:"revision"`
}

func Default() Value {
	return Value{SchemaVersion: 1, Source: "platform", ThemeID: "classic-gold", Mode: "system"}
}
func (v Value) Valid(personal bool) bool {
	if v.SchemaVersion != 1 || v.Revision < 0 || v.Revision >= 9007199254740991 {
		return false
	}
	if personal && v.Source == "platform" {
		return v.ThemeID == "" && v.Mode == ""
	}
	if personal && v.Source != "personal" {
		return false
	}
	if !personal && v.Source != "platform" {
		return false
	}
	return (v.ThemeID == "classic-gold" || v.ThemeID == "business-blue" || v.ThemeID == "jade-green" || v.ThemeID == "graphite-cyan") && (v.Mode == "light" || v.Mode == "dark" || v.Mode == "system")
}

func Decode(w http.ResponseWriter, r *http.Request, v *Value) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(v) != nil {
		return false
	}
	return decoder.Decode(new(any)) == io.EOF
}
