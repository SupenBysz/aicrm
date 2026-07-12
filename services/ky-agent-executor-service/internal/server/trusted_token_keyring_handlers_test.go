package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/config"
	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
)

type fakeTrustedTokenDatabaseClock struct {
	now   time.Time
	err   error
	calls int
}

func (f *fakeTrustedTokenDatabaseClock) TrustedTokenDatabaseNow(context.Context) (time.Time, error) {
	f.calls++
	return f.now, f.err
}

func TestPublicTrustedTokenKeyRingUsesDatabaseTimeAndSafeExactProjection(t *testing.T) {
	clock := &fakeTrustedTokenDatabaseClock{now: time.Date(2026, 7, 13, 8, 9, 10, 987000000, time.FixedZone("offset", 8*60*60))}
	projection := trustedTokenKeyRingProjectionFixture()
	server := &Server{
		cfg: config.Config{WriteEnabled: true}, trustedTokenClock: clock,
		trustedTokenKeyRing: &projection, trustedTokenSigningWindow: trustedTokenSigningWindowFixture(),
	}
	server.activationRecoveryHealthy.Store(true)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/public/ai-executor-trusted-token-keyring", nil)
	request.Header.Set("X-KY-Request-Id", "req_keyring_1")
	recorder := httptest.NewRecorder()
	server.buildMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || clock.calls != 1 {
		t.Fatalf("status=%d calls=%d body=%s", recorder.Code, clock.calls, recorder.Body.String())
	}
	if recorder.Header().Get("Cache-Control") != "no-store" || recorder.Header().Get("Pragma") != "no-cache" ||
		recorder.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("unsafe response headers: %#v", recorder.Header())
	}
	var envelope struct {
		Data      publicTrustedTokenKeyRing `json:"data"`
		RequestID string                    `json:"requestId"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.RequestID != "req_keyring_1" || envelope.Data.GeneratedAt != "2026-07-13T00:09:10Z" ||
		envelope.Data.RefreshAfterSeconds != 30 || envelope.Data.SchemaVersion != 1 ||
		envelope.Data.Issuer != trustedtoken.Issuer || envelope.Data.Revision != 7 ||
		envelope.Data.ActiveKeyID != "active_key_1" || envelope.Data.MaximumLifetimeSeconds != 600 ||
		envelope.Data.KeyRingDigest != strings.Repeat("a", 64) || len(envelope.Data.Keys) != 1 {
		t.Fatalf("unexpected keyring envelope: %#v", envelope)
	}
	serialized := recorder.Body.String()
	for _, forbidden := range []string{"privateKey", "nonceSecret", "internalToken", "credentialRoot"} {
		if strings.Contains(serialized, forbidden) {
			t.Fatalf("public keyring leaked %s: %s", forbidden, serialized)
		}
	}
}

func TestPublicTrustedTokenKeyRingRejectsAmbientAuthorityAndQuery(t *testing.T) {
	projection := trustedTokenKeyRingProjectionFixture()
	tests := []struct {
		name   string
		target string
		header string
		value  string
	}{
		{"query", "/api/v1/public/ai-executor-trusted-token-keyring?revision=7", "", ""},
		{"empty query", "/api/v1/public/ai-executor-trusted-token-keyring?", "", ""},
		{"authorization", "/api/v1/public/ai-executor-trusted-token-keyring", "Authorization", "Bearer secret"},
		{"workspace type", "/api/v1/public/ai-executor-trusted-token-keyring", "X-KY-Workspace-Type", "platform"},
		{"workspace id", "/api/v1/public/ai-executor-trusted-token-keyring", "X-KY-Workspace-Id", "platform_root"},
		{"cookie", "/api/v1/public/ai-executor-trusted-token-keyring", "Cookie", "session=secret"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			clock := &fakeTrustedTokenDatabaseClock{now: time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)}
			server := &Server{
				cfg: config.Config{WriteEnabled: true}, trustedTokenClock: clock,
				trustedTokenKeyRing: &projection, trustedTokenSigningWindow: trustedTokenSigningWindowFixture(),
			}
			request := httptest.NewRequest(http.MethodGet, testCase.target, nil)
			if testCase.header != "" {
				request.Header.Set(testCase.header, testCase.value)
			}
			recorder := httptest.NewRecorder()
			server.buildMux().ServeHTTP(recorder, request)
			if recorder.Code != http.StatusBadRequest || clock.calls != 0 ||
				recorder.Header().Get("Cache-Control") != "no-store" ||
				recorder.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatalf("status=%d calls=%d headers=%#v body=%s", recorder.Code, clock.calls, recorder.Header(), recorder.Body.String())
			}
		})
	}
}

func TestPublicTrustedTokenKeyRingNonGETFailsWithSafeHeaders(t *testing.T) {
	projection := trustedTokenKeyRingProjectionFixture()
	for _, method := range []string{http.MethodPost, http.MethodHead, http.MethodPut, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			clock := &fakeTrustedTokenDatabaseClock{now: time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)}
			server := &Server{
				cfg: config.Config{WriteEnabled: true}, trustedTokenClock: clock,
				trustedTokenKeyRing: &projection, trustedTokenSigningWindow: trustedTokenSigningWindowFixture(),
			}
			request := httptest.NewRequest(method, "/api/v1/public/ai-executor-trusted-token-keyring", nil)
			recorder := httptest.NewRecorder()
			server.buildMux().ServeHTTP(recorder, request)
			if recorder.Code != http.StatusMethodNotAllowed || recorder.Header().Get("Allow") != http.MethodGet ||
				recorder.Header().Get("Cache-Control") != "no-store" ||
				recorder.Header().Get("X-Content-Type-Options") != "nosniff" || clock.calls != 0 {
				t.Fatalf("status=%d calls=%d headers=%#v body=%s", recorder.Code, clock.calls, recorder.Header(), recorder.Body.String())
			}
		})
	}
}

func TestPublicTrustedTokenKeyRingFailsClosedWhenNotReady(t *testing.T) {
	projection := trustedTokenKeyRingProjectionFixture()
	tests := []*Server{
		{cfg: config.Config{WriteEnabled: false}, trustedTokenClock: &fakeTrustedTokenDatabaseClock{}, trustedTokenKeyRing: &projection, trustedTokenSigningWindow: trustedTokenSigningWindowFixture()},
		{cfg: config.Config{WriteEnabled: true}, trustedTokenKeyRing: &projection, trustedTokenSigningWindow: trustedTokenSigningWindowFixture()},
		{cfg: config.Config{WriteEnabled: true}, trustedTokenClock: &fakeTrustedTokenDatabaseClock{}, trustedTokenSigningWindow: trustedTokenSigningWindowFixture()},
		{cfg: config.Config{WriteEnabled: true}, trustedTokenClock: &fakeTrustedTokenDatabaseClock{err: errors.New("database unavailable")}, trustedTokenKeyRing: &projection, trustedTokenSigningWindow: trustedTokenSigningWindowFixture()},
		{cfg: config.Config{WriteEnabled: true}, trustedTokenClock: &fakeTrustedTokenDatabaseClock{}, trustedTokenKeyRing: &projection},
		{cfg: config.Config{WriteEnabled: true}, trustedTokenClock: &fakeTrustedTokenDatabaseClock{}, trustedTokenKeyRing: &projection, trustedTokenSigningWindow: trustedTokenSigningWindowFixture()},
	}
	for index := range tests {
		if index != len(tests)-1 {
			tests[index].activationRecoveryHealthy.Store(true)
		}
		request := httptest.NewRequest(http.MethodGet, "/api/v1/public/ai-executor-trusted-token-keyring", nil)
		recorder := httptest.NewRecorder()
		tests[index].buildMux().ServeHTTP(recorder, request)
		if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), "trusted_token_keyring_unavailable") {
			t.Fatalf("case %d status=%d body=%s", index, recorder.Code, recorder.Body.String())
		}
	}
}

func TestStartupSigningWindowUsesWriterDatabaseTimeAndHalfOpenBoundary(t *testing.T) {
	start := time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	verifyUntil := end.Add(trustedtoken.MaximumLifetime)
	window, err := trustedtoken.NewKeyWindow(start, &end, &verifyUntil)
	if err != nil {
		t.Fatal(err)
	}
	for _, testCase := range []struct {
		name     string
		now      time.Time
		clockErr error
		valid    bool
	}{
		{"before", start.Add(-time.Second), nil, false},
		{"at start", start, nil, true},
		{"before end", end.Add(-time.Second), nil, true},
		{"at end", end, nil, false},
		{"clock unavailable", start, errors.New("database unavailable"), false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			clock := &fakeTrustedTokenDatabaseClock{now: testCase.now, err: testCase.clockErr}
			err := validateTrustedTokenSigningWindow(context.Background(), clock, window)
			if (err == nil) != testCase.valid || clock.calls != 1 {
				t.Fatalf("err=%v valid=%v calls=%d", err, testCase.valid, clock.calls)
			}
		})
	}
}

func trustedTokenKeyRingProjectionFixture() trustedtoken.PublicKeyRingProjection {
	return trustedtoken.PublicKeyRingProjection{
		SchemaVersion: 1, Issuer: trustedtoken.Issuer, Revision: 7, ActiveKeyID: "active_key_1",
		MaximumLifetimeSeconds: 600,
		DesktopAudiences: []string{
			trustedtoken.AudienceDesktop, trustedtoken.AudienceClaim,
			trustedtoken.AudienceActivation, trustedtoken.AudienceCommand,
		},
		KeyRingDigest: strings.Repeat("a", 64),
		Keys: []trustedtoken.PublicVerificationKeyProjection{{
			KeyID: "active_key_1", KeyType: "OKP", Curve: "Ed25519", Algorithm: "EdDSA", Use: "sig",
			PublicKey: strings.Repeat("A", 43), SigningNotBefore: "2026-07-13T00:00:00Z",
		}},
	}
}

func trustedTokenSigningWindowFixture() *trustedtoken.KeyWindow {
	window, _ := trustedtoken.NewKeyWindow(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), nil, nil)
	return &window
}

func installTrustedTokenTestReadiness(server *Server) {
	projection := trustedTokenKeyRingProjectionFixture()
	server.trustedTokenClock = &fakeTrustedTokenDatabaseClock{
		now: time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC),
	}
	server.trustedTokenKeyRing = &projection
	server.trustedTokenSigningWindow = trustedTokenSigningWindowFixture()
}
