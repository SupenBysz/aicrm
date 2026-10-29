package domains

import (
	"errors"
	"golang.org/x/net/idna"
	"golang.org/x/net/publicsuffix"
	"net"
	"net/url"
	"strings"
	"time"
)

var ErrThrottled = errors.New("domain check throttled")
var ErrInvalid = errors.New("domain invalid")
var ErrReserved = errors.New("reserved platform domain")
var ErrConflict = errors.New("domain conflict")
var ErrNotFound = errors.New("domain not found")

type Binding struct {
	ID          string         `json:"id"`
	AgencyID    string         `json:"agencyId"`
	Hostname    string         `json:"hostname"`
	Mode        string         `json:"mode"`
	State       string         `json:"state"`
	Revision    int64          `json:"revision"`
	Generation  int64          `json:"generation"`
	Challenge   string         `json:"challenge"`
	ExpiresAt   time.Time      `json:"expiresAt"`
	ProviderID  string         `json:"-"`
	Observation map[string]any `json:"observation"`
	ActorID     string         `json:"-"`
	WorkspaceID string         `json:"-"`
	Tasks       []Task         `json:"tasks"`
}
type Task struct {
	ID         string    `json:"id"`
	BindingID  string    `json:"bindingId"`
	Generation int64     `json:"generation"`
	Phase      string    `json:"phase"`
	State      string    `json:"state"`
	Token      string    `json:"-"`
	Attempts   int       `json:"attempts"`
	Message    string    `json:"message"`
	NextAt     time.Time `json:"nextAt"`
}

func Normalize(raw string, reserved, reservedHosts []string) (string, error) {
	raw = strings.TrimSpace(raw)
	if strings.Contains(raw, "://") {
		u, e := url.Parse(raw)
		if e != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Hostname() == "" {
			return "", ErrInvalid
		}
		raw = u.Hostname()
	}
	h, e := idna.Lookup.ToASCII(strings.ToLower(strings.TrimSuffix(raw, ".")))
	if e != nil || len(h) > 253 || net.ParseIP(h) != nil || strings.ContainsAny(h, "/:@* \t\r\n") {
		return "", ErrInvalid
	}
	root, e := publicsuffix.EffectiveTLDPlusOne(h)
	if e != nil || h == root || strings.Count(h, ".") != strings.Count(root, ".")+1 {
		return "", ErrInvalid
	}
	suffix, icann := publicsuffix.PublicSuffix(h)
	if !icann || suffix == "" {
		return "", ErrInvalid
	}
	for _, label := range strings.Split(h, ".") {
		if len(label) == 0 || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return "", ErrInvalid
		}
		for _, c := range label {
			if c != '-' && (c < 'a' || c > 'z') && (c < '0' || c > '9') {
				return "", ErrInvalid
			}
		}
	}
	for _, r := range reservedHosts {
		if h == strings.ToLower(strings.TrimSuffix(strings.TrimSpace(r), ".")) {
			return "", ErrReserved
		}
	}
	for _, r := range reserved {
		if r = strings.TrimSpace(r); r != "" && (h == r || strings.HasSuffix(h, "."+r)) {
			return "", ErrReserved
		}
	}
	return h, nil
}
