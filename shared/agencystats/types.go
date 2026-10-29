package agencystats

import "errors"

const MaxGroups = 100
const MaxMappings = 5000
const ChunkSize = 1000

type Group struct {
	EnterpriseOnly bool     `json:"enterpriseOnly,omitempty"`
	ID             string   `json:"id"`
	Enterprises    []string `json:"enterprises"`
	Users          []string `json:"users,omitempty"`
	Employed       int64    `json:"employed"`
	Left           int64    `json:"left"`
	Total          int64    `json:"total"`
}
type Request struct {
	Groups []Group `json:"groups"`
}
type Users struct {
	Online   int64 `json:"online"`
	Employed int64 `json:"employed"`
	Left     int64 `json:"left"`
	Total    int64 `json:"total"`
}
type Stats struct {
	Users              Users `json:"users"`
	EnterpriseCount    int   `json:"enterpriseCount"`
	TerminalsSupported bool  `json:"terminalsSupported"`
}

func ValidIDs(ids []string, limit int) bool {
	if len(ids) == 0 || len(ids) > limit {
		return false
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if len(id) == 0 || len(id) > 200 || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}
func Validate(groups []Group) error {
	if len(groups) == 0 || len(groups) > MaxGroups {
		return errors.New("groups")
	}
	ids := []string{}
	n := 0
	for _, g := range groups {
		ids = append(ids, g.ID)
		n += len(g.Enterprises)
		if len(g.Enterprises) > 0 && !ValidIDs(g.Enterprises, MaxMappings) {
			return errors.New("enterprises")
		}
	}
	if n > MaxMappings || !ValidIDs(ids, MaxGroups) {
		return errors.New("budget")
	}
	return nil
}
