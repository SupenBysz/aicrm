package server

import (
	"net/http/httptest"
	"testing"
)

func TestRolePermissionsRequireMatchingBodyAndHeaderRevision(t *testing.T) {
	for _, tc := range []struct {
		name, header string
		body         int64
		want         bool
	}{
		{name: "matching revision", header: "7", body: 7, want: true},
		{name: "missing header", body: 7},
		{name: "missing body", header: "7"},
		{name: "mismatch", header: "8", body: 7},
		{name: "invalid header", header: "x", body: 7},
		{name: "zero", header: "0", body: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/v1/roles/r1/permissions", nil)
			if tc.header != "" {
				req.Header.Set("X-KY-Expected-Revision", tc.header)
			}
			_, ok := rolePermissionsRevision(req, rolePermissionsInput{ExpectedRevision: tc.body})
			if ok != tc.want {
				t.Fatalf("revision validity=%v, want %v", ok, tc.want)
			}
		})
	}
}

func TestValidateDataScope(t *testing.T) {
	cases := []struct {
		name string
		in   *dataScopeInput
		ok   bool
	}{
		{"nil ok", nil, true},
		{"all ok", &dataScopeInput{ScopeType: "all"}, true},
		{"bad type", &dataScopeInput{ScopeType: "bogus"}, false},
		{"specified_agency missing ids", &dataScopeInput{ScopeType: "specified_agency"}, false},
		{"specified_agency ok", &dataScopeInput{ScopeType: "specified_agency", AgencyIDs: []string{"a1"}}, true},
		{"specified_enterprise missing", &dataScopeInput{ScopeType: "specified_enterprise"}, false},
		{"specified_department missing", &dataScopeInput{ScopeType: "specified_department"}, false},
		{"specified_team missing", &dataScopeInput{ScopeType: "specified_team"}, false},
		{"specified_team ok", &dataScopeInput{ScopeType: "specified_team", TeamIDs: []string{"t1"}}, true},
		{"custom empty", &dataScopeInput{ScopeType: "custom"}, false},
		{"custom ok", &dataScopeInput{ScopeType: "custom", DepartmentIDs: []string{"d1"}}, true},
		{"department_tree ok no ids", &dataScopeInput{ScopeType: "department_tree"}, true},
		{"self ok", &dataScopeInput{ScopeType: "self"}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, ok, _ := validateDataScope(c.in)
			if ok != c.ok {
				t.Errorf("validateDataScope ok=%v want %v", ok, c.ok)
			}
		})
	}
}

func TestDataScopeDefinitionsFor(t *testing.T) {
	if len(dataScopeDefinitionsFor("platform")) == 0 {
		t.Error("platform should have scope definitions")
	}
	if len(dataScopeDefinitionsFor("agency")) == 0 {
		t.Error("agency should have scope definitions")
	}
	if len(dataScopeDefinitionsFor("enterprise")) == 0 {
		t.Error("enterprise should have scope definitions")
	}
	if len(dataScopeDefinitionsFor("bogus")) != 0 {
		t.Error("unknown workspace should have no scope definitions")
	}
	// platform must not expose department/team scopes
	for _, d := range dataScopeDefinitionsFor("platform") {
		if d.ScopeType == "department" || d.ScopeType == "team" {
			t.Errorf("platform must not expose %s", d.ScopeType)
		}
	}
}
