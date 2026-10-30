package listoverview

import (
	"net/url"
	"strings"
	"testing"
)

func TestValidate(t *testing.T) {
	spec := map[string][]string{"keyword": nil, "status": {"normal", "disabled"}}
	for _, raw := range []string{"page=1", "sort=x", "status=unsafe", "status=normal&status=disabled", "unknown=x"} {
		q, _ := url.ParseQuery(raw)
		if Validate(q, spec) == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	q, _ := url.ParseQuery("keyword=example&status=disabled")
	if Validate(q, spec) != nil {
		t.Fatal("valid query rejected")
	}
	if Validate(url.Values{"keyword": {strings.Repeat("机构", 100)}}, spec) != nil {
		t.Fatal("bounded Chinese keyword rejected")
	}
	var r Result
	r.SetScope(q, "status")
	if r.Scope.Filters["keyword"] != "example" || len(r.Scope.Filters) != 1 || r.Scope.IgnoredFilters[0] != "status" {
		t.Fatal(r.Scope)
	}
}
