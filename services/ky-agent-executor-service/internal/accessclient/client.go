package accessclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var (
	ErrDenied      = errors.New("access denied")
	ErrUnavailable = errors.New("access decision unavailable")
)

type Request struct {
	ActorID                string   `json:"actorId"`
	SessionID              string   `json:"sessionId"`
	WorkspaceType          string   `json:"workspaceType"`
	WorkspaceID            string   `json:"workspaceId"`
	RequiredAllPermissions []string `json:"requiredAllPermissions"`
	RequiredAnyPermissions []string `json:"requiredAnyPermissions"`
}

type DataScope struct {
	ScopeType     string   `json:"scopeType"`
	DepartmentIDs []string `json:"departmentIds"`
	TeamIDs       []string `json:"teamIds"`
	AgencyIDs     []string `json:"agencyIds"`
	EnterpriseIDs []string `json:"enterpriseIds"`
}

type Decision struct {
	Allowed                    bool        `json:"allowed"`
	ReasonCode                 string      `json:"reasonCode"`
	ActorID                    string      `json:"actorId"`
	MembershipID               string      `json:"membershipId"`
	WorkspaceType              string      `json:"workspaceType"`
	WorkspaceID                string      `json:"workspaceId"`
	GrantedRequiredPermissions []string    `json:"grantedRequiredPermissions"`
	DataScopes                 []DataScope `json:"dataScopes"`
}

type Authorizer interface {
	Evaluate(context.Context, string, Request) (Decision, error)
}

type Client struct {
	endpoint string
	token    string
	http     *http.Client
}

func New(baseURL, token string) (*Client, error) {
	parsed, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseURL), "/"))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("invalid membership service URL")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && isLoopbackHost(parsed.Hostname())) {
		return nil, errors.New("membership service URL must be HTTPS or loopback HTTP")
	}
	if strings.TrimSpace(token) == "" {
		return nil, errors.New("membership internal token is required")
	}
	return &Client{
		endpoint: parsed.String() + "/internal/v1/access-decisions",
		token:    token,
		http: &http.Client{
			Timeout: 4 * time.Second,
			Transport: &http.Transport{
				Proxy:                 http.ProxyFromEnvironment,
				DialContext:           (&net.Dialer{Timeout: 2 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
				TLSHandshakeTimeout:   2 * time.Second,
				ResponseHeaderTimeout: 3 * time.Second,
				MaxIdleConnsPerHost:   8,
			},
		},
	}, nil
}

func (c *Client) Evaluate(ctx context.Context, requestID string, input Request) (Decision, error) {
	payload, err := json.Marshal(input)
	if err != nil {
		return Decision{}, ErrUnavailable
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(payload))
	if err != nil {
		return Decision{}, ErrUnavailable
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-KY-Internal-Token", c.token)
	request.Header.Set("X-KY-Request-Id", requestID)
	response, err := c.http.Do(request)
	if err != nil {
		return Decision{}, ErrUnavailable
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if err != nil {
		return Decision{}, ErrUnavailable
	}
	if response.StatusCode != http.StatusOK {
		if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
			return Decision{}, ErrDenied
		}
		return Decision{}, ErrUnavailable
	}
	var envelope struct {
		Data Decision `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return Decision{}, fmt.Errorf("%w: invalid decision envelope", ErrUnavailable)
	}
	decision := envelope.Data
	if decision.ActorID != input.ActorID || decision.WorkspaceType != input.WorkspaceType || decision.WorkspaceID != input.WorkspaceID {
		return Decision{}, ErrUnavailable
	}
	if !decision.Allowed {
		return decision, ErrDenied
	}
	return decision, nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
