package domainentry

import (
	"strings"
	"testing"
	"time"
)

func TestProbeProofScopeAndExpiry(t *testing.T) {
	secret := strings.Repeat("s", 32)
	now := time.Unix(1000, 0)
	proof := ProbeProof(secret, "work.example.com", now)
	if !ValidProbeProof(proof, secret, "work.example.com", now) || ValidProbeProof(proof, secret, "other.example.com", now) || ValidProbeProof(proof, secret, "work.example.com", now.Add(61*time.Second)) || ValidProbeProof(secret, secret, "work.example.com", now) {
		t.Fatal("invalid probe proof policy")
	}
}
