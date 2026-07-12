package server

import (
	"net/http"
	"time"

	"github.com/Kysion/KyaiCRM/services/ky-agent-executor-service/internal/trustedtoken"
)

const trustedTokenKeyRingRefreshAfterSeconds = 30

type publicTrustedTokenKeyRing struct {
	SchemaVersion          int                                            `json:"schemaVersion"`
	Issuer                 string                                         `json:"issuer"`
	Revision               int64                                          `json:"revision"`
	ActiveKeyID            string                                         `json:"activeKid"`
	GeneratedAt            string                                         `json:"generatedAt"`
	RefreshAfterSeconds    int                                            `json:"refreshAfterSeconds"`
	MaximumLifetimeSeconds int64                                          `json:"maxTokenLifetimeSeconds"`
	DesktopAudiences       []string                                       `json:"desktopAudiences"`
	KeyRingDigest          string                                         `json:"keyringDigest"`
	Keys                   []trustedtoken.PublicVerificationKeyProjection `json:"keys"`
}

func (s *Server) getPublicTrustedTokenKeyRing(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	ensureRequestID(r)
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "only GET is accepted")
		return
	}
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		writeError(w, r, http.StatusBadRequest, "trusted_token_keyring_query_forbidden", "trusted-token keyring does not accept query parameters")
		return
	}
	for _, name := range []string{"Authorization", "X-KY-Workspace-Type", "X-KY-Workspace-Id", "Cookie"} {
		if len(r.Header.Values(name)) > 0 {
			writeError(w, r, http.StatusBadRequest, "trusted_token_keyring_header_forbidden", "credentials and workspace headers are forbidden")
			return
		}
	}
	if r.ContentLength > 0 || len(r.TransferEncoding) > 0 {
		writeError(w, r, http.StatusBadRequest, "trusted_token_keyring_body_forbidden", "trusted-token keyring does not accept a request body")
		return
	}
	if !s.cfg.WriteEnabled || !s.activationRecoveryHealthy.Load() ||
		s.trustedTokenClock == nil || s.trustedTokenKeyRing == nil || s.trustedTokenSigningWindow == nil {
		writeError(w, r, http.StatusServiceUnavailable, "trusted_token_keyring_unavailable", "trusted-token keyring is unavailable")
		return
	}
	databaseNow, err := s.trustedTokenClock.TrustedTokenDatabaseNow(r.Context())
	if err != nil || databaseNow.IsZero() || !s.trustedTokenSigningWindow.AllowsIssuedAt(databaseNow) {
		writeError(w, r, http.StatusServiceUnavailable, "trusted_token_keyring_unavailable", "trusted-token database clock is unavailable")
		return
	}
	projection := s.trustedTokenKeyRing
	writeData(w, r, http.StatusOK, publicTrustedTokenKeyRing{
		SchemaVersion: projection.SchemaVersion, Issuer: projection.Issuer,
		Revision: projection.Revision, ActiveKeyID: projection.ActiveKeyID,
		GeneratedAt:            databaseNow.UTC().Truncate(time.Second).Format(time.RFC3339),
		RefreshAfterSeconds:    trustedTokenKeyRingRefreshAfterSeconds,
		MaximumLifetimeSeconds: projection.MaximumLifetimeSeconds,
		DesktopAudiences:       append([]string(nil), projection.DesktopAudiences...),
		KeyRingDigest:          projection.KeyRingDigest,
		Keys:                   append([]trustedtoken.PublicVerificationKeyProjection(nil), projection.Keys...),
	})
}
