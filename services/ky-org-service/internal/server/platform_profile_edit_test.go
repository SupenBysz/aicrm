package server

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProfileEditRejectsMalformedBeforeStore(t *testing.T) {
	for _, tc := range []struct {
		body   string
		status int
	}{
		{`{"fields":{}}`, 428}, {`{"expectedRevision":"0","fields":{},"other":1}`, 400},
		{`{"expectedRevision":"0","fields":{}} {}`, 400}, {`null`, 428},
	} {
		r := httptest.NewRequest("PATCH", "/", strings.NewReader(tc.body))
		w := httptest.NewRecorder()
		(&Server{}).editPlatformProfile(w, r, wsContext{})
		if w.Code != tc.status {
			t.Fatalf("%s: %d", tc.body, w.Code)
		}
	}
}
