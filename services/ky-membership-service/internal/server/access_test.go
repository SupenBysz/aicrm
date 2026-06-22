package server

import "testing"

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
